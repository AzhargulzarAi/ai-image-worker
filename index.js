const http = require('http');
const { URL } = require('url');
const sharp = require('sharp');

const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
const WP_SITE_URL     = process.env.WP_SITE_URL;
const WP_USERNAME     = process.env.WP_USERNAME;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD;
const WORKER_SECRET   = process.env.WORKER_SECRET || 'changeme';

const wpAuthHeader = 'Basic ' + Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString('base64');

function requireEnv() {
  const missing = [];
  if (!OPENAI_API_KEY) missing.push('OPENAI_API_KEY');
  if (!WP_SITE_URL) missing.push('WP_SITE_URL');
  if (!WP_USERNAME) missing.push('WP_USERNAME');
  if (!WP_APP_PASSWORD) missing.push('WP_APP_PASSWORD');
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
}

async function callOpenAIImage(prompt) {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt,
      size: '1536x1024'
    })
  });

  if (!res.ok) {
    throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const first = data && data.data && data.data[0];
  if (!first) throw new Error('OpenAI response missing image data');

  if (first.b64_json) {
    return Buffer.from(first.b64_json, 'base64');
  }

  if (first.url) {
    const imgRes = await fetch(first.url);
    if (!imgRes.ok) throw new Error(`Failed to download generated image: ${imgRes.status}`);
    return Buffer.from(await imgRes.arrayBuffer());
  }

  throw new Error('OpenAI response contained neither b64_json nor url');
}

async function optimiseForWeb(buffer) {
  return sharp(buffer)
    .rotate()
    .resize({
      width: 1280,
      height: 720,
      fit: 'cover',
      position: 'centre',
      withoutEnlargement: true
    })
    .webp({ quality: 78, effort: 5 })
    .toBuffer();
}

async function wpApiJson(method, endpoint, body = null) {
  const url = WP_SITE_URL.replace(/\/+$/, '') + endpoint;
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': wpAuthHeader,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : null
  });

  const txt = await res.text();
  if (!res.ok) throw new Error(`WP API ${method} ${endpoint} ${res.status}: ${txt}`);
  return txt ? JSON.parse(txt) : {};
}

async function getLatestPost() {
  const posts = await wpApiJson('GET', '/wp-json/wp/v2/posts?per_page=1&orderby=date&order=desc');
  if (!Array.isArray(posts) || !posts.length) throw new Error('No posts found');
  return posts[0];
}

async function getContentItem(postType, id) {
  const endpoint = postType === 'post' ? 'posts' : 'pages';
  return wpApiJson('GET', `/wp-json/wp/v2/${endpoint}/${id}?context=edit`);
}

async function uploadImageToWP(buffer, filename, altText, title) {
  const url = WP_SITE_URL.replace(/\/+$/, '') + '/wp-json/wp/v2/media';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': wpAuthHeader,
      'Content-Type': 'image/webp',
      'Content-Disposition': `attachment; filename="${filename}"`
    },
    body: buffer
  });

  const txt = await res.text();
  if (!res.ok) throw new Error(`WP media error ${res.status}: ${txt}`);

  const media = JSON.parse(txt);
  if (!media.id) throw new Error('Media upload missing id');

  if (altText || title) {
    await wpApiJson('POST', `/wp-json/wp/v2/media/${media.id}`, {
      alt_text: altText || '',
      title: title || undefined
    });
  }

  return media;
}

async function setFeaturedImage(postType, id, mediaId) {
  const endpoint = postType === 'post' ? 'posts' : 'pages';
  return wpApiJson('POST', `/wp-json/wp/v2/${endpoint}/${id}`, { featured_media: mediaId });
}

function slugify(input) {
  return String(input || 'carcheckwise-page-image')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || 'carcheckwise-page-image';
}

async function runLatestPostWorker() {
  const post = await getLatestPost();
  const title = post.title && post.title.rendered ? post.title.rendered : 'CarCheckWise article';
  const prompt = `Photo-realistic editorial image for a UK automotive article titled "${title}". Modern UK vehicle setting, professional and trustworthy, no readable text, no logos, no watermarks.`;
  const raw = await callOpenAIImage(prompt);
  const webp = await optimiseForWeb(raw);
  const filename = `${slugify(title)}-${Date.now()}.webp`;
  const media = await uploadImageToWP(webp, filename, title, title);
  await setFeaturedImage('post', post.id, media.id);
  return { ok: true, mode: 'latest-post', postId: post.id, mediaId: media.id, sourceUrl: media.source_url, bytes: webp.length };
}

async function runTargetedPageImage(params) {
  const pageId = Number(params.pageId);
  if (!Number.isInteger(pageId) || pageId <= 0) throw new Error('A valid pageId is required');

  const postType = params.postType === 'post' ? 'post' : 'page';
  const item = await getContentItem(postType, pageId);
  const title = item.title && item.title.raw ? item.title.raw : (item.title && item.title.rendered ? item.title.rendered : `Page ${pageId}`);

  const prompt = params.prompt || `Photo-realistic editorial image for a UK automotive vehicle-history page titled "${title}". Professional, trustworthy, modern UK setting, no readable text, no logos, no watermarks.`;
  const altText = params.alt || `${title} - CarCheckWise vehicle history illustration`;
  const base = slugify(params.filename || title);
  const filename = `${base}.webp`;

  const raw = await callOpenAIImage(prompt);
  const webp = await optimiseForWeb(raw);
  const media = await uploadImageToWP(webp, filename, altText, title);

  if (params.featured === '1' || params.featured === 'true') {
    await setFeaturedImage(postType, pageId, media.id);
  }

  return {
    ok: true,
    mode: 'targeted-page',
    pageId,
    postType,
    mediaId: media.id,
    sourceUrl: media.source_url,
    filename,
    bytes: webp.length,
    width: 1280,
    height: 720,
    alt: altText
  };
}

const server = http.createServer(async (req, res) => {
  try {
    requireEnv();
    const urlObj = new URL(req.url, 'http://localhost');

    if (urlObj.pathname === '/health') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ ok: true, service: 'ai-image-worker', version: '1.1.0' }));
    }

    const secret = urlObj.searchParams.get('secret');
    if (secret !== WORKER_SECRET) {
      res.statusCode = 403;
      return res.end('Forbidden: bad secret');
    }

    let result;
    if (urlObj.pathname === '/run') {
      result = await runLatestPostWorker();
    } else if (urlObj.pathname === '/page-image') {
      result = await runTargetedPageImage({
        pageId: urlObj.searchParams.get('pageId'),
        postType: urlObj.searchParams.get('postType'),
        prompt: urlObj.searchParams.get('prompt'),
        filename: urlObj.searchParams.get('filename'),
        alt: urlObj.searchParams.get('alt'),
        featured: urlObj.searchParams.get('featured')
      });
    } else {
      res.setHeader('Content-Type', 'text/plain');
      return res.end('AI Image Worker running. Use /run or /page-image with authorised parameters.');
    }

    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(result));
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log('AI Worker listening on port', PORT));

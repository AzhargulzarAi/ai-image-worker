const http = require('http');
const { URL } = require('url');

// Environment Variables
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
const WP_SITE_URL     = process.env.WP_SITE_URL;
const WP_USERNAME     = process.env.WP_USERNAME;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD;
const WORKER_SECRET   = process.env.WORKER_SECRET || 'changeme';

// Basic auth header for WordPress
const wpAuthHeader = 'Basic ' + Buffer.from(`${WP_USERNAME}:${WP_APP_PASSWORD}`).toString('base64');

// ---- OpenAI Images (new API: URL-based, no response_format) ----
async function callOpenAIImage(prompt) {
  // 1) Ask OpenAI to generate an image
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt,
      size: '1024x1024'
      // IMPORTANT: no response_format here, new API returns a URL
    })
  });

  if (!res.ok) {
    throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  if (!data.data || !data.data[0] || !data.data[0].url) {
    throw new Error('OpenAI response missing image URL');
  }

  const imageUrl = data.data[0].url;

  // 2) Download the actual image from the URL
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) {
    throw new Error(`Failed to download image from OpenAI URL: ${imgRes.status}`);
  }

  const arrayBuffer = await imgRes.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ---- Generic WordPress JSON API helper ----
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
  if (!res.ok) {
    throw new Error(`WP API ${method} ${endpoint} ${res.status}: ${txt}`);
  }
  return JSON.parse(txt);
}

// ---- Get the latest WP post ----
async function getLatestPost() {
  const posts = await wpApiJson('GET', '/wp-json/wp/v2/posts?per_page=1&orderby=date&order=desc');
  if (!Array.isArray(posts) || posts.length === 0) {
    throw new Error('No posts found');
  }
  return posts[0];
}

// ---- Upload image to WP media ----
async function uploadImageToWP(buffer, filename) {
  const url = WP_SITE_URL.replace(/\/+$/, '') + '/wp-json/wp/v2/media';

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': wpAuthHeader,
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="${filename}"`
    },
    body: buffer
  });

  const txt = await res.text();
  if (!res.ok) {
    throw new Error(`WP media error ${res.status}: ${txt}`);
  }

  const data = JSON.parse(txt);
  if (!data.id) {
    throw new Error('Media upload missing id');
  }
  return data.id;
}

// ---- Set featured image on a post ----
async function setFeaturedImage(postId, mediaId) {
  return wpApiJson('POST', `/wp-json/wp/v2/posts/${postId}`, {
    featured_media: mediaId
  });
}

// ---- Main worker logic ----
async function runWorker() {
  console.log('Worker: loading latest post…');

  const post = await getLatestPost();
  const title = (post.title && post.title.rendered) ? post.title.rendered : '(no title)';
  const postId = post.id;

  console.log(`Post found: ${postId} - ${title}`);

  const prompt =
    `Photo-realistic daytime image for a blog post titled "${title}". ` +
    `Show a modern private hire (PHV) saloon (Toyota Prius, Skoda Octavia, Kia Ceed), ` +
    `right-hand drive, on a real Manchester UK street. No text, no people, no logos.`;

  console.log('Calling OpenAI Images…');
  const imageBuffer = await callOpenAIImage(prompt);

  const filename = `ai-taxi-${Date.now()}.png`;
  console.log(`Uploading ${filename} to WP…`);

  const mediaId = await uploadImageToWP(imageBuffer, filename);
  console.log(`Media uploaded: ${mediaId}. Setting featured image…`);

  await setFeaturedImage(postId, mediaId);
  console.log('Featured image set.');

  return { ok: true, postId, mediaId };
}

// ---- HTTP server for Render ----
const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, 'http://localhost');

    if (urlObj.pathname === '/run') {
      const secret = urlObj.searchParams.get('secret');
      if (secret !== WORKER_SECRET) {
        res.statusCode = 403;
        return res.end('Forbidden: bad secret');
      }

      const result = await runWorker();
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(result));
    }

    res.setHeader('Content-Type', 'text/plain');
    res.end('AI Image Worker running. Use /run?secret=YOUR_SECRET');
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.end(e.message);
  }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log('AI Worker listening on port', PORT);
});

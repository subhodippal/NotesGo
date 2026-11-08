// Tiny static file server for local development: `node server.js` → http://localhost:3000
// No dependencies. Serving over http://localhost (instead of file://) enables Google sign-in,
// the service worker (offline mode) and the "Install app" button.
// GitHub Pages ignores this file; it isn't needed for hosting.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }

  // Resolve inside ROOT only, and never serve dotfiles/folders (.git, .env, ...) or this server file.
  const filePath = path.normalize(path.join(ROOT, urlPath));
  const relative = path.relative(ROOT, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).some((p) => p.startsWith('.'))) {
    return send(res, 403, 'Forbidden');
  }
  if (relative === 'server.js') return send(res, 404, 'Not found');

  fs.stat(filePath, (err, stat) => {
    const target = !err && stat.isDirectory() ? path.join(filePath, 'index.html') : filePath;
    fs.readFile(target, (readErr, data) => {
      if (readErr) return send(res, 404, 'Not found');
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache', // always pick up your latest edits
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try: PORT=3001 node server.js`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`NotesGo running at http://localhost:${PORT}`);
  console.log('Press Ctrl+C to stop.');
});

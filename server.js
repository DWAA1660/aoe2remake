// Minimal zero-dependency static server for the game.
// Also exposes /api/assets so the client knows whether vendored (offline) assets exist.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const target = path.normalize(path.join(root, decoded));
  if (!target.startsWith(root)) return null;
  return target;
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/assets')) {
    const vendorDir = path.join(ROOT, 'vendor');
    let files = [];
    try {
      files = fs.readdirSync(vendorDir);
    } catch {
      /* no vendored assets yet */
    }
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    res.end(JSON.stringify({ vendored: files }));
    return;
  }

  let urlPath = req.url === '/' ? '/index.html' : req.url;
  let file = safeJoin(ROOT, urlPath);
  if (!file) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found: ' + urlPath);
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`\n  Age of Antiquity  ->  http://localhost:${PORT}\n`);
});

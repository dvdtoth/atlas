// Development/static preview only. No API routes or repository processing.
import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = await realpath(fileURLToPath(new URL('../dist/', import.meta.url)));
const flag = process.argv.indexOf('--port'),
  port = flag >= 0 ? Number(process.argv[flag + 1]) : 8766;
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.txt': 'text/plain',
};
const rules = await readFile(path.join(root, '_headers'), 'utf8');
const headers = Object.fromEntries(
  rules
    .split('\n')
    .filter((line) => line.startsWith('  '))
    .map((line) => {
      const index = line.indexOf(':');
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }),
);
http
  .createServer(async (req, res) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        res.end();
        return;
      }
      let requestPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (requestPath.endsWith('/')) requestPath += 'index.html';
      const file = await realpath(path.join(root, requestPath));
      if (!file.startsWith(root + path.sep) || (await stat(file)).isDirectory())
        throw Error('Not a public file');
      const bytes = await readFile(file);
      res.writeHead(200, {
        ...headers,
        'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Content-Length': bytes.length,
      });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  })
  .listen(port, '127.0.0.1', () => console.log(`Atlas static app: http://127.0.0.1:${port}/`));

import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname, sep } from 'node:path';

const directory = dirname(fileURLToPath(import.meta.url));
const upstream = new URL(process.env.UI_API_ORIGIN || 'http://127.0.0.1:3000');
if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password) throw new Error('UI_API_ORIGIN must be an HTTP(S) origin without credentials.');
const port = Number(process.env.UI_PORT || '5173');
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml' };
const publicFiles = new Set(['index.html', 'styles.css', 'app.js', 'client.js', 'money.mjs', 'preview.mjs', 'assets/mark.svg']);

export const server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname.startsWith('/api/v1/')) {
    // Customer API only. Never expose the admin routes through the UI proxy.
    if (!/^\/api\/v1\/(auth(?:\/|$)|users\/me$|wallet(?:\/|$)|stash(?:\/|$)|fx(?:\/|$)|transactions(?:\/|$)|health\/ready$)/.test(url.pathname)) {
      response.writeHead(404).end(); return;
    }
    const headers = { ...request.headers, host: upstream.host };
    // This local proxy is the single upstream hop. Discard client-supplied forwarding headers.
    delete headers['x-forwarded-for']; delete headers['x-forwarded-host']; delete headers['x-forwarded-proto'];
    headers['x-forwarded-for'] = request.socket.remoteAddress || '127.0.0.1';
    const transport = upstream.protocol === 'https:' ? https : http;
    const proxy = transport.request(new URL(url.pathname + url.search, upstream), { method: request.method, headers }, (result) => {
      response.writeHead(result.statusCode || 502, { ...result.headers, 'cache-control': 'no-store' });
      result.pipe(response);
    });
    proxy.setTimeout(20000, () => proxy.destroy(new Error('timeout')));
    proxy.on('error', () => { if (!response.headersSent) response.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 'UI_BACKEND_UNAVAILABLE', message: 'The wallet service is unavailable. Please try again.' })); else response.destroy(); });
    request.on('aborted', () => proxy.destroy());
    request.pipe(proxy); return;
  }
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
  let filename;
  try { filename = decodeURIComponent(url.pathname).replace(/^\/+/, ''); } catch { response.writeHead(400).end(); return; }
  if (!filename || !extname(filename)) filename = 'index.html'; // Client routes, including /funding/return.
  const target = resolve(directory, filename);
  if (!target.startsWith(directory + sep) || !publicFiles.has(filename)) { response.writeHead(404).end(); return; }
  try {
    const contents = await readFile(target);
    response.writeHead(200, { 'content-type': `${mime[extname(filename)] || 'application/octet-stream'}; charset=utf-8`, 'cache-control': 'no-cache' });
    response.end(request.method === 'HEAD' ? undefined : contents);
  } catch { response.writeHead(404).end(); }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(port, process.env.UI_HOST || '127.0.0.1', () => console.log(`KoboFX UI: http://localhost:${port}\nCustomer API proxy: ${upstream.origin}`));
}

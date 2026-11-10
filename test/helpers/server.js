// Local HTTP server for test pages. Binds to 127.0.0.1 on a random port.
// Pages are reachable as http://127.0.0.1:<port>/... and http://localhost:<port>/...,
// which the extension's hostKey treats as two different hosts.

import http from 'node:http';

export async function startServer() {
  const hits = new Map();

  const server = http.createServer((req, res) => {
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    const { pathname } = new URL(req.url, 'http://placeholder');
    if (pathname === '/favicon.ico') {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    const key = `${host}${pathname}`;
    hits.set(key, (hits.get(key) || 0) + 1);
    const title = `Page ${pathname}`;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title><link rel="icon" href="data:,"></head>
<body><h1 id="top">${host}${pathname}</h1><p>Stay Pinned test page.</p></body>
</html>`);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    /** Base URL on host 127.0.0.1. */
    h1: `http://127.0.0.1:${port}`,
    /** Base URL on host localhost (a different hostKey). */
    h2: `http://localhost:${port}`,
    /** Number of times a page was requested, keyed by host and path. */
    hits(url) {
      const u = new URL(url);
      return hits.get(`${u.hostname}${u.pathname}`) || 0;
    },
    resetHits() {
      hits.clear();
    },
    close() {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

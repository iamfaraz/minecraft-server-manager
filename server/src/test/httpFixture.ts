/** Local HTTP server for download tests. Not used by the app. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export function fixtureBytes(size: number): Buffer {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = i % 251;
  return b;
}

export interface Fixture {
  url: string;
  hits: Record<string, number>;
  /** Request headers by path, in arrival order. */
  requests: Record<string, http.IncomingHttpHeaders[]>;
  close(): Promise<void>;
}

function sendRange(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): void {
  const m = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || ''));
  if (m) {
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : body.length - 1;
    const part = body.subarray(start, end + 1);
    res.writeHead(206, { 'Content-Length': part.length, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${body.length}` });
    res.end(part);
    return;
  }
  res.writeHead(200, { 'Content-Length': body.length, 'Accept-Ranges': 'bytes' });
  res.end(body);
}

export async function startFixture(): Promise<Fixture> {
  const hits: Record<string, number> = {};
  const requests: Record<string, http.IncomingHttpHeaders[]> = {};
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((req, res) => {
    const p = (req.url || '/').split('?')[0];
    hits[p] = (hits[p] || 0) + 1;
    (requests[p] ||= []).push(req.headers);
    const seg = p.split('/').filter(Boolean);
    const n = (i: number) => Number(seg[i]);
    switch (seg[0]) {
      case 'ok':
        return sendRange(req, res, fixtureBytes(n(1)));
      case 'stall': {
        const body = fixtureBytes(n(1));
        res.writeHead(200, { 'Content-Length': body.length });
        res.write(body.subarray(0, Math.floor(body.length / 2)));
        return; // never ends
      }
      case 'flaky':
        if (hits[p] <= n(1)) {
          res.writeHead(500);
          return res.end();
        }
        return sendRange(req, res, fixtureBytes(n(2)));
      case 'drop': {
        const body = fixtureBytes(n(1));
        if (hits[p] === 1) {
          res.writeHead(200, { 'Content-Length': body.length, 'Accept-Ranges': 'bytes' });
          res.write(body.subarray(0, Math.floor(body.length / 2)), () => setTimeout(() => res.socket?.destroy(), 20));
          return;
        }
        return sendRange(req, res, body);
      }
      case 'status':
        res.writeHead(n(1));
        return res.end();
      case 'short': {
        const body = fixtureBytes(n(1));
        res.writeHead(200, { 'Content-Length': body.length });
        res.write(body.subarray(0, body.length - 10), () => res.socket?.destroy());
        return;
      }
      case 'slow': {
        const body = fixtureBytes(n(1));
        res.writeHead(200, { 'Content-Length': body.length });
        let off = 0;
        const t = setInterval(() => {
          if (res.destroyed) return clearInterval(t);
          res.write(body.subarray(off, off + 1024));
          off += 1024;
          if (off >= body.length) {
            clearInterval(t);
            res.end();
          }
        }, 50);
        res.on('close', () => clearInterval(t));
        return;
      }
      default:
        res.writeHead(404);
        res.end();
    }
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    requests,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

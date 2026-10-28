import net from 'node:net';
import dgram from 'node:dgram';
import type { PingResult } from './types.js';

function writeVarInt(n: number): Buffer {
  const bytes: number[] = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}
function readVarInt(buf: Buffer, offset: number): { value: number; size: number } | null {
  let value = 0, size = 0, b: number;
  do {
    if (offset + size >= buf.length) return null;
    b = buf[offset + size];
    value |= (b & 0x7f) << (7 * size);
    size++;
    if (size > 5) return null;
  } while (b & 0x80);
  return { value, size };
}
function packet(id: number, payload: Buffer): Buffer {
  const body = Buffer.concat([writeVarInt(id), payload]);
  return Buffer.concat([writeVarInt(body.length), body]);
}
function mcString(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([writeVarInt(b.length), b]);
}
function flattenChat(d: any): string {
  if (d == null) return '';
  if (typeof d === 'string') return d;
  let s = d.text || '';
  if (Array.isArray(d.extra)) s += d.extra.map(flattenChat).join('');
  return s;
}
const stripMc = (s: string) => s.replace(/§./g, '');

/** Server List Ping (modern protocol, status state). */
export function pingJava(host: string, port: number, timeoutMs = 3000): Promise<PingResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = new net.Socket();
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (r: PingResult) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(timeoutMs, () => finish({ ok: false }));
    sock.on('error', () => finish({ ok: false }));
    sock.connect(port, host, () => {
      const hs = Buffer.concat([
        writeVarInt(-1 >>> 0), // protocol version -1 (unknown) -- servers reply with their own
        mcString(host),
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        writeVarInt(1),
      ]);
      sock.write(Buffer.concat([packet(0x00, hs), packet(0x00, Buffer.alloc(0))]));
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const len = readVarInt(buf, 0);
      if (!len) return;
      if (buf.length < len.size + len.value) return;
      let off = len.size;
      const id = readVarInt(buf, off);
      if (!id) return finish({ ok: false });
      off += id.size;
      const sl = readVarInt(buf, off);
      if (!sl) return finish({ ok: false });
      off += sl.size;
      try {
        const json = JSON.parse(buf.subarray(off, off + sl.value).toString('utf8'));
        finish({
          ok: true,
          motd: stripMc(flattenChat(json.description)),
          version: json.version?.name,
          online: json.players?.online,
          max: json.players?.max,
          players: (json.players?.sample || []).map((p: any) => p.name),
          latencyMs: Date.now() - start,
        });
      } catch {
        finish({ ok: false });
      }
    });
  });
}

const MAGIC = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');

/**
 * NetherNet has no public status ping; its signaling listens on TCP at the server port, so a TCP connect
 * tells us the server is up and gives a latency figure (no MOTD/player count).
 */
export function probeNetherNet(host: string, port: number, timeoutMs = 2000): Promise<PingResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = new net.Socket();
    let done = false;
    const finish = (r: PingResult) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(timeoutMs, () => finish({ ok: false }));
    sock.on('error', () => finish({ ok: false }));
    sock.connect(port, host, () => finish({ ok: true, latencyMs: Date.now() - start }));
  });
}

/** RakNet Unconnected Ping (0x01) -> Unconnected Pong (0x1c). */
export function pingBedrock(host: string, port: number, timeoutMs = 3000): Promise<PingResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (r: PingResult) => {
      if (done) return;
      done = true;
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false }), timeoutMs);
    const req = Buffer.alloc(1 + 8 + 16 + 8);
    req[0] = 0x01;
    req.writeBigInt64BE(BigInt(Date.now()), 1);
    MAGIC.copy(req, 9);
    req.writeBigUInt64BE(BigInt('0x1234567812345678'), 25);
    sock.on('error', () => {
      clearTimeout(timer);
      finish({ ok: false });
    });
    sock.on('message', (msg) => {
      clearTimeout(timer);
      if (msg[0] !== 0x1c || msg.length < 35) return finish({ ok: false });
      const strLen = msg.readUInt16BE(33);
      const s = msg.subarray(35, 35 + strLen).toString('utf8');
      const f = s.split(';');
      finish({
        ok: true,
        motd: f[1],
        version: f[3],
        online: Number(f[4]),
        max: Number(f[5]),
        levelName: f[7],
        latencyMs: Date.now() - start,
      });
    });
    sock.send(req, port, host, (err) => {
      if (err) {
        clearTimeout(timer);
        finish({ ok: false });
      }
    });
  });
}

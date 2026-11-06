/**
 * Pictures for the inventory editor: item icons and player skins.
 *
 * Neither the Java server jar nor Bedrock Dedicated Server contains item textures, so icons are fetched on first
 * use from Mojang's public resource pack samples (github.com/Mojang/bedrock-samples) and kept in the data folder.
 * Skins come from Mojang's session server, or from GeyserMC's skin service for Bedrock accounts.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from '../config.js';
import { exists, fetchJson } from '../util.js';
import { resolveJavaUuid } from '../players.js';
import type { ServerInstance } from '../servers/instance.js';
import { ITEM_IDS, ITEM_TEXTURES } from './items.generated.js';

const SAMPLES = 'https://raw.githubusercontent.com/Mojang/bedrock-samples/main/resource_pack/textures';
const iconDir = path.join(config.dataDir, 'cache', 'icons');
const failed = new Map<string, number>(); // id -> when we last failed, so a dead network is not hammered

const titleCase = (id: string) => id.replace(/_/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** Everything the "give item" picker offers. */
export const itemCatalogue = () => ITEM_IDS.map((id) => ({ id: `minecraft:${id}`, name: titleCase(id), icon: id in ITEM_TEXTURES }));

/* ---- TGA -> PNG, for the handful of textures Mojang ships as TGA (leather armour and other tinted items) ---- */

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(CRC(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

/** Truecolour TGA (plain or run-length encoded, 24 or 32 bit) to PNG. */
export function tgaToPng(tga: Buffer): Buffer {
  const idLength = tga[0];
  const type = tga[2];
  const width = tga.readUInt16LE(12);
  const height = tga.readUInt16LE(14);
  const bytes = tga[16] / 8;
  const topDown = (tga[17] & 0x20) !== 0;
  if ((type !== 2 && type !== 10) || (bytes !== 3 && bytes !== 4)) throw new Error(`Unsupported TGA (type ${type}, ${tga[16]} bit)`);
  const rgba = Buffer.alloc(width * height * 4);
  let o = 18 + idLength;
  let pixel = 0;
  const put = (at: number) => {
    const row = Math.floor(pixel / width);
    const y = topDown ? row : height - 1 - row;
    const i = (y * width + (pixel % width)) * 4;
    rgba[i] = tga[at + 2];
    rgba[i + 1] = tga[at + 1];
    rgba[i + 2] = tga[at];
    rgba[i + 3] = bytes === 4 ? tga[at + 3] : 255;
    pixel++;
  };
  while (pixel < width * height) {
    if (type === 2) {
      put(o);
      o += bytes;
      continue;
    }
    const head = tga[o++];
    const run = (head & 0x7f) + 1;
    if (head & 0x80) {
      for (let k = 0; k < run; k++) put(o);
      o += bytes;
    } else {
      for (let k = 0; k < run; k++, o += bytes) put(o);
    }
  }
  return encodePng(width, height, rgba);
}

/** PNG bytes of an item's icon, or null when we have none. `id` is with or without the `minecraft:` prefix. */
export async function itemIcon(id: string): Promise<Buffer | null> {
  const key = id.replace(/^minecraft:/, '');
  const texture = ITEM_TEXTURES[key];
  if (!texture) return null;
  const file = path.join(iconDir, `${key}.png`);
  if (await exists(file)) return fsp.readFile(file);
  if (Date.now() - (failed.get(key) ?? 0) < 10 * 60_000) return null;
  try {
    const res = await fetch(`${SAMPLES}/${texture}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = Buffer.from(await res.arrayBuffer());
    const png = texture.endsWith('.tga') ? tgaToPng(raw) : raw;
    await fsp.mkdir(iconDir, { recursive: true });
    await fsp.writeFile(file, png);
    return png;
  } catch {
    failed.set(key, Date.now());
    return null;
  }
}

/* ---- skins ---- */

const skinCache = new Map<string, { url: string | null; at: number }>();

/** A Bedrock account's skin, if GeyserMC's skin service knows it (it does for accounts that have joined a Geyser server). */
async function geyserSkin(xuid: string): Promise<string | null> {
  const d = await fetchJson<{ texture_id?: string }>(`https://api.geysermc.org/v2/skin/${xuid}`, {}, 8000);
  return d.texture_id ? `https://textures.minecraft.net/texture/${d.texture_id}` : null;
}

async function mojangSkin(uuid: string): Promise<string | null> {
  const d = await fetchJson<{ properties?: { name: string; value: string }[] }>(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid.replace(/-/g, '')}`, {}, 8000);
  const textures = d.properties?.find((p) => p.name === 'textures')?.value;
  if (!textures) return null;
  const url: string | undefined = JSON.parse(Buffer.from(textures, 'base64').toString('utf8')).textures?.SKIN?.url;
  return url ? url.replace(/^http:/, 'https:') : null;
}

/** URL of the player's skin texture (a 64x64 image on Mojang's texture server), or null if it cannot be found. */
export async function playerSkin(inst: ServerInstance, player: string): Promise<string | null> {
  const key = `${inst.id}:${player.toLowerCase()}`;
  const hit = skinCache.get(key);
  if (hit && Date.now() - hit.at < 60 * 60_000) return hit.url;
  let url: string | null = null;
  try {
    if (inst.rec.edition === 'bedrock') {
      const xuid = inst.seen.get(player.toLowerCase())?.id;
      if (xuid && /^\d+$/.test(xuid)) url = await geyserSkin(xuid);
    } else {
      const uuid = await resolveJavaUuid(inst, player);
      // Cross-play players get an id made from their Xbox account number, in the last 16 hex digits.
      if (uuid.startsWith('00000000-0000-0000-')) url = await geyserSkin(BigInt(`0x${uuid.replace(/-/g, '').slice(16)}`).toString());
      else {
        url = await mojangSkin(uuid).catch(() => null);
        // On an offline-mode server the id is made up from the name; the real account of that name still has the skin.
        if (!url) {
          const real = await fetchJson<{ id?: string }>(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(player)}`, {}, 8000).catch(() => null);
          if (real?.id) url = await mojangSkin(real.id);
        }
      }
    }
  } catch {
    url = null;
  }
  skinCache.set(key, { url, at: Date.now() });
  return url;
}

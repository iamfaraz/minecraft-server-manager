import type { Edition } from './types.js';

export type ParsedEvent =
  | { kind: 'started' }
  | { kind: 'join'; name: string; id?: string; ip?: string }
  | { kind: 'leave'; name: string }
  | { kind: 'uuid'; name: string; uuid: string }
  | { kind: 'saved' }
  | { kind: 'bedrock-save-ready' }
  | { kind: 'bedrock-save-files'; files: { path: string; length: number }[] }
  | { kind: 'geyser-started' }
  | { kind: 'port-in-use' };

const JAVA = {
  started: /Done \([\d.,]+\s*s(?:ec)?\)!/,
  uuid: /UUID of player (\S+) is ([0-9a-fA-F-]{36})/,
  login: /\]:? (\S+)\[\/([0-9a-fA-F.:]+?)(?::\d+)?\] logged in with entity id/,
  joined: /\]:? (\S+) joined the game/,
  left: /\]:? (\S+) left the game/,
  lost: /\]:? (\S+) lost connection:/,
  saved: /Saved the game/,
  geyser: /Started Geyser on/,
  portInUse: /FAILED TO BIND TO PORT|Address already in use/i,
};

const BEDROCK = {
  started: /Server started\./,
  connected: /Player connected: (.+?), xuid: (\d*)/,
  disconnected: /Player disconnected: (.+?), xuid: (\d*)/,
  saveReady: /Data saved\. Files are now ready to be copied\./,
  portInUse: /Failed to bind|address in use|Network port occupied/i,
};

export function parseLine(edition: Edition, line: string): ParsedEvent | null {
  if (edition === 'java') {
    let m: RegExpExecArray | null;
    if (JAVA.started.test(line)) return { kind: 'started' };
    if ((m = JAVA.uuid.exec(line))) return { kind: 'uuid', name: m[1], uuid: m[2] };
    if ((m = JAVA.login.exec(line))) return { kind: 'join', name: m[1], ip: m[2] };
    if ((m = JAVA.joined.exec(line))) return { kind: 'join', name: m[1] };
    if ((m = JAVA.left.exec(line))) return { kind: 'leave', name: m[1] };
    if ((m = JAVA.lost.exec(line))) return { kind: 'leave', name: m[1] };
    if (JAVA.saved.test(line)) return { kind: 'saved' };
    if (JAVA.geyser.test(line)) return { kind: 'geyser-started' };
    if (JAVA.portInUse.test(line)) return { kind: 'port-in-use' };
    return null;
  }
  let m: RegExpExecArray | null;
  if (BEDROCK.started.test(line)) return { kind: 'started' };
  if ((m = BEDROCK.connected.exec(line))) return { kind: 'join', name: m[1].trim(), id: m[2] || undefined };
  if ((m = BEDROCK.disconnected.exec(line))) return { kind: 'leave', name: m[1].trim() };
  if (BEDROCK.saveReady.test(line)) return { kind: 'bedrock-save-ready' };
  if (BEDROCK.portInUse.test(line)) return { kind: 'port-in-use' };
  const files = parseBedrockFileList(line);
  if (files) return { kind: 'bedrock-save-files', files };
  return null;
}

/** "Bedrock level/db/000012.ldb:1234, Bedrock level/level.dat:2515" */
export function parseBedrockFileList(line: string): { path: string; length: number }[] | null {
  const s = line.replace(/^\[[^\]]*\]\s*/, '').trim();
  if (!s.includes(':')) return null;
  const parts = s.split(', ');
  const out: { path: string; length: number }[] = [];
  for (const p of parts) {
    const idx = p.lastIndexOf(':');
    if (idx <= 0) return null;
    const len = Number(p.slice(idx + 1));
    const file = p.slice(0, idx);
    if (!Number.isInteger(len) || !file || /\s{2,}/.test(file) || file.length > 300) return null;
    out.push({ path: file, length: len });
  }
  // sanity: at least one path looks like a world file
  if (!out.some((f) => /\.(dat|ldb|log|txt)$|\/(CURRENT|MANIFEST)/.test(f.path) || f.path.includes('/'))) return null;
  return out;
}

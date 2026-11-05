/**
 * Blockhost's own console lines, written in the same shape as the server's log lines around them so the console
 * reads as one aligned stream. Each carries an invisible leading mark; the UI strips it and paints the line blue.
 */
import type { ServerRecord } from './types.js';

/** Zero-width space: lets the UI tell Blockhost's lines from the server's without a visible tag. */
export const HOST_MARK = '\u200b';

export type LogStyle = 'bedrock' | 'paper' | 'vanilla' | 'forge';
export type HostLevel = 'INFO' | 'WARN' | 'ERROR';

const STYLES: [LogStyle, RegExp][] = [
  ['bedrock', /^\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d:\d{3} [A-Z]+\]/], // [2026-11-05 17:13:42:479 INFO] …
  ['paper', /^\[\d\d:\d\d:\d\d [A-Z]+\]/], // [17:13:42 INFO]: …
  ['vanilla', /^\[\d\d:\d\d:\d\d\] \[/], // [17:13:42] [Server thread/INFO]: …
  ['forge', /^\[\d\d[A-Za-z]{3}\d{4} \d\d:\d\d:\d\d\.\d{3}\] \[/], // [05Nov2026 17:13:42.479] [main/INFO] […]: …
];

/** Which log format a line the server printed is in, if it is a recognisable log line. */
export function detectStyle(line: string): LogStyle | null {
  for (const [style, re] of STYLES) if (re.test(line)) return style;
  return null;
}

/** Best guess before the server has printed anything (during install, or before the first start). */
export function defaultStyle(rec: ServerRecord): LogStyle {
  if (rec.edition === 'bedrock') return 'bedrock';
  return rec.type === 'PAPER' || rec.type === 'PURPUR' ? 'paper' : 'vanilla';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n: number) => String(n).padStart(2, '0');
const p3 = (n: number) => String(n).padStart(3, '0');

/** The timestamp/level prefix the server itself would print, in the container's timezone like the server's. */
export function hostPrefix(style: LogStyle, level: HostLevel, d = new Date()): string {
  const time = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  switch (style) {
    case 'bedrock':
      return `[${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${time}:${p3(d.getMilliseconds())} ${level}] `;
    case 'paper':
      return `[${time} ${level}]: `;
    case 'forge':
      return `[${p2(d.getDate())}${MONTHS[d.getMonth()]}${d.getFullYear()} ${time}.${p3(d.getMilliseconds())}] [Blockhost/${level}]: `;
    default:
      return `[${time}] [Blockhost/${level}]: `;
  }
}

/** Failures and forced stops get the level a server would give them. */
export function levelFor(message: string): HostLevel {
  if (/\bfailed\b|too many crashes/i.test(message)) return 'ERROR';
  if (/did not stop in time|force killing|skipped/i.test(message)) return 'WARN';
  return 'INFO';
}

const RULE_WIDTH = 54; // same width as the banners Bedrock prints

/** A titled block: `===== TITLE =====`, the body lines, and a closing rule. */
export function bannerLines(title: string, body: string[]): string[] {
  const label = ` ${title.toUpperCase()} `;
  const fill = Math.max(6, RULE_WIDTH - label.length);
  const left = Math.floor(fill / 2);
  return ['='.repeat(left) + label + '='.repeat(fill - left), ...body, '='.repeat(Math.max(RULE_WIDTH, label.length + 6))];
}

/**
 * Turns raw server log lines into terminal output, folding consecutive repeats of the same message into one line
 * with a counter: `[17:19:41 INFO] Running AutoCompaction... [x6]`. The first occurrence (and its timestamp) stays.
 * Only the console view is affected; the server's log files keep every line.
 */

const DIM = '\x1b[38;5;245m';
const RESET = '\x1b[0m';

export function colorize(line: string): string {
  if (line.startsWith('> ')) return `\x1b[38;5;114m${line}${RESET}`;
  if (line.startsWith('[Blockhost]')) return `\x1b[38;5;75m${line}${RESET}`;
  if (/\b(ERROR|SEVERE|FATAL|Exception|Caused by)\b/.test(line)) return `\x1b[38;5;203m${line}${RESET}`;
  if (/\b(WARN|WARNING)\b/.test(line)) return `\x1b[38;5;221m${line}${RESET}`;
  if (/joined the game|Player connected|logged in/.test(line)) return `\x1b[38;5;114m${line}${RESET}`;
  if (/left the game|Player disconnected|lost connection/.test(line)) return `${DIM}${line}${RESET}`;
  return line.replace(/^(\[[^\]]+\])/, `${DIM}$1${RESET}`);
}

/**
 * The message without its leading date/time, so the same message logged at different times compares equal.
 * Handles `[2026-11-05 17:19:41:102 INFO] …` (Bedrock), `[17:19:41] [Server thread/INFO]: …` (Java),
 * `[17:19:41 INFO]: …` (Paper) and `[05Nov2026 17:19:41.102] […]` (Forge).
 */
export function repeatKey(line: string): string {
  return line.replace(/^\[[^\]]*?\d{1,2}:\d{2}:\d{2}[:.,]?\d*\s*/, '[');
}

/** Rewriting a line in place needs its exact on-screen width, which is only certain for plain printable ASCII. */
const PLAIN = /^[\x20-\x7e]+$/;

export interface LineWriter {
  /** Terminal output for `lines`, given the terminal's current size. */
  render(lines: string[], cols: number, rows: number): string;
  /** Forget the previous line (after the terminal was cleared). */
  reset(): void;
}

export function createLineWriter(): LineWriter {
  let last: { key: string; line: string; count: number } | null = null;

  return {
    reset() {
      last = null;
    },
    render(lines, cols, rows) {
      let out = '';
      for (const line of lines) {
        const key = repeatKey(line);
        if (last && last.key === key && line.trim() && PLAIN.test(last.line)) {
          // The previous line is already on screen: step back up over the rows it occupies and redraw it.
          const shown = last.count > 1 ? `${last.line} [x${last.count}]` : last.line;
          const height = Math.max(1, Math.ceil(shown.length / Math.max(1, cols)));
          if (height < rows) {
            last.count++;
            out += `\x1b[${height}A\r\x1b[J${colorize(last.line)} ${DIM}[x${last.count}]${RESET}\r\n`;
            continue;
          }
        }
        last = { key, line, count: 1 };
        out += `${colorize(line)}\r\n`;
      }
      return out;
    },
  };
}

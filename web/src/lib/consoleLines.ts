/**
 * Turns raw server log lines into terminal output, folding consecutive repeats of the same message into two lines:
 * the first occurrence, then the newest repeat with a count of the repeats it stands for.
 *   [17:19:41 INFO] Running AutoCompaction...
 *   [17:37:41 INFO] Running AutoCompaction... [x3]
 * So the console shows when a run started and when it last happened. Only the view is affected; nothing is dropped
 * from the server's log files.
 */

const DIM = '\x1b[38;5;245m';
const BLUE = '\x1b[38;5;75m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

/** Invisible mark the backend puts in front of Blockhost's own lines (see server/src/servers/hostlog.ts). */
const HOST_MARK = '\u200b';

/** Blockhost's own lines: blue throughout, with banner rules and titles (`===== TITLE =====`) in bold. */
function colorizeHost(line: string): string {
  return `${/={6,}/.test(line) ? BOLD : ''}${BLUE}${line}${RESET}`;
}

export function colorize(line: string): string {
  if (line.startsWith('> ')) return `\x1b[38;5;114m${line}${RESET}`;
  if (line.startsWith('[Blockhost]')) return colorizeHost(line);
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
  // `latest` is the newest repeat of the run's first line and `repeats` how many repeats it stands for (0 = none yet).
  let last: { key: string; latest: string; host: boolean; repeats: number } | null = null;
  const paint = (line: string, host: boolean) => (host ? colorizeHost(line) : colorize(line));

  return {
    reset() {
      last = null;
    },
    render(lines, cols, rows) {
      let out = '';
      for (const raw of lines) {
        const host = raw.startsWith(HOST_MARK);
        const line = host ? raw.slice(HOST_MARK.length) : raw;
        const key = repeatKey(line);
        if (last && last.key === key && line.trim()) {
          if (last.repeats === 0) {
            // First repeat: it gets its own line under the first occurrence, which stays as it is.
            last.latest = line;
            last.repeats = 1;
            out += `${paint(line, host)}\r\n`;
            continue;
          }
          // Later repeats replace that second line, so it always shows the newest timestamp and the running count.
          // Redrawing in place means stepping back up over the rows it occupies now.
          const shown = last.repeats > 1 ? `${last.latest} [x${last.repeats}]` : last.latest;
          const height = Math.max(1, Math.ceil(shown.length / Math.max(1, cols)));
          if (PLAIN.test(shown) && PLAIN.test(line) && height < rows) {
            last.latest = line;
            last.repeats++;
            out += `\x1b[${height}A\r\x1b[J${paint(line, host)} ${DIM}[x${last.repeats}]${RESET}\r\n`;
            continue;
          }
        }
        last = { key, latest: line, host, repeats: 0 };
        out += `${paint(line, host)}\r\n`;
      }
      return out;
    },
  };
}

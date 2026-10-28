import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ChevronRight, Eraser } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { ServerSummary, WsEvent } from '../../lib/types';
import { useWsEvent, ws } from '../../lib/ws';
import { useToast } from '../../components/Toast';

const COMMON = ['help', 'list', 'say ', 'stop', 'save-all', 'whitelist add ', 'op ', 'deop ', 'kick ', 'ban ', 'time set day', 'weather clear', 'gamemode creative ', 'difficulty ', 'tp '];
const COMMON_BEDROCK = ['help', 'list', 'say ', 'stop', 'save hold', 'save query', 'save resume', 'allowlist add ', 'op ', 'deop ', 'kick ', 'time set day', 'weather clear', 'gamemode creative ', 'difficulty ', 'tp '];

function colorize(line: string): string {
  if (line.startsWith('> ')) return `\x1b[38;5;114m${line}\x1b[0m`;
  if (line.startsWith('[Blockhost]')) return `\x1b[38;5;75m${line}\x1b[0m`;
  if (/\b(ERROR|SEVERE|FATAL|Exception|Caused by)\b/.test(line)) return `\x1b[38;5;203m${line}\x1b[0m`;
  if (/\b(WARN|WARNING)\b/.test(line)) return `\x1b[38;5;221m${line}\x1b[0m`;
  if (/joined the game|Player connected|logged in/.test(line)) return `\x1b[38;5;114m${line}\x1b[0m`;
  if (/left the game|Player disconnected|lost connection/.test(line)) return `\x1b[38;5;245m${line}\x1b[0m`;
  return line.replace(/^(\[[^\]]+\])/, '\x1b[38;5;245m$1\x1b[0m');
}

export function Console({ s }: { s: ServerSummary }) {
  const toast = useToast();
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | null>(null);
  const [cmd, setCmd] = useState('');
  const hist = useRef<string[]>([]);
  const histIdx = useRef(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!host.current) return;
    const t = new XTerm({
      convertEol: true,
      disableStdin: true,
      cursorBlink: false,
      fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.35,
      scrollback: 5000,
      theme: { background: '#0a0d12', foreground: '#d7dee6', selectionBackground: 'rgba(52,211,153,0.25)', cursor: '#34d399' },
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(host.current);
    fit.fit();
    term.current = t;
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    });
    ro.observe(host.current);
    const unsub = ws.subscribeLogs(s.id);
    return () => {
      unsub();
      ro.disconnect();
      t.dispose();
      term.current = null;
    };
  }, [s.id]);

  useWsEvent((ev: WsEvent) => {
    if (!term.current) return;
    if (ev.type === 'server.backlog' && ev.id === s.id) {
      term.current.clear();
      term.current.write(ev.lines.map(colorize).join('\r\n') + (ev.lines.length ? '\r\n' : ''));
      term.current.scrollToBottom();
    } else if (ev.type === 'server.log' && ev.id === s.id) {
      term.current.writeln(colorize(ev.line));
    }
  });

  const send = async () => {
    const c = cmd.trim();
    if (!c) return;
    hist.current = [c, ...hist.current.filter((x) => x !== c)].slice(0, 50);
    histIdx.current = -1;
    setCmd('');
    try {
      await api.post(`/api/servers/${s.id}/command`, { command: c });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') return void send();
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const i = Math.min(hist.current.length - 1, histIdx.current + 1);
      histIdx.current = i;
      if (hist.current[i] !== undefined) setCmd(hist.current[i]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const i = Math.max(-1, histIdx.current - 1);
      histIdx.current = i;
      setCmd(i === -1 ? '' : hist.current[i]);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const list = s.edition === 'java' ? COMMON : COMMON_BEDROCK;
      const m = list.find((x) => x.startsWith(cmd) && x !== cmd);
      if (m) setCmd(m);
    }
  };

  const active = s.state === 'running' || s.state === 'starting';
  return (
    <div className="card fade-up overflow-hidden">
      <div className="flex items-center justify-between border-b border-line px-4 py-2 text-xs text-muted">
        <span>
          Live console · <span className="font-mono">{s.id}</span>
        </span>
        <button className="btn-ghost btn-sm" onClick={() => term.current?.clear()}>
          <Eraser className="size-3.5" /> Clear
        </button>
      </div>
      <div ref={host} className="h-[60vh] min-h-[360px] bg-bg" onClick={() => inputRef.current?.focus()} />
      <div className="flex items-center gap-2 border-t border-line bg-black/30 px-3 py-2">
        <ChevronRight className="size-4 text-accent" />
        <input
          ref={inputRef}
          className="flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-muted/60"
          placeholder={active ? 'Type a command and press Enter  (↑ history, Tab completes)' : 'Start the server to send commands'}
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={onKey}
          disabled={!active}
          autoFocus
          spellCheck={false}
        />
        <button className="btn-primary btn-sm" onClick={send} disabled={!active || !cmd.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}

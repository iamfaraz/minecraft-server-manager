import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ChevronRight, Eraser, User } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { commonPrefix, suggest, type Suggestion } from '../../lib/commands';
import { api } from '../../lib/api';
import type { ServerSummary, WsEvent } from '../../lib/types';
import { useWsEvent, ws } from '../../lib/ws';
import { useToast } from '../../components/Toast';

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

  // Names offered for <player> arguments: online first, then everyone the server knows about.
  const playersQ = useQuery({
    queryKey: ['players', s.id],
    queryFn: () => api.get<{ seen: { name: string }[]; whitelist: { name: string }[]; ops: { name: string }[] }>(`/api/servers/${s.id}/players`),
    staleTime: 30_000,
  });
  const playerNames = useMemo(() => {
    const names = [...s.players.map((p) => p.name), ...(playersQ.data?.seen || []).map((p) => p.name), ...(playersQ.data?.whitelist || []).map((p) => p.name), ...(playersQ.data?.ops || []).map((p) => p.name)];
    return [...new Set(names.filter(Boolean))];
  }, [s.players, playersQ.data]);

  const [sel, setSel] = useState(0);
  const [navigated, setNavigated] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [forced, setForced] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const sug = useMemo(() => suggest(s, cmd, playerNames), [s, cmd, playerNames]);
  const wantsSuggest = cmd.startsWith('/') || forced;
  const open = wantsSuggest && !dismissed && sug.items.length > 0;
  const showUsage = wantsSuggest && !dismissed && !!(sug.usage || sug.hint) && cmd.trim().length > 1;

  useEffect(() => {
    listRef.current?.querySelector('[data-sel="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [sel, open]);

  const update = (v: string) => {
    setCmd(v);
    setSel(0);
    setNavigated(false);
    setDismissed(false);
    if (!v) setForced(false);
  };

  const accept = (item: Suggestion) => {
    update(`${sug.prefix}${item.label} `);
    inputRef.current?.focus();
  };

  const send = async () => {
    const c = cmd.trim();
    if (!c || c === '/') return;
    hist.current = [c, ...hist.current.filter((x) => x !== c)].slice(0, 50);
    histIdx.current = -1;
    update('');
    setForced(false);
    try {
      await api.post(`/api/servers/${s.id}/command`, { command: c });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      if (!wantsSuggest) {
        setForced(true);
        setDismissed(false);
        return;
      }
      if (!sug.items.length) return;
      if (sug.items.length === 1 || navigated) return accept(sug.items[sel] ?? sug.items[0]);
      // Several matches: extend to what they have in common first, like a shell.
      const cp = commonPrefix(sug.items);
      if (cp.length > sug.token.length) update(`${sug.prefix}${cp}`);
      else accept(sug.items[sel]);
      return;
    }
    if (e.key === 'Escape' && (open || showUsage)) {
      e.preventDefault();
      setDismissed(true);
      return;
    }
    if (e.key === 'Enter') {
      if (open && navigated) {
        e.preventDefault();
        return accept(sug.items[sel]);
      }
      return void send();
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (open) {
        const n = sug.items.length;
        setSel((i) => (e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n));
        setNavigated(true);
        return;
      }
      if (e.key === 'ArrowUp') {
        const i = Math.min(hist.current.length - 1, histIdx.current + 1);
        histIdx.current = i;
        if (hist.current[i] !== undefined) setCmd(hist.current[i]);
      } else {
        const i = Math.max(-1, histIdx.current - 1);
        histIdx.current = i;
        setCmd(i === -1 ? '' : hist.current[i]);
      }
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
      <div className="relative flex items-center gap-2 border-t border-line bg-black/30 px-3 py-2">
        {(open || showUsage) && (
          <div className="absolute right-0 bottom-full left-0 z-10 border-t border-line bg-panel/95 shadow-[0_-12px_30px_-12px_rgba(0,0,0,0.7)] backdrop-blur">
            {open && (
              <ul ref={listRef} className="max-h-64 overflow-y-auto py-1">
                {sug.items.map((it, i) => (
                  <li key={it.kind + it.label}>
                    <button
                      type="button"
                      data-sel={i === sel}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        accept(it);
                      }}
                      onMouseEnter={() => setSel(i)}
                      className={clsx('flex w-full items-center gap-3 px-4 py-1.5 text-left text-sm', i === sel ? 'bg-accent/15 text-ink' : 'text-muted hover:bg-white/5')}
                    >
                      {it.kind === 'player' ? <User className="size-3.5 shrink-0 text-violet-300" /> : <span className={clsx('w-3.5 shrink-0 text-center font-mono text-xs', it.kind === 'command' ? 'text-accent' : 'text-sky-300')}>{it.kind === 'command' ? '/' : '·'}</span>}
                      <span className="font-mono text-[13px] text-ink">
                        <span className="text-accent">{it.label.slice(0, sug.token.length)}</span>
                        {it.label.slice(sug.token.length)}
                      </span>
                      {it.detail && <span className="truncate text-xs text-muted">{it.detail}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center justify-between gap-3 border-t border-line/60 px-4 py-1.5 text-[11px] text-muted">
              <span className="truncate font-mono">{sug.usage ? `/${sug.usage}` : sug.hint || `${sug.items.length} command${sug.items.length === 1 ? '' : 's'}`}</span>
              <span className="hidden shrink-0 sm:block">
                <span className="kbd">Tab</span> complete · <span className="kbd">↑↓</span> select · <span className="kbd">Enter</span> run · <span className="kbd">Esc</span> close
              </span>
            </div>
          </div>
        )}
        <ChevronRight className="size-4 text-accent" />
        <input
          ref={inputRef}
          className="flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-muted/60"
          placeholder={active ? 'Type / for commands, Tab to complete, ↑ for history' : 'Start the server to send commands'}
          value={cmd}
          onChange={(e) => update(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => setTimeout(() => setDismissed(true), 120)}
          onFocus={() => setDismissed(false)}
          disabled={!active}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
        />
        <button className="btn-primary btn-sm" onClick={send} disabled={!active || !cmd.trim() || cmd.trim() === '/'}>
          Send
        </button>
      </div>
    </div>
  );
}

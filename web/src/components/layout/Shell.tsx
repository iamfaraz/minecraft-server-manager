import { clsx } from 'clsx';
import { Globe2, LayoutGrid, LogOut, Plus, Settings2, Server, Menu, X } from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useServers } from '../../hooks/useServers';
import { api } from '../../lib/api';
import { StatusDot } from '../ui';

export function Logo({ compact }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" className="size-8 shrink-0">
        <rect width="32" height="32" rx="8" fill="#0f1720" />
        <rect x="8" y="8" width="6.5" height="6.5" rx="1" fill="#34d399" />
        <rect x="17.5" y="8" width="6.5" height="6.5" rx="1" fill="#34d399" opacity="0.65" />
        <rect x="8" y="17.5" width="6.5" height="6.5" rx="1" fill="#34d399" opacity="0.65" />
        <rect x="17.5" y="17.5" width="6.5" height="6.5" rx="1" fill="#34d399" opacity="0.35" />
      </svg>
      {!compact && (
        <div className="leading-tight">
          <p className="text-[15px] font-semibold tracking-tight">Blockhost</p>
          <p className="text-[11px] text-muted">Minecraft server manager</p>
        </div>
      )}
    </div>
  );
}

const navClass = ({ isActive }: { isActive: boolean }) =>
  clsx('flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition', isActive ? 'bg-white/[0.07] text-ink' : 'text-muted hover:bg-white/[0.04] hover:text-ink');

export function Shell({ user, onLogout }: { user: string; onLogout: () => void }) {
  const { data: servers } = useServers();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);

  const logout = async () => {
    await api.post('/api/auth/logout');
    onLogout();
  };

  const sidebar = (
    <aside className="flex h-full w-[264px] shrink-0 flex-col border-r border-line bg-panel/60 backdrop-blur-xl">
      <div className="flex items-center justify-between px-5 py-5">
        <Logo />
        <button className="btn-ghost btn-sm lg:hidden" onClick={() => setOpen(false)}>
          <X className="size-4" />
        </button>
      </div>
      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 pb-3">
        <NavLink to="/" end className={navClass} onClick={() => setOpen(false)}>
          <LayoutGrid className="size-4" /> Dashboard
        </NavLink>
        <div className="mt-4 mb-1 flex items-center justify-between px-3">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">Servers</span>
          <button className="rounded-md p-1 text-muted hover:bg-white/10 hover:text-ink" title="New server" onClick={() => { setOpen(false); nav('/new'); }}>
            <Plus className="size-3.5" />
          </button>
        </div>
        {servers?.length ? (
          servers.map((s) => (
            <NavLink key={s.id} to={`/servers/${s.id}`} className={navClass} onClick={() => setOpen(false)}>
              <StatusDot state={s.state} />
              <span className="flex-1 truncate">{s.name}</span>
              <span className={clsx('text-[10px] font-semibold uppercase', s.edition === 'java' ? 'text-orange-300/70' : 'text-sky-300/70')}>{s.edition === 'java' ? 'JE' : 'BE'}</span>
            </NavLink>
          ))
        ) : (
          <button onClick={() => { setOpen(false); nav('/new'); }} className="mx-1 flex items-center gap-3 rounded-xl border border-dashed border-line px-3 py-2.5 text-sm text-muted hover:border-accent/40 hover:text-ink">
            <Server className="size-4" /> Create your first server
          </button>
        )}
        <div className="mt-4 mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted">Network</div>
        <NavLink to="/remote" className={navClass} onClick={() => setOpen(false)}>
          <Globe2 className="size-4" /> Remote play
        </NavLink>
        <NavLink to="/system" className={navClass} onClick={() => setOpen(false)}>
          <Settings2 className="size-4" /> System
        </NavLink>
      </nav>
      <div className="flex items-center justify-between border-t border-line px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-full bg-gradient-to-br from-emerald-400 to-sky-500 text-xs font-bold text-emerald-950">{user.slice(0, 1).toUpperCase()}</div>
          <span className="text-sm font-medium">{user}</span>
        </div>
        <button className="btn-ghost btn-sm" onClick={logout} title="Sign out">
          <LogOut className="size-4" />
        </button>
      </div>
    </aside>
  );

  return (
    <div className="flex h-full">
      <div className="hidden lg:block">{sidebar}</div>
      {open && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
          <div className="relative">{sidebar}</div>
        </div>
      )}
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3 lg:hidden">
          <button className="btn-ghost btn-sm" onClick={() => setOpen(true)}>
            <Menu className="size-5" />
          </button>
          <Logo compact />
        </div>
        <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

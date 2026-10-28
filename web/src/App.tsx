import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { api } from './lib/api';
import { ws } from './lib/ws';
import { Shell } from './components/layout/Shell';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { NewServer } from './pages/NewServer';
import { ServerPage } from './pages/server/ServerPage';
import { RemotePlay } from './pages/RemotePlay';
import { System } from './pages/System';
import { Spinner } from './components/ui';

type Auth = { loading: true } | { loading: false; setupRequired: boolean; user: string | null };

export default function App() {
  const [auth, setAuth] = useState<Auth>({ loading: true });

  const refresh = () =>
    api
      .get<{ setupRequired: boolean; user: string | null }>('/api/auth/status')
      .then((r) => setAuth({ loading: false, ...r }))
      .catch(() => setAuth({ loading: false, setupRequired: false, user: null }));

  useEffect(() => {
    refresh();
    const h = () => setAuth((a) => (a.loading ? a : { ...a, user: null }));
    window.addEventListener('mcsm:unauthorized', h);
    return () => window.removeEventListener('mcsm:unauthorized', h);
  }, []);

  useEffect(() => {
    if (!auth.loading && auth.user) ws.start();
    else ws.stop();
  }, [auth]);

  if (auth.loading)
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <Spinner className="size-5 animate-spin" />
      </div>
    );
  if (!auth.user) return <Login setupRequired={auth.setupRequired} onDone={(user) => setAuth({ loading: false, setupRequired: false, user })} />;

  return (
    <Routes>
      <Route element={<Shell user={auth.user} onLogout={() => setAuth({ loading: false, setupRequired: false, user: null })} />}>
        <Route index element={<Dashboard />} />
        <Route path="new" element={<NewServer />} />
        <Route path="servers/:id/*" element={<ServerPage />} />
        <Route path="remote" element={<RemotePlay />} />
        <Route path="system" element={<System />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

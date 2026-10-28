import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from '../lib/api';
import type { ServerSummary, WsEvent } from '../lib/types';
import { useWsEvent } from '../lib/ws';

export function useServers() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['servers'], queryFn: () => api.get<ServerSummary[]>('/api/servers'), staleTime: 5000, refetchInterval: 15_000 });

  useWsEvent(
    useCallback(
      (ev: WsEvent) => {
        if (ev.type === 'hello') {
          qc.setQueryData(['servers'], ev.servers);
          return;
        }
        if (ev.type === 'server.changed' || ev.type === 'pong') {
          qc.invalidateQueries({ queryKey: ['servers'] });
          return;
        }
        if (ev.type === 'server.state' || ev.type === 'server.stats' || ev.type === 'server.players' || ev.type === 'server.progress') {
          qc.setQueryData<ServerSummary[]>(['servers'], (old) =>
            old?.map((s) => {
              if (s.id !== ev.id) return s;
              if (ev.type === 'server.state') return { ...s, state: ev.state, ...(ev.state !== 'installing' ? { install: null } : {}) };
              if (ev.type === 'server.stats') return { ...s, lastStats: ev.sample };
              if (ev.type === 'server.players') return { ...s, players: ev.players };
              if (ev.type === 'server.progress') return { ...s, install: ev.done ? null : { pct: ev.pct, message: ev.message } };
              return s;
            }),
          );
          if (ev.type === 'server.state' || (ev.type === 'server.progress' && ev.done)) qc.invalidateQueries({ queryKey: ['servers'] });
        }
      },
      [qc],
    ),
  );
  return q;
}

export function useServer(id: string | undefined) {
  const q = useServers();
  return { ...q, server: q.data?.find((s) => s.id === id) };
}

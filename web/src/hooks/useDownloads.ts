import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { api } from '../lib/api';
import type { DownloadJob, DownloadTask, WsEvent } from '../lib/types';
import { useWsEvent } from '../lib/ws';

type Snapshot = { tasks: DownloadTask[]; jobs: DownloadJob[] };
const KEY = ['downloads'];

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

export function useDownloads() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<Snapshot>('/api/downloads'), staleTime: 30_000 });

  useWsEvent(
    useCallback(
      (ev: WsEvent) => {
        if (ev.type === 'hello') return void qc.invalidateQueries({ queryKey: KEY });
        if (ev.type !== 'download.changed') return;
        qc.setQueryData<Snapshot>(KEY, (old) => {
          const s = old ?? { tasks: [], jobs: [] };
          return { tasks: ev.task ? upsert(s.tasks, ev.task) : s.tasks, jobs: ev.job ? upsert(s.jobs, ev.job) : s.jobs };
        });
      },
      [qc],
    ),
  );

  const tasks = q.data?.tasks ?? [];
  const jobs = q.data?.jobs ?? [];
  const active = useMemo(() => jobs.filter((j) => j.state === 'queued' || j.state === 'active' || j.state === 'verifying').length, [jobs]);
  const refresh = () => qc.invalidateQueries({ queryKey: KEY });
  return {
    tasks,
    jobs,
    active,
    cancelTask: (id: string) => api.post(`/api/downloads/tasks/${id}/cancel`).finally(refresh),
    cancelJob: (id: string) => api.post(`/api/downloads/${id}/cancel`).finally(refresh),
    retryTask: (id: string) => api.post(`/api/downloads/tasks/${id}/retry`).finally(refresh),
    clearHistory: () => api.del('/api/downloads/history').finally(refresh),
  };
}

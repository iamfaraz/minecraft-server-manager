import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ChevronRight, Download, File as FileIcon, FileText, Folder, FolderPlus, Home, Pencil, RefreshCw, Save, Trash2, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { fmtBytes, timeAgo } from '../../lib/format';
import type { ServerSummary } from '../../lib/types';
import { Card, EmptyState, Spinner } from '../../components/ui';
import { useToast } from '../../components/Toast';

interface Entry {
  name: string;
  type: 'file' | 'dir';
  size: number;
  mtime: string;
}

const join = (a: string, b: string) => (a ? `${a}/${b}` : b);

export function Files({ s }: { s: ServerSummary }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [path, setPath] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const list = useQuery({ queryKey: ['files', s.id, path], queryFn: () => api.get<{ path: string; entries: Entry[] }>(`/api/servers/${s.id}/files?path=${encodeURIComponent(path)}`) });
  const file = useQuery({
    queryKey: ['file', s.id, open],
    queryFn: () => api.get<{ content: string; size: number; truncated: boolean; binary: boolean }>(`/api/servers/${s.id}/files/content?path=${encodeURIComponent(open!)}`),
    enabled: !!open,
  });
  useEffect(() => {
    if (file.data) {
      setContent(file.data.content);
      setDirty(false);
    }
  }, [file.data]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['files', s.id, path] });
  const save = useMutation({
    mutationFn: () => api.put(`/api/servers/${s.id}/files/content`, { path: open, content }),
    onSuccess: () => {
      toast.success('Saved');
      setDirty(false);
      refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const mkdir = useMutation({
    mutationFn: (name: string) => api.post(`/api/servers/${s.id}/files/mkdir`, { path: join(path, name) }),
    onSuccess: refresh,
    onError: (e) => toast.error((e as Error).message),
  });
  const del = useMutation({
    mutationFn: (p: string) => api.post(`/api/servers/${s.id}/files/delete`, { path: p }),
    onSuccess: () => {
      refresh();
      setOpen(null);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const rename = useMutation({
    mutationFn: (b: { from: string; to: string }) => api.post(`/api/servers/${s.id}/files/rename`, { path: b.from, newPath: b.to }),
    onSuccess: refresh,
    onError: (e) => toast.error((e as Error).message),
  });
  const upload = useMutation({
    mutationFn: (f: File) => api.upload(`/api/servers/${s.id}/files/upload`, f, { path }),
    onSuccess: () => {
      toast.success('Uploaded');
      refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const crumbs = path ? path.split('/') : [];
  const goto = (p: string) => {
    setPath(p);
    setOpen(null);
  };

  return (
    <div className={clsx('fade-up grid gap-5', open ? 'lg:grid-cols-5' : '')}>
      <Card
        className={open ? 'lg:col-span-2' : ''}
        padded={false}
        title={
          <nav className="flex items-center gap-1 text-sm">
            <button className="btn-ghost btn-sm -ml-2" onClick={() => goto('')}>
              <Home className="size-3.5" />
            </button>
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1">
                <ChevronRight className="size-3 text-muted" />
                <button className="rounded px-1 font-mono text-xs hover:bg-white/5" onClick={() => goto(crumbs.slice(0, i + 1).join('/'))}>
                  {c}
                </button>
              </span>
            ))}
          </nav>
        }
        action={
          <div className="flex items-center gap-1">
            <input ref={fileRef} type="file" className="hidden" onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} />
            <button className="btn-ghost btn-sm" title="Upload" onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
              {upload.isPending ? <Spinner /> : <Upload className="size-3.5" />}
            </button>
            <button
              className="btn-ghost btn-sm"
              title="New folder"
              onClick={() => {
                const n = prompt('Folder name');
                if (n) mkdir.mutate(n);
              }}
            >
              <FolderPlus className="size-3.5" />
            </button>
            <button className="btn-ghost btn-sm" title="Refresh" onClick={refresh}>
              <RefreshCw className={clsx('size-3.5', list.isFetching && 'animate-spin')} />
            </button>
          </div>
        }
      >
        {list.isLoading ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : list.error ? (
          <p className="p-5 text-sm text-rose-300">{(list.error as Error).message}</p>
        ) : !list.data?.entries.length ? (
          <EmptyState icon={Folder} title="Empty folder" />
        ) : (
          <ul className="max-h-[70vh] divide-y divide-line/50 overflow-y-auto">
            {path && (
              <li>
                <button className="flex w-full items-center gap-3 px-5 py-2 text-sm text-muted hover:bg-white/[0.03]" onClick={() => goto(crumbs.slice(0, -1).join('/'))}>
                  <Folder className="size-4" /> ..
                </button>
              </li>
            )}
            {list.data.entries.map((e) => {
              const full = join(path, e.name);
              return (
                <li key={e.name} className={clsx('group flex items-center gap-3 px-5 py-2 text-sm hover:bg-white/[0.03]', open === full && 'bg-accent/[0.06]')}>
                  <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => (e.type === 'dir' ? goto(full) : setOpen(full))}>
                    {e.type === 'dir' ? <Folder className="size-4 shrink-0 text-sky-300" /> : /\.(properties|json|yml|yaml|txt|toml|cfg|conf|log|md)$/i.test(e.name) ? <FileText className="size-4 shrink-0 text-muted" /> : <FileIcon className="size-4 shrink-0 text-muted" />}
                    <span className="truncate">{e.name}</span>
                  </button>
                  <span className="hidden w-16 text-right font-mono text-[11px] text-muted sm:block">{e.type === 'file' ? fmtBytes(e.size) : ''}</span>
                  <span className="hidden w-20 text-right text-[11px] text-muted md:block">{timeAgo(e.mtime)}</span>
                  <span className="flex items-center opacity-0 transition group-hover:opacity-100">
                    {e.type === 'file' && (
                      <a className="btn-ghost btn-sm" href={`/api/servers/${s.id}/files/download?path=${encodeURIComponent(full)}`} title="Download">
                        <Download className="size-3.5" />
                      </a>
                    )}
                    <button
                      className="btn-ghost btn-sm"
                      title="Rename"
                      onClick={() => {
                        const n = prompt('New name', e.name);
                        if (n && n !== e.name) rename.mutate({ from: full, to: join(path, n) });
                      }}
                    >
                      <Pencil className="size-3.5" />
                    </button>
                    <button className="btn-ghost btn-sm text-rose-300" title="Delete" onClick={() => confirm(`Delete ${e.name}${e.type === 'dir' ? ' and everything inside' : ''}?`) && del.mutate(full)}>
                      <Trash2 className="size-3.5" />
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {open && (
        <Card
          className="lg:col-span-3"
          padded={false}
          title={
            <span className="flex items-center gap-2 font-mono text-xs">
              {open}
              {dirty && <span className="size-1.5 rounded-full bg-amber-400" />}
            </span>
          }
          action={
            <div className="flex items-center gap-1">
              <button className="btn-primary btn-sm" disabled={!dirty || save.isPending || file.data?.binary} onClick={() => save.mutate()}>
                {save.isPending ? <Spinner /> : <Save className="size-3.5" />} Save
              </button>
              <button className="btn-ghost btn-sm" onClick={() => setOpen(null)}>
                <X className="size-3.5" />
              </button>
            </div>
          }
        >
          {file.isLoading ? (
            <div className="flex justify-center py-12">
              <Spinner />
            </div>
          ) : file.data?.binary ? (
            <EmptyState icon={FileIcon} title="Binary file" description={`${fmtBytes(file.data.size)} — download it to view.`} action={<a className="btn-secondary btn-sm" href={`/api/servers/${s.id}/files/download?path=${encodeURIComponent(open)}`}><Download className="size-3.5" /> Download</a>} />
          ) : (
            <>
              {file.data?.truncated && <p className="border-b border-line px-4 py-2 text-xs text-amber-300">File is larger than 2 MB; only the beginning is shown and saving is disabled.</p>}
              <textarea
                className="h-[70vh] w-full resize-none bg-black/30 p-4 font-mono text-xs leading-relaxed text-ink outline-none"
                value={content}
                spellCheck={false}
                disabled={file.data?.truncated}
                onChange={(e) => {
                  setContent(e.target.value);
                  setDirty(true);
                }}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                    e.preventDefault();
                    if (dirty) save.mutate();
                  }
                }}
              />
            </>
          )}
        </Card>
      )}
    </div>
  );
}

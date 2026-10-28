import { clsx } from 'clsx';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type Level = 'info' | 'success' | 'error';
interface Toast {
  id: number;
  level: Level;
  message: string;
}
interface Ctx {
  toast: (message: string, level?: Level) => void;
  success: (m: string) => void;
  error: (m: string) => void;
}
const ToastCtx = createContext<Ctx | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const remove = useCallback((id: number) => setItems((x) => x.filter((t) => t.id !== id)), []);
  const toast = useCallback(
    (message: string, level: Level = 'info') => {
      const id = Date.now() + Math.random();
      setItems((x) => [...x.slice(-4), { id, level, message }]);
      setTimeout(() => remove(id), level === 'error' ? 7000 : 4000);
    },
    [remove],
  );
  const ctx = useMemo<Ctx>(() => ({ toast, success: (m) => toast(m, 'success'), error: (m) => toast(m, 'error') }), [toast]);
  return (
    <ToastCtx.Provider value={ctx}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-80 flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            className={clsx(
              'pointer-events-auto fade-up flex items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-2xl backdrop-blur',
              t.level === 'success' && 'border-emerald-500/30 bg-emerald-950/80 text-emerald-100',
              t.level === 'error' && 'border-rose-500/30 bg-rose-950/80 text-rose-100',
              t.level === 'info' && 'border-line bg-panel/90 text-ink',
            )}
          >
            {t.level === 'success' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : t.level === 'error' ? <AlertCircle className="mt-0.5 size-4 shrink-0" /> : <Info className="mt-0.5 size-4 shrink-0" />}
            <span className="flex-1 break-words">{t.message}</span>
            <button onClick={() => remove(t.id)} className="opacity-60 hover:opacity-100">
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast(): Ctx {
  const c = useContext(ToastCtx);
  if (!c) throw new Error('ToastProvider missing');
  return c;
}

import { Copy, Download, ExternalLink, Package } from 'lucide-react';
import { copy, hostAddress } from '../lib/format';
import type { ServerSummary } from '../lib/types';
import { Card } from './ui';
import { useToast } from './Toast';

/** What players need to join a modpack server: the exact pack version, and where to connect. */
export function JoinCard({ s }: { s: ServerSummary }) {
  const toast = useToast();
  const mp = s.modpack;
  if (!mp) return null;
  const address = s.address.remote[0]?.split(' ')[0] || hostAddress(s.port);
  const link = mp.slug ? `https://modrinth.com/modpack/${mp.slug}/version/${encodeURIComponent(mp.versionNumber)}` : null;
  const instructions = link
    ? `To join ${s.name}:\n1. Install ${mp.title} v${mp.versionNumber} in the Modrinth App or Prism Launcher: ${link}\n2. Launch it and add the server ${address}`
    : `To join ${s.name}:\n1. Get the ${mp.title} v${mp.versionNumber} pack file from the server admin and import it into the Modrinth App or Prism Launcher.\n2. Launch it and add the server ${address}`;

  return (
    <Card
      title="How to join"
      action={
        <button className="btn-secondary btn-sm" onClick={() => copy(instructions).then(() => toast.success('Instructions copied'))}>
          <Copy className="size-3.5" /> Copy instructions
        </button>
      }
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {mp.icon ? <img src={mp.icon} alt="" className="size-12 shrink-0 rounded-xl" /> : <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-white/5"><Package className="size-6 text-muted" /></div>}
          <div className="min-w-0 text-sm">
            {link ? (
              <p>
                Install{' '}
                <a href={link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-accent hover:underline">
                  {mp.title} v{mp.versionNumber} <ExternalLink className="size-3" />
                </a>{' '}
                in the Modrinth App or Prism.
              </p>
            ) : (
              <p>
                Ask the admin for the <b>{mp.title} v{mp.versionNumber}</b> pack file.
              </p>
            )}
            <p className="mt-0.5 text-muted">
              Then connect to{' '}
              <button className="font-mono text-ink hover:text-accent" onClick={() => copy(address).then(() => toast.success('Address copied'))}>
                {address}
              </button>
            </p>
          </div>
        </div>
        {!link && (
          <a className="btn-secondary btn-sm shrink-0" href={`/api/servers/${s.id}/modpack/file`}>
            <Download className="size-3.5" /> Download pack
          </a>
        )}
      </div>
    </Card>
  );
}

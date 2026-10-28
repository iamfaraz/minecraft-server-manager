import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe2, Save, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtMb } from '../../lib/format';
import type { ServerSummary, SystemInfo } from '../../lib/types';
import { Card, ConfirmModal, Field, Segmented, Spinner, Toggle } from '../../components/ui';
import { useToast } from '../../components/Toast';

const JAVA_COMMON = ['motd', 'max-players', 'gamemode', 'difficulty', 'pvp', 'online-mode', 'white-list', 'enforce-whitelist', 'view-distance', 'simulation-distance', 'spawn-protection', 'allow-flight', 'allow-nether', 'hardcore', 'level-seed', 'level-type', 'enable-command-block', 'max-world-size', 'player-idle-timeout', 'force-gamemode', 'resource-pack'];
const BEDROCK_COMMON = ['server-name', 'gamemode', 'force-gamemode', 'difficulty', 'allow-cheats', 'max-players', 'online-mode', 'allow-list', 'server-udp-ports', 'enable-lan-visibility', 'view-distance', 'tick-distance', 'player-idle-timeout', 'max-threads', 'level-seed', 'default-player-permission-level', 'texturepack-required', 'content-log-file-enabled', 'server-authoritative-movement', 'emit-server-telemetry'];

export function Settings({ s }: { s: ServerSummary }) {
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const java = s.edition === 'java';
  const { data: sys } = useQuery({ queryKey: ['system'], queryFn: () => api.get<SystemInfo>('/api/system') });

  const [form, setForm] = useState({
    name: s.name,
    port: String(s.port),
    autoStart: s.autoStart,
    restartOnCrash: s.restartOnCrash,
    geyser: s.geyser,
    geyserPort: String(s.geyserPort || ''),
    transport: s.transport || 'raknet',
    advertiseIp: s.advertiseIp || '',
    xmxMb: s.java?.xmxMb || 2048,
    xmsMb: s.java?.xmsMb || s.java?.xmxMb || 2048,
    preset: s.java?.preset || 'aikar',
    extraArgs: s.java?.extraArgs || '',
    major: s.java?.major ?? 'auto',
    schedule: s.backup.schedule,
    keep: s.backup.keep,
    scope: s.backup.scope,
  });
  useEffect(() => {
    setForm((f) => ({ ...f, name: s.name, port: String(s.port), autoStart: s.autoStart, restartOnCrash: s.restartOnCrash, geyser: s.geyser, geyserPort: String(s.geyserPort || '') }));
  }, [s.name, s.port, s.autoStart, s.restartOnCrash, s.geyser, s.geyserPort]);

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/api/servers/${s.id}`, {
        name: form.name,
        port: Number(form.port),
        autoStart: form.autoStart,
        restartOnCrash: form.restartOnCrash,
        geyser: form.geyser,
        geyserPort: form.geyserPort ? Number(form.geyserPort) : undefined,
        transport: java ? undefined : form.transport,
        advertiseIp: java ? undefined : form.advertiseIp,
        java: java ? { xmxMb: form.xmxMb, xmsMb: form.xmsMb, preset: form.preset, extraArgs: form.extraArgs, major: form.major } : undefined,
        backup: { schedule: form.schedule, keep: Number(form.keep), scope: form.scope },
      }),
    onSuccess: () => {
      toast.success(s.state === 'running' ? 'Saved — restart to apply runtime changes' : 'Settings saved');
      qc.invalidateQueries({ queryKey: ['servers'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const props = useQuery({ queryKey: ['props', s.id], queryFn: () => api.get<{ properties: Record<string, string> }>(`/api/servers/${s.id}/properties`) });
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [newKey, setNewKey] = useState('');
  const [filter, setFilter] = useState('');
  const merged = useMemo(() => ({ ...(props.data?.properties || {}), ...edited }), [props.data, edited]);
  const common = java ? JAVA_COMMON : BEDROCK_COMMON;
  const keys = useMemo(() => {
    const all = Object.keys(merged).filter((k) => !['server-port', 'server-portv6', 'level-name', 'transport'].includes(k));
    const sorted = [...all.filter((k) => common.includes(k)).sort((a, b) => common.indexOf(a) - common.indexOf(b)), ...all.filter((k) => !common.includes(k)).sort()];
    return filter ? sorted.filter((k) => k.includes(filter.toLowerCase())) : sorted;
  }, [merged, common, filter]);
  const saveProps = useMutation({
    mutationFn: () => api.put(`/api/servers/${s.id}/properties`, { properties: edited }),
    onSuccess: () => {
      toast.success('server.properties saved' + (s.state === 'running' ? ' — restart to apply' : ''));
      setEdited({});
      qc.invalidateQueries({ queryKey: ['props', s.id] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const [del, setDel] = useState<null | 'files' | 'keep'>(null);
  const remove = useMutation({
    mutationFn: (files: boolean) => api.del(`/api/servers/${s.id}?deleteFiles=${files}`),
    onSuccess: () => {
      toast.success('Server deleted');
      qc.invalidateQueries({ queryKey: ['servers'] });
      nav('/');
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const memCap = sys?.memory.limitMb || sys?.memory.totalMb || 0;
  const geyserOk = ['PAPER', 'PURPUR', 'FABRIC', 'NEOFORGE'].includes(s.type);

  return (
    <div className="fade-up grid gap-5 lg:grid-cols-2">
      <div className="space-y-5">
        <Card title="General">
          <div className="space-y-4">
            <Field label="Name">
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={java ? 'Port (TCP)' : 'Port (UDP, +1 for IPv6)'} hint={sys ? `Published range ${java ? sys.ports.java.join('–') : sys.ports.bedrock.join('–')}` : undefined}>
                <input className="input font-mono" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value.replace(/\D/g, '') })} />
              </Field>
              <Field label="World folder">
                <input className="input" value={s.levelName} disabled />
              </Field>
            </div>
            {!java && (
              <Field label="Network transport" hint={form.transport === 'raknet' ? 'Classic UDP protocol: status pings, LAN discovery and tunnels all work. Needs two UDP ports.' : 'WebRTC transport (BDS default). One port on UDP + TCP; pings only report reachability. Behind NAT the advertised IP below is written into server-udp-ports.'}>
                <Segmented value={form.transport} onChange={(v) => setForm({ ...form, transport: v })} options={[{ value: 'raknet', label: 'RakNet' }, { value: 'nethernet', label: 'NetherNet' }]} />
              </Field>
            )}
            {!java && form.transport === 'nethernet' && !sys?.network?.hostNetwork && (
              <Field
                label="Advertised IP for NetherNet"
                hint={
                  sys?.network?.advertiseIp
                    ? `Defaults to ${sys.network.advertiseIp} (MCSM_ADVERTISE_IP). NetherNet negotiates addresses inside the protocol, so the server must announce the IP players actually reach: your server's LAN IP for home play, or the public IP when port-forwarded.`
                    : 'Required on Docker bridge networking: the IP players type into "Add Server" (your host\u2019s LAN IP, or the public IP when port-forwarded). Without it the server advertises its internal container IP and clients fail with a NetherNet error.'
                }
              >
                <input className="input font-mono" placeholder={sys?.network?.advertiseIp || '192.168.1.50  (or: public)'} value={form.advertiseIp} onChange={(e) => setForm({ ...form, advertiseIp: e.target.value.trim() })} />
              </Field>
            )}
            <Toggle checked={form.autoStart} onChange={(v) => setForm({ ...form, autoStart: v })} label="Start when the manager boots" />
            <Toggle checked={form.restartOnCrash} onChange={(v) => setForm({ ...form, restartOnCrash: v })} label="Restart on crash" description="Up to 3 restarts within 10 minutes." />
          </div>
        </Card>

        {java && (
          <Card title="Java runtime">
            <div className="space-y-4">
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="label mb-0">Max heap (-Xmx)</span>
                  <span className="font-mono text-sm text-accent">{fmtMb(form.xmxMb)}</span>
                </div>
                <input type="range" min={512} max={Math.max(4096, Math.min(65536, memCap))} step={256} value={form.xmxMb} onChange={(e) => setForm({ ...form, xmxMb: Number(e.target.value), xmsMb: Math.min(form.xmsMb, Number(e.target.value)) })} className="w-full accent-emerald-400" />
                {memCap > 0 && form.xmxMb + 1024 > memCap && <p className="mt-1 text-xs text-amber-300">Leaves less than 1 GB headroom under the container limit ({fmtMb(memCap)}).</p>}
              </div>
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="label mb-0">Initial heap (-Xms)</span>
                  <span className="font-mono text-sm">{fmtMb(form.xmsMb)}</span>
                </div>
                <input type="range" min={256} max={form.xmxMb} step={256} value={form.xmsMb} onChange={(e) => setForm({ ...form, xmsMb: Number(e.target.value) })} className="w-full accent-emerald-400" />
              </div>
              <Field label="GC preset">
                <Segmented value={form.preset} onChange={(v) => setForm({ ...form, preset: v })} options={[{ value: 'aikar', label: "Aikar's flags" }, { value: 'zgc', label: 'Generational ZGC' }, { value: 'none', label: 'None' }]} />
              </Field>
              <Field label="Java version">
                <select className="input" value={String(form.major)} onChange={(e) => setForm({ ...form, major: e.target.value === 'auto' ? 'auto' : Number(e.target.value) })}>
                  <option value="auto">Automatic (based on Minecraft version)</option>
                  {[8, 11, 17, 21, 25].map((m) => (
                    <option key={m} value={m}>
                      Java {m}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Extra JVM arguments" hint="Appended after the preset flags.">
                <input className="input font-mono" placeholder="-XX:+UseStringDeduplication" value={form.extraArgs} onChange={(e) => setForm({ ...form, extraArgs: e.target.value })} />
              </Field>
            </div>
          </Card>
        )}

        {java && geyserOk && (
          <Card title={<span className="flex items-center gap-2"><Globe2 className="size-4 text-sky-300" /> Cross-play (Geyser + Floodgate)</span>}>
            <div className="space-y-4">
              <Toggle checked={form.geyser} onChange={(v) => setForm({ ...form, geyser: v })} label="Allow Bedrock players to join" description="Installs Geyser and Floodgate into this server. Bedrock players connect over UDP on the port below." />
              {form.geyser && (
                <Field label="Bedrock port (UDP)" hint="Applied to Geyser's config.yml on each start. Leave empty to auto-assign.">
                  <input className="input font-mono" value={form.geyserPort} onChange={(e) => setForm({ ...form, geyserPort: e.target.value.replace(/\D/g, '') })} />
                </Field>
              )}
            </div>
          </Card>
        )}

        <Card title="Scheduled backups">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Frequency">
              <select className="input" value={form.schedule} onChange={(e) => setForm({ ...form, schedule: e.target.value as typeof form.schedule })}>
                <option value="off">Off</option>
                <option value="hourly">Hourly</option>
                <option value="6h">Every 6 hours</option>
                <option value="daily">Daily</option>
              </select>
            </Field>
            <Field label="Keep">
              <input className="input" type="number" min={1} max={100} value={form.keep} onChange={(e) => setForm({ ...form, keep: Number(e.target.value) })} />
            </Field>
            <Field label="Scope">
              <select className="input" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value as typeof form.scope })}>
                <option value="world">World only</option>
                <option value="full">Full server</option>
              </select>
            </Field>
          </div>
          <p className="mt-2 text-xs text-muted">Scheduled backups only run while the server is online and use the safe hot-backup pipeline.</p>
        </Card>

        <div className="flex justify-end">
          <button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? <Spinner /> : <Save className="size-4" />} Save settings
          </button>
        </div>
      </div>

      <div className="space-y-5">
        <Card
          title="server.properties"
          padded={false}
          action={
            <div className="flex items-center gap-2">
              <input className="input py-1.5 text-xs" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <button className="btn-primary btn-sm" disabled={!Object.keys(edited).length || saveProps.isPending} onClick={() => saveProps.mutate()}>
                {saveProps.isPending ? <Spinner /> : <Save className="size-3.5" />} Save
              </button>
            </div>
          }
        >
          {props.isLoading ? (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          ) : (
            <div className="max-h-[70vh] overflow-y-auto">
              <table className="w-full text-sm">
                <tbody>
                  {keys.map((k) => (
                    <tr key={k} className="border-b border-line/60 last:border-0">
                      <td className="w-1/2 px-5 py-2 font-mono text-xs text-muted">
                        {k}
                        {k in edited && <span className="ml-2 inline-block size-1.5 rounded-full bg-amber-400 align-middle" />}
                      </td>
                      <td className="px-3 py-1.5">
                        {merged[k] === 'true' || merged[k] === 'false' ? (
                          <select className="input py-1 text-xs" value={merged[k]} onChange={(e) => setEdited({ ...edited, [k]: e.target.value })}>
                            <option value="true">true</option>
                            <option value="false">false</option>
                          </select>
                        ) : (
                          <input className="input py-1 font-mono text-xs" value={merged[k]} onChange={(e) => setEdited({ ...edited, [k]: e.target.value })} />
                        )}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td className="px-5 py-2">
                      <input className="input py-1 font-mono text-xs" placeholder="new-key" value={newKey} onChange={(e) => setNewKey(e.target.value.trim())} />
                    </td>
                    <td className="px-3 py-1.5">
                      <button
                        className="btn-secondary btn-sm"
                        disabled={!newKey || newKey in merged}
                        onClick={() => {
                          setEdited({ ...edited, [newKey]: '' });
                          setNewKey('');
                        }}
                      >
                        Add key
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Danger zone" className="border-rose-500/20">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Delete this server</p>
              <p className="text-xs text-muted">Stops the server and removes it from Blockhost.</p>
            </div>
            <div className="flex gap-2">
              <button className="btn-secondary btn-sm" onClick={() => setDel('keep')}>
                Remove, keep files
              </button>
              <button className="btn-danger btn-sm" onClick={() => setDel('files')}>
                <Trash2 className="size-3.5" /> Delete everything
              </button>
            </div>
          </div>
        </Card>
      </div>

      <ConfirmModal
        open={del !== null}
        onClose={() => setDel(null)}
        onConfirm={() => remove.mutate(del === 'files')}
        title={del === 'files' ? `Delete "${s.name}" and all its files?` : `Remove "${s.name}"?`}
        body={del === 'files' ? 'The world, configuration, plugins and backups will be permanently deleted. This cannot be undone.' : 'The server is removed from the dashboard. Its folder is kept on disk under servers/.deleted-… so you can recover it manually.'}
        confirmLabel={del === 'files' ? 'Delete everything' : 'Remove'}
        danger
        busy={remove.isPending}
      />
    </div>
  );
}

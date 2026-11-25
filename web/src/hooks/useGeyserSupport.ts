import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { GEYSER_TYPES, TYPE_LABEL, type ServerType } from '../lib/types';

type GeyserSupport = { supported: boolean | null; versions: string[]; range: string };

/** Whether the newest Geyser runs on this Minecraft version, and a reason to show when it does not. */
export function useGeyserSupport(type: ServerType, version: string) {
  const enabled = GEYSER_TYPES.includes(type) && !!version;
  const q = useQuery({
    queryKey: ['geyser-support', type, version],
    queryFn: () => api.get<GeyserSupport>(`/api/versions/geyser?type=${encodeURIComponent(type)}&version=${encodeURIComponent(version)}`),
    enabled,
    staleTime: 30 * 60_000,
  });
  const unsupported = enabled && q.data?.supported === false;
  const reason = unsupported ? `Not available on Minecraft ${version}: the newest Geyser for ${TYPE_LABEL[type]} supports ${q.data!.range}.` : null;
  return { unsupported, reason };
}

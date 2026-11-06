import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useEffect, useState, type CSSProperties } from 'react';
import { api } from '../lib/api';

/** The player's skin texture (a 64x64 or old 64x32 image), looked up once an hour. Null when none is known. */
export function useSkin(serverId: string, player: string) {
  const q = useQuery({
    queryKey: ['skin', serverId, player.toLowerCase()],
    queryFn: () => api.get<{ url: string | null }>(`/api/servers/${serverId}/players/${encodeURIComponent(player)}/skin`),
    staleTime: 60 * 60_000,
    retry: false,
  });
  const url = q.data?.url ?? null;
  // Old skins are half as tall and have no separate left limbs; we need the height to place the pieces.
  const [height, setHeight] = useState(64);
  useEffect(() => {
    if (!url) return;
    const img = new Image();
    img.onload = () => setHeight(img.naturalHeight === 32 ? 32 : 64);
    img.src = url;
  }, [url]);
  return { url, height };
}

/** One rectangle of the skin texture, drawn at `scale` screen pixels per texture pixel. */
function piece(url: string, texHeight: number, scale: number, tx: number, ty: number, w: number, h: number, x: number, y: number, mirror = false): CSSProperties {
  return {
    position: 'absolute',
    left: x * scale,
    top: y * scale,
    width: w * scale,
    height: h * scale,
    backgroundImage: `url(${url})`,
    backgroundSize: `${64 * scale}px ${texHeight * scale}px`,
    backgroundPosition: `-${tx * scale}px -${ty * scale}px`,
    imageRendering: 'pixelated',
    transform: mirror ? 'scaleX(-1)' : undefined,
  };
}

/** The player's face, hat layer included. Falls back to their initial. */
export function PlayerHead({ serverId, player, size = 28, className }: { serverId: string; player: string; size?: number; className?: string }) {
  const { url, height } = useSkin(serverId, player);
  const scale = size / 8;
  if (!url) {
    return (
      <div className={clsx('flex shrink-0 items-center justify-center rounded-md bg-white/10 font-semibold text-muted', className)} style={{ width: size, height: size, fontSize: size * 0.45 }}>
        {player.replace(/^\./, '').slice(0, 1).toUpperCase()}
      </div>
    );
  }
  return (
    <div className={clsx('relative shrink-0 overflow-hidden rounded-md', className)} style={{ width: size, height: size }}>
      <div style={piece(url, height, scale, 8, 8, 8, 8, 0, 0)} />
      <div style={piece(url, height, scale, 40, 8, 8, 8, 0, 0)} />
    </div>
  );
}

/** The player seen from the front, like the figure in Minecraft's inventory screen: 16 by 32 texture pixels. */
export function PlayerBody({ serverId, player, scale = 5 }: { serverId: string; player: string; scale?: number }) {
  const { url, height } = useSkin(serverId, player);
  const box = { width: 16 * scale, height: 32 * scale };
  if (!url) {
    return (
      <div className="flex items-center justify-center text-4xl font-semibold text-white/30" style={box}>
        {player.replace(/^\./, '').slice(0, 1).toUpperCase()}
      </div>
    );
  }
  const modern = height === 64;
  const p = (tx: number, ty: number, w: number, h: number, x: number, y: number, mirror = false) => <div style={piece(url, height, scale, tx, ty, w, h, x, y, mirror)} />;
  return (
    <div className="relative" style={box}>
      {p(8, 8, 8, 8, 4, 0)}
      {p(20, 20, 8, 12, 4, 8)}
      {p(44, 20, 4, 12, 0, 8)}
      {modern ? p(36, 52, 4, 12, 12, 8) : p(44, 20, 4, 12, 12, 8, true)}
      {p(4, 20, 4, 12, 4, 20)}
      {modern ? p(20, 52, 4, 12, 8, 20) : p(4, 20, 4, 12, 8, 20, true)}
      {/* second layer: hat, and on modern skins jacket, sleeves and trousers */}
      {p(40, 8, 8, 8, 4, 0)}
      {modern && (
        <>
          {p(20, 36, 8, 12, 4, 8)}
          {p(44, 36, 4, 12, 0, 8)}
          {p(52, 52, 4, 12, 12, 8)}
          {p(4, 36, 4, 12, 4, 20)}
          {p(4, 52, 4, 12, 8, 20)}
        </>
      )}
    </div>
  );
}

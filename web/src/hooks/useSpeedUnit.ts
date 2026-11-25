import { useEffect, useState } from 'react';

/** How download speeds are shown: megabytes per second (file sizes) or megabits per second (how internet plans are sold). */
export type SpeedUnit = 'bytes' | 'bits';

const KEY = 'blockhost.speedUnit';
const EVENT = 'blockhost:speedUnit';
const read = (): SpeedUnit => (localStorage.getItem(KEY) === 'bits' ? 'bits' : 'bytes');

/** Saved in this browser; every open panel follows a change. */
export function useSpeedUnit(): [SpeedUnit, (u: SpeedUnit) => void] {
  const [unit, setUnit] = useState<SpeedUnit>(read);
  useEffect(() => {
    const sync = () => setUnit(read());
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  const set = (u: SpeedUnit) => {
    localStorage.setItem(KEY, u);
    window.dispatchEvent(new Event(EVENT));
  };
  return [unit, set];
}

/** A clock that ticks once a second while `on`, so elapsed and remaining times move between server updates. */
export function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

import { EventEmitter } from 'node:events';

export type BusEvent =
  | { type: 'server.state'; id: string; state: string; detail?: string }
  | { type: 'server.log'; id: string; line: string }
  | { type: 'server.progress'; id: string; pct: number | null; message: string; done?: boolean; error?: string }
  | { type: 'server.stats'; id: string; sample: unknown }
  | { type: 'server.players'; id: string; players: unknown }
  | { type: 'server.changed'; id?: string }
  | { type: 'playit'; status: unknown }
  | { type: 'backup.changed'; id: string }
  | { type: 'toast'; level: 'info' | 'success' | 'error'; message: string };

class Bus extends EventEmitter {
  publish(ev: BusEvent) {
    this.emit('event', ev);
  }
}
export const bus = new Bus();
bus.setMaxListeners(100);

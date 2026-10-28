import { useEffect, useRef } from 'react';
import type { WsEvent } from './types';

type Listener = (ev: WsEvent) => void;

class WsClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private subs = new Set<string>();
  private retry = 0;
  private timer: number | null = null;
  private enabled = false;
  connected = false;

  start() {
    if (this.enabled) return;
    this.enabled = true;
    this.connect();
  }

  stop() {
    this.enabled = false;
    if (this.timer) window.clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }

  private connect() {
    if (!this.enabled) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.connected = true;
      for (const id of this.subs) ws.send(JSON.stringify({ type: 'subscribe', id }));
      this.emit({ type: 'pong' });
    };
    ws.onmessage = (m) => {
      try {
        this.emit(JSON.parse(m.data) as WsEvent);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = (e) => {
      this.connected = false;
      this.ws = null;
      if (e.code === 4401) {
        window.dispatchEvent(new CustomEvent('mcsm:unauthorized'));
        return;
      }
      if (!this.enabled) return;
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      this.timer = window.setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  private emit(ev: WsEvent) {
    for (const l of this.listeners) l(ev);
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  subscribeLogs(id: string) {
    this.subs.add(id);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'subscribe', id }));
    return () => {
      this.subs.delete(id);
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'unsubscribe', id }));
    };
  }
}

export const ws = new WsClient();

/** Subscribe to websocket events for the lifetime of a component. */
export function useWsEvent(handler: Listener) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const off = ws.on((ev) => ref.current(ev));
    return () => {
      off();
    };
  }, []);
}

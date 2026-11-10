import { useEffect, useRef } from 'react';
import type { WsEvent } from './types';

type Listener = (ev: WsEvent) => void;

/** How often the client pings, and how long it waits for any message before it treats the socket as dead. */
const PING_EVERY_MS = 15_000;
const DEAD_AFTER_MS = 40_000;

class WsClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private subs = new Set<string>();
  private retry = 0;
  private timer: number | null = null;
  private heartbeat: number | null = null;
  private lastMessage = 0;
  private enabled = false;
  connected = false;

  constructor() {
    // After sleep, a network change or a hidden tab, the old socket may be dead without ever closing; check at once.
    window.addEventListener('online', () => this.reconnect());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.check();
    });
  }

  start() {
    if (this.enabled) return;
    this.enabled = true;
    this.connect();
  }

  stop() {
    this.enabled = false;
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = null;
    this.drop();
  }

  /** Detach and close the current socket so its late events cannot touch the next one. */
  private drop() {
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    if (this.heartbeat) window.clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }

  /** Replace the socket now (it is dead or the network changed). Subscriptions are resent and backlogs refetched. */
  private reconnect() {
    if (!this.enabled) return;
    if (this.timer) window.clearTimeout(this.timer);
    this.timer = null;
    this.drop();
    this.connect();
  }

  /** The socket has gone quiet for too long: no pong, no events. A half-open connection never fires onclose. */
  private check() {
    if (!this.enabled) return;
    if (!this.ws) return; // a reconnect is already scheduled
    if (this.ws.readyState === WebSocket.OPEN && Date.now() - this.lastMessage > DEAD_AFTER_MS) this.reconnect();
    else if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'ping' }));
  }

  private connect() {
    if (!this.enabled) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    this.lastMessage = Date.now();
    ws.onopen = () => {
      this.retry = 0;
      this.connected = true;
      this.lastMessage = Date.now();
      for (const id of this.subs) ws.send(JSON.stringify({ type: 'subscribe', id }));
      this.heartbeat = window.setInterval(() => this.check(), PING_EVERY_MS);
      this.emit({ type: 'pong' });
    };
    ws.onmessage = (m) => {
      this.lastMessage = Date.now();
      let ev: WsEvent;
      try {
        ev = JSON.parse(m.data) as WsEvent;
      } catch {
        return;
      }
      this.emit(ev);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return; // an older socket closing after it was replaced
      this.drop();
      if (e.code === 4401) {
        window.dispatchEvent(new CustomEvent('mcsm:unauthorized'));
        return;
      }
      if (!this.enabled) return;
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      this.timer = window.setTimeout(() => {
        this.timer = null;
        this.connect();
      }, delay);
    };
    ws.onerror = () => ws.close();
  }

  /** One listener throwing must not stop the others (such as the console) from getting the event. */
  private emit(ev: WsEvent) {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch (e) {
        console.error('websocket listener failed', e);
      }
    }
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

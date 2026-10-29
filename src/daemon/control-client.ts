// INPUT: The msd control socket path, method calls and server event listeners.
// OUTPUT: A correlated v1 request client with fixed-code rejections and event delivery.
// POS: Shared client for ms CLI and adapters; no retries, identity proof or method semantics.
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { createIpcDecoder, encodeIpcFrame } from '../bridge/ipc-frame.ts';

type Waiter = Readonly<{ resolve: (value: unknown) => void; reject: (error: Error) => void }>;
export type ControlClient = Readonly<{ request: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  onEvent: (listener: (event: string, data: unknown) => void) => () => void; close: () => void; whenClosed: Promise<void> }>;

function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function connectControl(path: string): Promise<ControlClient> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    const decoder = createIpcDecoder();
    const closed = Promise.withResolvers<void>();
    let waiters = new Map<string, Waiter>();
    let listeners: ReadonlyArray<(event: string, data: unknown) => void> = [];
    const shutdown = () => {
      for (const waiter of waiters.values()) waiter.reject(new Error('CONTROL_CLOSED'));
      waiters = new Map(); closed.resolve();
    };
    const receive = (value: unknown) => {
      if (!plain(value) || value.schemaVersion !== 1) { socket.destroy(); return; }
      if (typeof value.event === 'string') { for (const listener of listeners) listener(value.event, value.data); return; }
      const waiter = typeof value.id === 'string' ? waiters.get(value.id) : undefined;
      if (!waiter) return;
      waiters = new Map([...waiters].filter(([id]) => id !== value.id));
      if (value.ok === true) waiter.resolve(value.result);
      else waiter.reject(new Error(typeof value.error === 'string' ? value.error : 'INTERNAL_ERROR'));
    };
    socket.once('error', error => { reject(error); shutdown(); });
    socket.on('close', shutdown);
    socket.on('data', chunk => {
      try { for (const value of decoder.push(chunk)) receive(value); } catch { socket.destroy(); }
    });
    socket.once('connect', () => resolve(Object.freeze({
      request: (method: string, params: Record<string, unknown> = {}) => {
        const id = randomUUID();
        const waiter = Promise.withResolvers<unknown>();
        waiters = new Map([...waiters, [id, Object.freeze({ resolve: waiter.resolve, reject: waiter.reject })]]);
        try { socket.write(encodeIpcFrame({ schemaVersion: 1, id, method, params })); }
        catch (error) { waiters = new Map([...waiters].filter(([key]) => key !== id)); waiter.reject(error as Error); }
        return waiter.promise;
      },
      onEvent: (listener: (event: string, data: unknown) => void) => {
        listeners = [...listeners, listener];
        return () => { listeners = listeners.filter(item => item !== listener); };
      },
      close: () => socket.destroy(), whenClosed: closed.promise })));
  });
}

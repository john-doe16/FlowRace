import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../shared/protocol.ts';

export type NetStatus = 'connecting' | 'online' | 'offline' | 'replaced';

/** WebSocket wrapper with automatic reconnect and server clock sync. */
export class Net {
  onMessage: (msg: ServerMessage) => void = () => {};
  onStatus: (status: NetStatus) => void = () => {};

  private ws: WebSocket | null = null;
  private retryMs = 500;
  private stopped = false;
  private offset = 0;
  private readonly url: string;
  private readonly hello: () => { name: string; token?: string };
  private readonly saveToken: (token: string) => void;

  constructor(url: string, hello: () => { name: string; token?: string }, saveToken: (token: string) => void) {
    this.url = url;
    this.hello = hello;
    this.saveToken = saveToken;
  }

  /** Server time estimate in ms; all match deadlines are in server time. */
  now(): number {
    return Date.now() + this.offset;
  }

  connect(): void {
    this.stopped = false;
    this.onStatus('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 500;
      const { name, token } = this.hello();
      this.send({ type: 'hello', v: PROTOCOL_VERSION, name, token });
    };
    ws.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        return;
      }
      if (msg.type === 'welcome') {
        this.saveToken(msg.token);
        this.syncClock(msg.serverNow);
        this.onStatus('online');
      } else if (msg.type === 'match.state') {
        this.syncClock(msg.serverNow);
      } else if (msg.type === 'error' && msg.code === 'replaced') {
        // Another tab took over; don't fight it by reconnecting.
        this.stopped = true;
        ws.close();
        this.onStatus('replaced');
      }
      this.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      this.onStatus('offline');
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 5000);
    };
  }

  /** Closes and immediately reconnects, e.g. after a name change. */
  reconnect(): void {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.connect();
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private syncClock(serverNow: number): void {
    // Ignores one-way latency; good to within a few tens of ms.
    this.offset = serverNow - Date.now();
  }
}

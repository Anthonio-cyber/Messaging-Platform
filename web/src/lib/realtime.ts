import { io, type Socket } from 'socket.io-client';
import { api, API_BASE, type ApiMessage, type AppNotification } from './api';

/**
 * Realtime transport.
 *
 * Veylo prefers a WebSocket, which gives true push, typing indicators and presence. Serverless
 * hosts cannot hold one open, so when the socket does not connect the client falls back to
 * polling `/api/sync` and feeds the results through the same handlers. Everything downstream
 * is written against these event names and never needs to know which transport delivered them.
 *
 * The visible difference in polling mode: messages arrive within a few seconds rather than
 * instantly, and typing indicators and live presence are unavailable. `describeTransport()`
 * reports which mode is active so the UI can say so plainly.
 */

export type RealtimeEvent =
  | 'message:new'
  | 'message:updated'
  | 'message:deleted'
  | 'message:read'
  | 'message:delivered'
  | 'typing:update'
  | 'presence:update'
  | 'conversation:new'
  | 'conversation:updated'
  | 'conversation:removed'
  | 'request:new'
  | 'request:accepted'
  | 'request:resolved'
  | 'notification:new';

export type RealtimeHandlers = Partial<Record<RealtimeEvent, (payload: never) => void>>;

export type TransportMode = 'connecting' | 'socket' | 'polling' | 'offline';

interface SyncResponse {
  now: string;
  messages: Array<{ conversationId: string; message: ApiMessage }>;
  deleted: Array<{ conversationId: string; messageId: string }>;
  notifications: AppNotification[];
  pendingRequests: number;
  revision: string;
}

const POLL_VISIBLE_MS = 3000;
const POLL_HIDDEN_MS = 20_000;
/** How long to wait for a WebSocket before deciding the host cannot hold one. */
const SOCKET_GRACE_MS = 6000;

class RealtimeClient {
  private socket: Socket | null = null;
  private handlers: RealtimeHandlers = {};
  private mode: TransportMode = 'connecting';
  private onModeChange: ((mode: TransportMode) => void) | null = null;

  private pollTimer: number | undefined;
  private graceTimer: number | undefined;
  private cursor: string | null = null;
  private revision: string | null = null;
  private polling = false;
  private stopped = true;

  start(handlers: RealtimeHandlers, onModeChange?: (mode: TransportMode) => void): void {
    this.handlers = handlers;
    this.onModeChange = onModeChange ?? null;
    this.stopped = false;
    this.setMode('connecting');
    this.connectSocket();

    // If the socket has not connected by now, this host cannot hold one. Start polling.
    this.graceTimer = window.setTimeout(() => {
      if (this.mode !== 'socket') this.startPolling();
    }, SOCKET_GRACE_MS);

    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  stop(): void {
    this.stopped = true;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.clearTimeout(this.graceTimer);
    window.clearTimeout(this.pollTimer);
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    this.cursor = null;
    this.revision = null;
    this.setMode('offline');
  }

  getMode(): TransportMode {
    return this.mode;
  }

  /** True when the transport can carry ephemeral signals like typing indicators. */
  supportsEphemeral(): boolean {
    return this.mode === 'socket';
  }

  emit(event: string, payload: unknown): void {
    if (this.mode === 'socket') this.socket?.emit(event, payload);
    // Polling mode has no upstream channel; typing and presence are simply unavailable.
  }

  /** Pulls immediately instead of waiting for the next tick — used right after sending. */
  nudge(): void {
    if (this.mode === 'polling') void this.poll();
  }

  private setMode(mode: TransportMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.onModeChange?.(mode);
  }

  private connectSocket(): void {
    const socket = io(API_BASE || window.location.origin, {
      path: '/realtime',
      withCredentials: true,
      transports: ['websocket'],
      // One honest attempt: if the host cannot hold a socket, retrying forever only burns
      // battery and log noise. Polling takes over instead.
      reconnection: true,
      reconnectionAttempts: 3,
      reconnectionDelay: 1000,
      timeout: 5000,
    });
    this.socket = socket;

    socket.on('connect', () => {
      window.clearTimeout(this.pollTimer);
      this.polling = false;
      this.setMode('socket');
    });
    socket.on('disconnect', () => {
      if (!this.stopped) this.startPolling();
    });
    socket.on('connect_error', () => {
      if (!this.stopped) this.startPolling();
    });

    for (const [event, handler] of Object.entries(this.handlers)) {
      socket.on(event, handler as (payload: unknown) => void);
    }
  }

  private startPolling(): void {
    if (this.stopped || this.polling) return;
    this.polling = true;
    this.setMode('polling');
    void this.poll();
  }

  private onVisibilityChange = (): void => {
    if (this.mode === 'polling' && document.visibilityState === 'visible') void this.poll();
  };

  private schedulePoll(): void {
    window.clearTimeout(this.pollTimer);
    if (this.stopped || this.mode !== 'polling') return;
    const delay = document.visibilityState === 'visible' ? POLL_VISIBLE_MS : POLL_HIDDEN_MS;
    this.pollTimer = window.setTimeout(() => void this.poll(), delay);
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    window.clearTimeout(this.pollTimer);

    try {
      const query = this.cursor ? `?since=${encodeURIComponent(this.cursor)}` : '';
      const response = await api.get<SyncResponse>(`/api/sync${query}`);
      this.cursor = response.now;

      const call = (event: RealtimeEvent, payload: unknown) => {
        (this.handlers[event] as ((value: unknown) => void) | undefined)?.(payload);
      };

      for (const entry of response.messages) call('message:new', entry);
      for (const entry of response.deleted) call('message:deleted', entry);
      for (const notification of response.notifications) call('notification:new', notification);

      // Membership or conversation metadata moved: let the sidebar refetch itself.
      if (this.revision !== null && response.revision !== this.revision) {
        call('conversation:updated', { conversationId: '' });
      }
      this.revision = response.revision;

      if (response.pendingRequests > 0) call('request:new', { pending: response.pendingRequests });
    } catch {
      // A failed poll is not fatal; the next tick retries.
    } finally {
      this.schedulePoll();
    }
  }
}

export const realtime = new RealtimeClient();

export function describeTransport(mode: TransportMode): { label: string; detail: string } | null {
  if (mode === 'polling') {
    return {
      label: 'Checking for messages every few seconds',
      detail:
        'This deployment cannot hold a live connection, so new messages arrive within a few seconds instead of instantly. Typing indicators and live presence are unavailable.',
    };
  }
  if (mode === 'offline') {
    return { label: 'Disconnected', detail: 'Trying to reach Veylo again.' };
  }
  return null;
}

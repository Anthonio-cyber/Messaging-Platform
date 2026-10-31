import { io, type Socket } from 'socket.io-client';
import { API_BASE } from './api';

let socket: Socket | null = null;

/**
 * One socket per tab, authenticated by the session cookie during the handshake.
 * Reconnection is handled by socket.io; on reconnect the server re-sends delivery state, so
 * nothing is lost while a device is offline.
 */
export function connectSocket(): Socket {
  if (socket?.connected) return socket;
  if (!socket) {
    socket = io(API_BASE || window.location.origin, {
      path: '/realtime',
      withCredentials: true,
      transports: ['websocket', 'polling'],
      reconnectionDelay: 800,
      reconnectionDelayMax: 8000,
      timeout: 15_000,
    });
  }
  if (!socket.connected) socket.connect();
  return socket;
}

export function getSocket(): Socket | null {
  return socket;
}

export function disconnectSocket(): void {
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
}

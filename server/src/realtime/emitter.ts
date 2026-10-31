import type { Server as SocketServer } from 'socket.io';

/**
 * Indirection so services can publish realtime events without importing the socket
 * bootstrap (and without a circular dependency). Before the server is attached — during
 * tests, or a migration/CLI run — emits are no-ops.
 */
let io: SocketServer | null = null;

export function attachRealtime(server: SocketServer): void {
  io = server;
}

/** Every connected device of a user joins the room `user:<id>`. */
export function userRoom(userId: string): string {
  return `user:${userId}`;
}

export function conversationRoom(conversationId: string): string {
  return `conversation:${conversationId}`;
}

export function emitToUser(userId: string, event: string, payload: unknown): void {
  io?.to(userRoom(userId)).emit(event, payload);
}

export function emitToUsers(userIds: readonly string[], event: string, payload: unknown): void {
  if (!io || userIds.length === 0) return;
  io.to(userIds.map(userRoom)).emit(event, payload);
}

export function emitToConversation(
  conversationId: string,
  event: string,
  payload: unknown,
  exceptSocketId?: string,
): void {
  if (!io) return;
  const target = io.to(conversationRoom(conversationId));
  if (exceptSocketId) target.except(exceptSocketId).emit(event, payload);
  else target.emit(event, payload);
}

/** Forces every socket belonging to a session to disconnect (sign-out everywhere, bans). */
export async function disconnectUserSockets(userId: string): Promise<void> {
  if (!io) return;
  const sockets = await io.in(userRoom(userId)).fetchSockets();
  for (const socket of sockets) socket.disconnect(true);
}

export async function isUserOnline(userId: string): Promise<boolean> {
  if (!io) return false;
  const sockets = await io.in(userRoom(userId)).fetchSockets();
  return sockets.length > 0;
}

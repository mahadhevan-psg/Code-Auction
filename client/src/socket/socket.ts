import { io, Socket } from 'socket.io-client';

/**
 * One shared connection. The session id is re-read on every (re)connect, so a reconnecting
 * client is re-attached to its team room automatically; after login call `authenticateSocket()`.
 */
export const socket: Socket = io({
  autoConnect: true,
  withCredentials: true,
  auth: (cb) => {
    let sessionId: string | null = null;
    try { sessionId = localStorage.getItem('sessionId'); } catch { /* storage blocked */ }
    cb({ sessionId });
  }
});

export function authenticateSocket(sessionId: string | null) {
  if (!sessionId) return;
  if (socket.connected) socket.emit('auth', { sessionId });
}

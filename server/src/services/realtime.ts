import { Server as SocketIOServer, Socket } from 'socket.io';
import { db } from '../db/database.js';

/**
 * Socket.IO wrapper. Sockets authenticate with their session id and are placed in rooms:
 *   team:<id>   – everyone on a team
 *   role:<ROLE> – FIRST_YEAR / SENIOR / ADMIN
 *   admin       – administrators
 *   session:<id>
 * It validates sessions straight from the DB so it has no dependency on the services layer.
 */
export class Realtime {
  private static io: SocketIOServer | null = null;
  private static sessionSockets = new Map<string, Set<string>>();
  private static onMultiTab: ((sessionId: string) => void) | null = null;

  static init(io: SocketIOServer, hooks: {
    onHeartbeat?: (sessionId: string, data: any) => void;
    onMultiTab?: (sessionId: string) => void;
    getState: () => unknown;
  }) {
    this.io = io;
    this.onMultiTab = hooks.onMultiTab || null;

    io.on('connection', (socket: Socket) => {
      socket.emit('round:state', hooks.getState());

      const authenticate = (sessionId?: string) => {
        if (!sessionId) return false;
        const s = db.prepare('SELECT session_id, team_id, role FROM sessions WHERE session_id = ? AND expires_at > ?')
          .get(sessionId, new Date().toISOString()) as any;
        if (!s) return false;

        socket.data.sessionId = s.session_id;
        socket.data.teamId = s.team_id;
        socket.data.role = s.role;
        socket.join(`session:${s.session_id}`);
        socket.join(`role:${s.role}`);
        if (s.role === 'ADMIN') socket.join('admin');
        else socket.join(`team:${s.team_id}`);

        let set = this.sessionSockets.get(s.session_id);
        if (!set) { set = new Set(); this.sessionSockets.set(s.session_id, set); }
        set.add(socket.id);

        // Two live sockets for one participant session = a second tab/window. Debounced to ignore reloads.
        if (s.role !== 'ADMIN' && set.size > 1) {
          const sid = s.session_id;
          setTimeout(() => {
            if ((this.sessionSockets.get(sid)?.size ?? 0) > 1) this.onMultiTab?.(sid);
          }, 4000);
        }
        return true;
      };

      authenticate(socket.handshake.auth?.sessionId);

      socket.on('auth', (payload: { sessionId?: string }, ack?: (ok: boolean) => void) => {
        const ok = authenticate(payload?.sessionId);
        if (typeof ack === 'function') ack(ok);
      });

      socket.on('proctor:heartbeat', (data: any) => {
        if (socket.data.sessionId && socket.data.role !== 'ADMIN') {
          hooks.onHeartbeat?.(socket.data.sessionId, data);
        }
      });

      socket.on('disconnect', () => {
        const sid = socket.data.sessionId as string | undefined;
        if (!sid) return;
        const set = this.sessionSockets.get(sid);
        if (set) {
          set.delete(socket.id);
          if (set.size === 0) this.sessionSockets.delete(sid);
        }
      });
    });
  }

  static emitAll(event: string, data?: unknown) { this.io?.emit(event, data); }
  static emitTeam(teamId: string, event: string, data?: unknown) { this.io?.to(`team:${teamId}`).emit(event, data); }
  static emitRole(role: string, event: string, data?: unknown) { this.io?.to(`role:${role}`).emit(event, data); }
  static emitAdmin(event: string, data?: unknown) { this.io?.to('admin').emit(event, data); }
  static emitSession(sessionId: string, event: string, data?: unknown) { this.io?.to(`session:${sessionId}`).emit(event, data); }

  static isSessionConnected(sessionId: string): boolean {
    return (this.sessionSockets.get(sessionId)?.size ?? 0) > 0;
  }

  static connectedSessionIds(): Set<string> {
    return new Set(this.sessionSockets.keys());
  }

  /** Drop every socket belonging to a revoked session. */
  static kickSession(sessionId: string, reason: string) {
    this.io?.to(`session:${sessionId}`).emit('session:revoked', { reason });
  }
}

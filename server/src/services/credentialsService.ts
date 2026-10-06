import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { db, audit, uid, transaction, credentialsHasLegacyPlaintext } from '../db/database.js';
import { Realtime } from './realtime.js';
import { SettingsService } from './settingsService.js';

export type ParticipantRole = 'FIRST_YEAR' | 'SENIOR';

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ONLINE_WINDOW_MS = 45_000;
// No look-alike characters (0/O, 1/I/L) so the code can be read out loud.
const PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generatePassword(): string {
  const pick = () => PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  const group = () => Array.from({ length: 4 }, pick).join('');
  return `${group()}-${group()}`;
}

function isRole(role: unknown): role is ParticipantRole {
  return role === 'FIRST_YEAR' || role === 'SENIOR';
}

export class CredentialsService {
  /* ---------------- participant: request a password ---------------- */

  static requestPassword(teamId: string, role: string, pin?: string) {
    if (!teamId || typeof teamId !== 'string') throw new Error('Team ID is required.');
    if (!isRole(role)) throw new Error(`Invalid role '${role}'.`);

    const team = db.prepare("SELECT team_id, status FROM teams WHERE team_id = ?").get(teamId) as any;
    if (!team) throw new Error(`Team '${teamId}' is not registered.`);
    if (team.status !== 'ACTIVE') throw new Error('This team is not active in the event.');

    const cfg = SettingsService.getConfig();
    if (cfg.eventPin && (pin || '').trim() !== cfg.eventPin) {
      audit(`${teamId}:${role}`, 'REQUEST_PASSWORD_BAD_PIN', teamId);
      throw new Error('Incorrect event PIN.');
    }

    this.expireStale();

    const existing = db.prepare("SELECT * FROM login_requests WHERE team_id = ? AND role = ? AND status IN ('PENDING','ISSUED') ORDER BY requested_at DESC LIMIT 1")
      .get(teamId, role) as any;
    if (existing) return this.publicRequest(existing);

    const requestId = uid('req');
    db.prepare("INSERT INTO login_requests (request_id, team_id, role, requested_at, status) VALUES (?, ?, ?, ?, 'PENDING')")
      .run(requestId, teamId, role, new Date().toISOString());
    audit(`${teamId}:${role}`, 'REQUEST_PASSWORD', requestId);

    const row = db.prepare('SELECT * FROM login_requests WHERE request_id = ?').get(requestId) as any;
    Realtime.emitAdmin('admin:login_request', this.adminRequestView(row));
    return this.publicRequest(row);
  }

  static getRequestStatus(requestId?: string) {
    if (!requestId) return { status: 'NONE' };
    this.expireStale();
    const row = db.prepare('SELECT * FROM login_requests WHERE request_id = ?').get(requestId) as any;
    if (!row) return { status: 'NONE' };
    return this.publicRequest(row);
  }

  private static publicRequest(row: any) {
    let expiresAt: string | null = null;
    if (row.credential_id) {
      const c = db.prepare('SELECT expires_at FROM temporary_credentials WHERE credential_id = ?').get(row.credential_id) as any;
      expiresAt = c?.expires_at ?? null;
    }
    return {
      status: row.status as string,
      requestId: row.request_id as string,
      teamId: row.team_id as string,
      role: row.role as string,
      requestedAt: row.requested_at as string,
      sessionId: row.session_id as string | undefined,
      expiresAt
    };
  }

  private static adminRequestView(row: any) {
    const t = db.prepare('SELECT team_name FROM teams WHERE team_id = ?').get(row.team_id) as any;
    return { ...row, team_name: t?.team_name ?? '' };
  }

  /* ---------------- admin: approve / issue / reject ---------------- */

  /** Directly approves access and creates an active session for the participant. */
  static approveAccess(requestId: string, adminActor: string) {
    const req = db.prepare('SELECT * FROM login_requests WHERE request_id = ?').get(requestId) as any;
    if (!req) throw new Error('Login request not found.');
    if (req.status === 'APPROVED' || req.status === 'USED') {
      throw new Error('This access request has already been approved.');
    }

    const cfg = SettingsService.getConfig();
    const limit = req.role === 'FIRST_YEAR' ? cfg.maxSessionsFirstYear : cfg.maxSessionsSenior;
    const nowIso = new Date().toISOString();
    const active = db.prepare('SELECT COUNT(*) AS cnt FROM sessions WHERE team_id = ? AND role = ? AND expires_at > ?')
      .get(req.team_id, req.role, nowIso) as { cnt: number };

    if (active.cnt >= limit) {
      throw new Error(`Team ${req.team_id} already has ${active.cnt} active ${req.role === 'FIRST_YEAR' ? 'first-year' : 'senior'} session(s) (limit: ${limit}). Revoke a session first.`);
    }

    const sessionId = `sess_${crypto.randomBytes(24).toString('hex')}`;
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

    transaction(() => {
      db.prepare('INSERT INTO sessions (session_id, team_id, role, created_at, expires_at, last_seen, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(sessionId, req.team_id, req.role, nowIso, expiresAt, nowIso, 'approved-by-admin');
      db.prepare("UPDATE login_requests SET status = 'APPROVED', session_id = ? WHERE request_id = ?")
        .run(sessionId, requestId);
      audit(adminActor, 'APPROVE_ACCESS_REQUEST', `${req.team_id}:${req.role}`, { requestId, sessionId });
    });

    Realtime.emitAdmin('admin:session_change', { type: 'login', teamId: req.team_id, role: req.role });
    Realtime.emitAll('auth:approved', { requestId, teamId: req.team_id, role: req.role, sessionId });

    return {
      requestId,
      sessionId,
      teamId: req.team_id as string,
      role: req.role as string
    };
  }

  /** Legacy: Returns the plaintext password exactly once. */
  static issuePassword(requestId: string, adminActor: string) {
    return this.approveAccess(requestId, adminActor);
  }

  static rejectRequest(requestId: string, adminActor: string) {
    const req = db.prepare('SELECT * FROM login_requests WHERE request_id = ?').get(requestId) as any;
    if (!req) throw new Error('Login request not found.');
    if (req.status === 'USED' || req.status === 'APPROVED') throw new Error('This request was already approved.');

    transaction(() => {
      if (req.credential_id) {
        db.prepare('UPDATE temporary_credentials SET revoked_at = ? WHERE credential_id = ? AND used_at IS NULL')
          .run(new Date().toISOString(), req.credential_id);
      }
      db.prepare("UPDATE login_requests SET status = 'REJECTED' WHERE request_id = ?").run(requestId);
      audit(adminActor, 'REJECT_ACCESS_REQUEST', `${req.team_id}:${req.role}`, { requestId });
    });
    Realtime.emitAll('auth:rejected', { requestId, teamId: req.team_id, role: req.role });
  }

  /* ---------------- participant: log in with the password ---------------- */

  static async login(teamId: string, role: string, password: string, ip: string) {
    if (!teamId || !password) throw new Error('Team ID and password are required.');
    if (!isRole(role)) throw new Error(`Invalid role '${role}'.`);
    const normalized = password.trim().toUpperCase();

    const nowIso = new Date().toISOString();
    const candidates = db.prepare(`
      SELECT * FROM temporary_credentials
      WHERE team_id = ? AND role = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
      ORDER BY issued_at DESC
    `).all(teamId, role, nowIso) as any[];

    let matched: any = null;
    for (const cand of candidates) {
      if (await bcrypt.compare(normalized, cand.password_hash)) { matched = cand; break; }
    }
    if (!matched) {
      audit(`${teamId}:${role}`, 'LOGIN_FAILED', teamId, { ip });
      throw new Error('Invalid, expired or already-used password. Request a new one.');
    }

    const cfg = SettingsService.getConfig();
    const limit = role === 'FIRST_YEAR' ? cfg.maxSessionsFirstYear : cfg.maxSessionsSenior;
    const active = db.prepare('SELECT COUNT(*) AS cnt FROM sessions WHERE team_id = ? AND role = ? AND expires_at > ?')
      .get(teamId, role, nowIso) as { cnt: number };
    if (active.cnt >= limit) {
      audit(`${teamId}:${role}`, 'LOGIN_BLOCKED_SESSION_LIMIT', teamId, { limit });
      throw new Error(`This team already has ${limit} active ${role === 'FIRST_YEAR' ? 'first-year' : 'senior'} session(s). Ask the administrator to log one out.`);
    }

    const sessionId = `sess_${crypto.randomBytes(24).toString('hex')}`;
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

    // Consume the password atomically so two simultaneous logins cannot both succeed.
    transaction(() => {
      const res = db.prepare('UPDATE temporary_credentials SET used_at = ? WHERE credential_id = ? AND used_at IS NULL')
        .run(nowIso, matched.credential_id) as any;
      if (!res.changes) throw new Error('This password has already been used.');
      db.prepare('INSERT INTO sessions (session_id, team_id, role, created_at, expires_at, last_seen, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(sessionId, teamId, role, nowIso, expiresAt, nowIso, ip);
      db.prepare("UPDATE login_requests SET status = 'USED', session_id = ? WHERE credential_id = ?").run(sessionId, matched.credential_id);
      audit(`${teamId}:${role}`, 'PASSWORD_USED', matched.credential_id);
      audit(`${teamId}:${role}`, 'LOGIN', sessionId, { ip });
    });

    Realtime.emitAdmin('admin:session_change', { type: 'login', teamId, role });
    return { sessionId, teamId, role };
  }

  static createAdminSession(ip: string) {
    const sessionId = `adm_${crypto.randomBytes(24).toString('hex')}`;
    const nowIso = new Date().toISOString();
    db.prepare('INSERT INTO sessions (session_id, team_id, role, created_at, expires_at, last_seen, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sessionId, 'ADMIN', 'ADMIN', nowIso, new Date(Date.now() + SESSION_TTL_MS).toISOString(), nowIso, ip);
    audit('ADMIN', 'ADMIN_LOGIN', sessionId, { ip });
    return { sessionId, teamId: 'ADMIN', role: 'ADMIN' as const };
  }

  /* ---------------- sessions ---------------- */

  static getSession(sessionId: string) {
    const nowIso = new Date().toISOString();
    const session = db.prepare('SELECT * FROM sessions WHERE session_id = ? AND expires_at > ?').get(sessionId, nowIso) as any;
    if (session) {
      // Avoid a write on every request.
      const last = Date.parse(session.last_seen || '') || 0;
      if (Date.now() - last > 5000) {
        db.prepare('UPDATE sessions SET last_seen = ? WHERE session_id = ?').run(nowIso, sessionId);
      }
    }
    return session;
  }

  static acknowledgeRules(sessionId: string) {
    db.prepare('UPDATE sessions SET rules_ack_at = ? WHERE session_id = ? AND rules_ack_at IS NULL')
      .run(new Date().toISOString(), sessionId);
  }

  static updateHeartbeat(sessionId: string, data: { fullscreen?: boolean; focused?: boolean }) {
    db.prepare('UPDATE sessions SET last_heartbeat = ?, last_seen = ?, fullscreen = ?, focused = ? WHERE session_id = ?')
      .run(new Date().toISOString(), new Date().toISOString(), data.fullscreen ? 1 : 0, data.focused ? 1 : 0, sessionId);
  }

  static revokeSession(sessionId: string, actor: string, action = 'FORCE_LOGOUT') {
    const s = db.prepare('SELECT team_id, role FROM sessions WHERE session_id = ?').get(sessionId) as any;
    db.prepare('UPDATE sessions SET expires_at = ? WHERE session_id = ?').run(new Date().toISOString(), sessionId);
    audit(actor, action, sessionId, s ? { teamId: s.team_id, role: s.role } : undefined);
    Realtime.kickSession(sessionId, action === 'FORCE_LOGOUT' ? 'An administrator logged you out.' : 'Logged out.');
    Realtime.emitAdmin('admin:session_change', { type: 'logout', teamId: s?.team_id, role: s?.role });
  }

  static getActiveSessions() {
    const nowIso = new Date().toISOString();
    const connected = Realtime.connectedSessionIds();
    const rows = db.prepare(`
      SELECT s.session_id, s.team_id, s.role, s.created_at, s.last_seen, s.ip_address,
             s.rules_ack_at, s.last_heartbeat, s.fullscreen, s.focused, t.team_name
      FROM sessions s
      JOIN teams t ON s.team_id = t.team_id
      WHERE s.expires_at > ?
      ORDER BY s.team_id ASC, s.role ASC
    `).all(nowIso) as any[];
    const now = Date.now();
    return rows.map(r => ({
      ...r,
      online: connected.has(r.session_id) || (now - (Date.parse(r.last_seen) || 0)) < ONLINE_WINDOW_MS
    }));
  }

  static getOnlineTeamCount(): number {
    const online = this.getActiveSessions().filter(s => s.online);
    return new Set(online.map(s => s.team_id)).size;
  }

  /* ---------------- admin listings ---------------- */

  static getPendingRequests() {
    this.expireStale();
    const nowIso = new Date().toISOString();
    return db.prepare(`
      SELECT r.*, t.team_name,
             (SELECT COUNT(*) FROM sessions s WHERE s.team_id = r.team_id AND s.role = r.role AND s.expires_at > ?) AS active_role_sessions,
             (SELECT COUNT(*) FROM sessions s WHERE s.team_id = r.team_id AND s.expires_at > ?) AS active_team_sessions
      FROM login_requests r
      LEFT JOIN teams t ON t.team_id = r.team_id
      WHERE r.status IN ('PENDING')
      ORDER BY r.requested_at ASC
    `).all(nowIso, nowIso).map((r: any) => this.withCredentialExpiry(r));
  }

  private static withCredentialExpiry(r: any) {
    if (!r.credential_id) return { ...r, expires_at: null };
    const c = db.prepare('SELECT expires_at FROM temporary_credentials WHERE credential_id = ?').get(r.credential_id) as any;
    return { ...r, expires_at: c?.expires_at ?? null };
  }

  static getCredentialHistory(limit = 60) {
    return db.prepare(`
      SELECT c.credential_id, c.team_id, c.role, c.issued_at, c.expires_at, c.used_at, c.revoked_at, t.team_name
      FROM temporary_credentials c
      LEFT JOIN teams t ON t.team_id = c.team_id
      ORDER BY c.issued_at DESC LIMIT ?
    `).all(limit).map((c: any) => ({
      ...c,
      status: c.used_at ? 'USED' : c.revoked_at ? 'REVOKED' : (c.expires_at <= new Date().toISOString() ? 'EXPIRED' : 'ISSUED')
    }));
  }

  /** Mark requests whose password lapsed unused so the participant is told to ask again. */
  static expireStale() {
    const nowIso = new Date().toISOString();
    db.prepare(`
      UPDATE login_requests SET status = 'EXPIRED'
      WHERE status = 'ISSUED' AND credential_id IN (
        SELECT credential_id FROM temporary_credentials WHERE used_at IS NULL AND expires_at <= ?
      )
    `).run(nowIso);
  }
}

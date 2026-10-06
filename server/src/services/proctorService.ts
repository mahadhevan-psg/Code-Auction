import { db, audit, uid } from '../db/database.js';
import { Realtime } from './realtime.js';
import { SettingsService } from './settingsService.js';
import { EventEngine } from './eventEngine.js';

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH';

/** Everything the client may report. Unknown types are rejected so the log stays clean. */
export const VIOLATION_TYPES: Record<string, { severity: Severity; label: string }> = {
  FULLSCREEN_EXIT:     { severity: 'MEDIUM', label: 'Left fullscreen' },
  TAB_SWITCH:          { severity: 'MEDIUM', label: 'Switched tab / minimised window' },
  FOCUS_LOST:          { severity: 'LOW',    label: 'Window lost focus' },
  PASTE_BLOCKED:       { severity: 'HIGH',   label: 'Pasted external text (blocked)' },
  COPY_BLOCKED:        { severity: 'LOW',    label: 'Copy/cut attempt (blocked)' },
  LARGE_INSERT:        { severity: 'MEDIUM', label: 'Large text insertion in editor' },
  CONTEXT_MENU:        { severity: 'LOW',    label: 'Right-click attempt' },
  BLOCKED_SHORTCUT:    { severity: 'LOW',    label: 'Blocked keyboard shortcut' },
  DEVTOOLS_SUSPECTED:  { severity: 'HIGH',   label: 'Developer tools suspected' },
  MULTI_MONITOR:       { severity: 'MEDIUM', label: 'Multiple monitors detected' },
  MULTIPLE_TABS:       { severity: 'HIGH',   label: 'Session open in more than one tab' },
  PRINT_ATTEMPT:       { severity: 'LOW',    label: 'Print attempt' },
  DROP_BLOCKED:        { severity: 'MEDIUM', label: 'Drag-and-drop content (blocked)' },
  RELOAD:              { severity: 'LOW',    label: 'Page reloaded' },
  RULES_ACKNOWLEDGED:  { severity: 'LOW',    label: 'Rules accepted' }
};

// Legacy name emitted by the previous client build.
const ALIASES: Record<string, string> = { COPY_PASTE: 'COPY_BLOCKED' };

const THROTTLE_MS = 1500;
const lastReported = new Map<string, number>();

export class ProctorService {
  static record(opts: {
    teamId: string;
    role: string;
    sessionId?: string;
    type: string;
    metadata?: Record<string, unknown>;
  }) {
    const type = ALIASES[opts.type] || opts.type;
    const def = VIOLATION_TYPES[type];
    if (!def) throw new Error(`Unknown violation type '${opts.type}'.`);

    // The acknowledgement is bookkeeping, not a flag.
    if (type === 'RULES_ACKNOWLEDGED') {
      audit(`${opts.teamId}:${opts.role}`, 'RULES_ACKNOWLEDGED', opts.sessionId || opts.teamId);
      return null;
    }

    const key = `${opts.sessionId || opts.teamId}:${type}`;
    const now = Date.now();
    if (now - (lastReported.get(key) ?? 0) < THROTTLE_MS) return null;
    lastReported.set(key, now);

    const state = EventEngine.getEventState();
    const violationId = uid('viol');
    const meta = { ...(opts.metadata || {}), phase: state.state };
    const metaJson = JSON.stringify(meta).slice(0, 2000);

    db.prepare(`
      INSERT INTO violations (violation_id, team_id, role, type, timestamp, metadata, severity, session_id, round_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(violationId, opts.teamId, opts.role, type, new Date().toISOString(), metaJson, def.severity, opts.sessionId ?? null, state.roundId);

    const counts = this.counts(opts.teamId);
    const payload = {
      violationId, teamId: opts.teamId, role: opts.role, type, label: def.label,
      severity: def.severity, total: counts.total, serious: counts.serious
    };
    Realtime.emitAdmin('violation:new', payload);
    if (def.severity === 'HIGH') {
      Realtime.emitAdmin('admin:alert', { level: 'warn', message: `Team ${opts.teamId} (${opts.role}): ${def.label}` });
    }

    // Optional hard stop, configured by the admin. Default policy only flags.
    const policy = SettingsService.getPolicy();
    if (policy.autoLockThreshold > 0 && counts.serious >= policy.autoLockThreshold) {
      const team = db.prepare('SELECT locked FROM teams WHERE team_id = ?').get(opts.teamId) as any;
      if (team && !team.locked) this.setLocked(opts.teamId, true, `Auto-locked after ${counts.serious} flags`, 'SYSTEM');
    }
    return { violationId, ...counts };
  }

  /** Participant-visible tally for the on-screen "integrity" chip. */
  static counts(teamId: string) {
    const r = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN severity IN ('MEDIUM','HIGH') THEN 1 ELSE 0 END) AS serious
      FROM violations WHERE team_id = ? AND reviewed = 0
    `).get(teamId) as any;
    return { total: r.total ?? 0, serious: r.serious ?? 0 };
  }

  static setLocked(teamId: string, locked: boolean, reason: string, actor: string) {
    const team = db.prepare('SELECT team_id FROM teams WHERE team_id = ?').get(teamId);
    if (!team) throw new Error(`Team '${teamId}' not found.`);
    db.prepare('UPDATE teams SET locked = ?, lock_reason = ? WHERE team_id = ?').run(locked ? 1 : 0, locked ? reason : null, teamId);
    audit(actor, locked ? 'TEAM_LOCKED' : 'TEAM_UNLOCKED', teamId, { reason });
    Realtime.emitTeam(teamId, 'proctor:lock', { locked, reason: locked ? reason : null });
    Realtime.emitAdmin('admin:alert', { level: locked ? 'warn' : 'info', message: `Team ${teamId} ${locked ? 'locked' : 'unlocked'}${locked ? `: ${reason}` : ''}` });
  }

  static review(violationId: string, reviewed: boolean, note: string, actor: string) {
    const v = db.prepare('SELECT violation_id, team_id FROM violations WHERE violation_id = ?').get(violationId) as any;
    if (!v) throw new Error('Violation not found.');
    db.prepare('UPDATE violations SET reviewed = ?, review_note = ? WHERE violation_id = ?').run(reviewed ? 1 : 0, note || null, violationId);
    audit(actor, reviewed ? 'VIOLATION_CLEARED' : 'VIOLATION_REOPENED', violationId, { teamId: v.team_id, note });
  }

  static list(filter: { teamId?: string; severity?: string; limit?: number } = {}) {
    const where: string[] = [];
    const params: any[] = [];
    if (filter.teamId) { where.push('v.team_id = ?'); params.push(filter.teamId); }
    if (filter.severity) { where.push('v.severity = ?'); params.push(filter.severity); }
    return db.prepare(`
      SELECT v.*, t.team_name FROM violations v
      LEFT JOIN teams t ON v.team_id = t.team_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY v.timestamp DESC LIMIT ?
    `).all(...params, filter.limit ?? 500).map((v: any) => ({ ...v, label: VIOLATION_TYPES[v.type]?.label ?? v.type }));
  }

  /** One row per team that has been flagged: counts by severity, last event, lock state. */
  static summary() {
    return db.prepare(`
      SELECT t.team_id, t.team_name, t.locked, t.lock_reason,
             COUNT(v.violation_id) AS total,
             SUM(CASE WHEN v.severity = 'HIGH' THEN 1 ELSE 0 END) AS high,
             SUM(CASE WHEN v.severity = 'MEDIUM' THEN 1 ELSE 0 END) AS medium,
             SUM(CASE WHEN v.severity = 'LOW' THEN 1 ELSE 0 END) AS low,
             SUM(CASE WHEN v.reviewed = 0 THEN 1 ELSE 0 END) AS open_count,
             MAX(v.timestamp) AS last_at
      FROM teams t
      LEFT JOIN violations v ON v.team_id = t.team_id
      GROUP BY t.team_id
      HAVING COUNT(v.violation_id) > 0 OR t.locked = 1
      ORDER BY (SUM(CASE WHEN v.severity = 'HIGH' THEN 3 WHEN v.severity = 'MEDIUM' THEN 2 ELSE 1 END)) DESC
    `).all();
  }
}

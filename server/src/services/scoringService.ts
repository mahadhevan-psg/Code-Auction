import { db, audit, uid, transaction } from '../db/database.js';
import { Realtime } from './realtime.js';

export interface LeaderboardRow {
  rank: number;
  teamId: string;
  teamName: string;
  round1Score: number;
  round2Score: number;
  aptitudeScore: number;
  adjustment: number;
  totalScore: number;
}

const round2dp = (n: number) => Math.round(n * 100) / 100;

export class ScoringService {
  /**
   * A team's round score is its best judged submission: passed test cases (raw) x problem weight.
   * Raw and weighted values are stored separately.
   */
  static recalculate(teamId: string, roundId: number) {
    const best = db.prepare(`
      SELECT score, passed_count FROM submissions
      WHERE team_id = ? AND round_id = ? AND status NOT IN ('Pending','Judging')
      ORDER BY score DESC, submitted_at ASC LIMIT 1
    `).get(teamId, roundId) as { score: number; passed_count: number } | undefined;

    const coding = best?.score ?? 0;
    const raw = best?.passed_count ?? 0;
    const apt = (db.prepare('SELECT aptitude_score FROM teams WHERE team_id = ?').get(teamId) as any)?.aptitude_score ?? 0;

    db.prepare(`
      INSERT INTO scores (score_id, team_id, round_id, coding_score, raw_passed, aptitude_score, total_score)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(team_id, round_id) DO UPDATE SET
        coding_score = excluded.coding_score,
        raw_passed = excluded.raw_passed,
        aptitude_score = excluded.aptitude_score,
        total_score = excluded.total_score,
        updated_at = CURRENT_TIMESTAMP
    `).run(`score_${roundId}_${teamId}`, teamId, roundId, coding, raw, apt, coding + apt);

    Realtime.emitTeam(teamId, 'score:update', { teamId, roundId, codingScore: coding });
    Realtime.emitAdmin('score:update', { teamId, roundId, codingScore: coding });
    return { coding, raw };
  }

  static leaderboard(): LeaderboardRow[] {
    const teams = db.prepare("SELECT team_id, team_name, aptitude_score FROM teams WHERE status = 'ACTIVE'").all() as any[];
    const scores = db.prepare('SELECT team_id, round_id, coding_score FROM scores').all() as any[];
    const adjustments = db.prepare('SELECT team_id, SUM(delta) AS delta FROM score_adjustments GROUP BY team_id').all() as any[];

    const byTeam = new Map<string, Record<number, number>>();
    for (const s of scores) {
      const m = byTeam.get(s.team_id) ?? {};
      m[s.round_id] = s.coding_score;
      byTeam.set(s.team_id, m);
    }
    const adjMap = new Map<string, number>(adjustments.map(a => [a.team_id, a.delta]));

    const rows = teams.map(t => {
      const r = byTeam.get(t.team_id) ?? {};
      const r1 = r[1] ?? 0;
      const r2 = r[2] ?? 0;
      const apt = t.aptitude_score ?? 0;
      const adj = adjMap.get(t.team_id) ?? 0;
      return {
        teamId: t.team_id as string,
        teamName: t.team_name as string,
        round1Score: round2dp(r1),
        round2Score: round2dp(r2),
        aptitudeScore: round2dp(apt),
        adjustment: round2dp(adj),
        totalScore: round2dp(r1 + r2 + apt + adj)
      };
    });

    rows.sort((a, b) => b.totalScore - a.totalScore || a.teamId.localeCompare(b.teamId));

    let rank = 0;
    let prev: number | null = null;
    return rows.map((row, idx) => {
      if (prev === null || row.totalScore !== prev) rank = idx + 1;
      prev = row.totalScore;
      return { rank, ...row };
    });
  }

  /** Team's running total used on participant headers. */
  static teamSummary(teamId: string) {
    const row = this.leaderboard().find(r => r.teamId === teamId);
    return row ?? null;
  }

  static adjustScore(teamId: string, delta: number, reason: string, actor: string) {
    if (!Number.isFinite(delta) || delta === 0) throw new Error('A non-zero numeric adjustment is required.');
    if (!reason || reason.trim().length < 3) throw new Error('A reason is required for every score adjustment.');
    const team = db.prepare('SELECT team_id FROM teams WHERE team_id = ?').get(teamId);
    if (!team) throw new Error(`Team '${teamId}' not found.`);

    transaction(() => {
      db.prepare('INSERT INTO score_adjustments (adjustment_id, team_id, delta, reason, actor) VALUES (?, ?, ?, ?, ?)')
        .run(uid('adj'), teamId, delta, reason.trim(), actor);
      audit(actor, 'SCORE_ADJUSTMENT', teamId, { delta, reason: reason.trim() });
    });
    Realtime.emitAll('leaderboard:changed', {});
  }

  static setAptitude(teamId: string, value: number, actor: string) {
    if (!Number.isFinite(value) || value < 0) throw new Error('Aptitude score must be a non-negative number.');
    const prev = db.prepare('SELECT aptitude_score FROM teams WHERE team_id = ?').get(teamId) as any;
    if (!prev) throw new Error(`Team '${teamId}' not found.`);
    transaction(() => {
      db.prepare('UPDATE teams SET aptitude_score = ? WHERE team_id = ?').run(value, teamId);
      db.prepare('UPDATE scores SET aptitude_score = ?, total_score = coding_score + ? WHERE team_id = ?').run(value, value, teamId);
      audit(actor, 'UPDATE_APTITUDE', teamId, { from: prev.aptitude_score, to: value });
    });
  }

  static adjustments(limit = 100) {
    return db.prepare(`
      SELECT a.*, t.team_name FROM score_adjustments a
      LEFT JOIN teams t ON t.team_id = a.team_id
      ORDER BY a.created_at DESC LIMIT ?
    `).all(limit);
  }
}

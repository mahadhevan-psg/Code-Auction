import { db, audit, transaction } from '../db/database.js';

const PUBLIC_PROBLEM_COLUMNS = 'p.problem_id, p.title, p.difficulty, p.weight, p.statement, p.constraints, p.sample_input, p.sample_output, p.time_limit_ms, p.memory_limit_mb';

export class AllocationEngine {
  /** Published problems that take part in a round's allocation. */
  static roundProblems(roundId: number): Array<{ problem_id: string }> {
    return db.prepare("SELECT problem_id FROM problems WHERE round_id = ? AND status = 'PUBLISHED' ORDER BY problem_id ASC")
      .all(roundId) as Array<{ problem_id: string }>;
  }

  static activeTeamCount(): number {
    return (db.prepare("SELECT COUNT(*) AS cnt FROM teams WHERE status = 'ACTIVE'").get() as { cnt: number }).cnt;
  }

  /**
   * T teams over 5 buckets, as even as possible:
   * the first (T mod 5) problems get floor(T/5)+1, the rest get floor(T/5).
   */
  static computeCapacities(teamCount: number, problemCount = 5): number[] {
    const base = Math.floor(teamCount / problemCount);
    const remainder = teamCount % problemCount;
    return Array.from({ length: problemCount }, (_, idx) => (idx < remainder ? base + 1 : base));
  }

  static calculateAndSetCapacities(roundId: number) {
    const T = this.activeTeamCount();
    const problems = this.roundProblems(roundId);
    const caps = this.computeCapacities(T, problems.length || 5);

    transaction(() => {
      const stmt = db.prepare('UPDATE problems SET capacity = ?, remaining_capacity = ? WHERE problem_id = ?');
      problems.forEach((p, idx) => stmt.run(caps[idx], caps[idx], p.problem_id));
    });

    return db.prepare('SELECT problem_id, title, difficulty, weight, capacity, remaining_capacity FROM problems WHERE round_id = ? ORDER BY problem_id')
      .all(roundId);
  }

  static hasSubmitted(teamId: string, roundId: number): boolean {
    return Boolean(db.prepare('SELECT 1 FROM priorities WHERE team_id = ? AND round_id = ?').get(teamId, roundId));
  }

  /** Record a team's ranking. The first accepted submission is final and gets the sequence number. */
  static submitPriorities(teamId: string, roundId: number, rankings: unknown) {
    if (!Array.isArray(rankings) || rankings.length !== 5 || rankings.some(r => typeof r !== 'string')) {
      throw new Error('You must rank all 5 problems.');
    }
    const ranks = rankings as string[];
    if (new Set(ranks).size !== 5) {
      throw new Error('Duplicate problem choices detected. Each problem must be ranked exactly once.');
    }

    const valid = new Set(this.roundProblems(roundId).map(p => p.problem_id));
    for (const r of ranks) {
      if (!valid.has(r)) throw new Error(`Problem '${r}' is not part of Round ${roundId}.`);
    }

    return transaction(() => {
      if (this.hasSubmitted(teamId, roundId)) {
        throw new Error('Your team has already submitted its priorities for this round. Submissions are final.');
      }
      const { next_seq } = db.prepare('SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next_seq FROM priorities WHERE round_id = ?')
        .get(roundId) as { next_seq: number };
      const submittedAt = new Date().toISOString();

      db.prepare(`
        INSERT INTO priorities (priority_id, team_id, round_id, rank1, rank2, rank3, rank4, rank5, sequence_no, submitted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(`prio_${roundId}_${teamId}`, teamId, roundId, ranks[0], ranks[1], ranks[2], ranks[3], ranks[4], next_seq, submittedAt);

      audit(teamId, 'SUBMIT_PRIORITIES', `Round_${roundId}`, { sequenceNo: next_seq, rankings: ranks });
      return { teamId, roundId, sequenceNo: next_seq, submittedAt };
    });
  }

  static priorityProgress(roundId: number) {
    const submitted = (db.prepare('SELECT COUNT(*) AS c FROM priorities WHERE round_id = ?').get(roundId) as any).c as number;
    return { submitted, total: this.activeTeamCount() };
  }

  /**
   * Deterministic first-come-first-served allocation inside one transaction, so a problem
   * can never be assigned beyond its capacity. Teams that never submitted are processed last
   * using the default problem order, and that is recorded in the audit log.
   */
  static runAllocation(roundId: number, actor = 'SYSTEM') {
    const state = (db.prepare('SELECT state FROM rounds WHERE round_id = ?').get(roundId) as any)?.state;
    if (state === 'CODING' || state === 'ROUND_ENDED' || state === 'SCOREBOARD' || state === 'FINAL_LEADERBOARD') {
      throw new Error('Allocation can no longer be re-run once coding has started.');
    }

    const result = transaction(() => {
      this.calculateAndSetCapacities(roundId);

      const problems = db.prepare("SELECT problem_id, remaining_capacity FROM problems WHERE round_id = ? AND status = 'PUBLISHED' ORDER BY problem_id")
        .all(roundId) as Array<{ problem_id: string; remaining_capacity: number }>;
      const capacity = new Map(problems.map(p => [p.problem_id, p.remaining_capacity]));
      const defaultOrder = problems.map(p => p.problem_id);

      const submissions = db.prepare(`
        SELECT pr.* FROM priorities pr
        JOIN teams t ON t.team_id = pr.team_id AND t.status = 'ACTIVE'
        WHERE pr.round_id = ? ORDER BY pr.sequence_no ASC
      `).all(roundId) as any[];

      const submitted = new Set(submissions.map(s => s.team_id));
      const queue = submissions.map(s => ({
        teamId: s.team_id as string,
        prefs: [s.rank1, s.rank2, s.rank3, s.rank4, s.rank5] as string[],
        auto: false
      }));

      const missing = db.prepare("SELECT team_id FROM teams WHERE status = 'ACTIVE' ORDER BY team_id").all() as Array<{ team_id: string }>;
      for (const t of missing) {
        if (!submitted.has(t.team_id)) queue.push({ teamId: t.team_id, prefs: defaultOrder, auto: true });
      }

      db.prepare('DELETE FROM allocations WHERE round_id = ?').run(roundId);
      const insert = db.prepare('INSERT INTO allocations (allocation_id, team_id, round_id, problem_id, priority_rank) VALUES (?, ?, ?, ?, ?)');

      const allocations: Array<{ teamId: string; problemId: string; priorityRank: number; auto: boolean }> = [];
      const exceptions: string[] = [];

      for (const entry of queue) {
        let assigned: { problemId: string; rank: number } | null = null;
        for (let i = 0; i < entry.prefs.length; i++) {
          const pref = entry.prefs[i];
          const left = capacity.get(pref) ?? 0;
          if (left > 0) {
            capacity.set(pref, left - 1);
            assigned = { problemId: pref, rank: i + 1 };
            break;
          }
        }
        if (assigned) {
          insert.run(`alloc_${roundId}_${entry.teamId}`, entry.teamId, roundId, assigned.problemId, assigned.rank);
          allocations.push({ teamId: entry.teamId, problemId: assigned.problemId, priorityRank: assigned.rank, auto: entry.auto });
        } else {
          exceptions.push(entry.teamId);
        }
      }

      const upd = db.prepare('UPDATE problems SET remaining_capacity = ? WHERE problem_id = ?');
      for (const [pid, left] of capacity) upd.run(left, pid);

      audit(actor, 'RUN_ALLOCATION', `Round_${roundId}`, {
        allocated: allocations.length,
        autoPriority: allocations.filter(a => a.auto).map(a => a.teamId),
        exceptions
      });
      for (const teamId of exceptions) audit('SYSTEM', 'ALLOCATION_EXCEPTION', `${teamId}:Round_${roundId}`);

      return { roundId, totalAllocated: allocations.length, allocations, exceptions };
    });

    return result;
  }

  static getTeamAllocation(teamId: string, roundId: number) {
    return db.prepare(`
      SELECT a.allocation_id, a.team_id, a.round_id, a.problem_id, a.priority_rank, a.allocated_at, a.is_override,
             ${PUBLIC_PROBLEM_COLUMNS}
      FROM allocations a
      JOIN problems p ON a.problem_id = p.problem_id
      WHERE a.team_id = ? AND a.round_id = ?
    `).get(teamId, roundId);
  }

  static allocationSummary(roundId: number) {
    return db.prepare(`
      SELECT p.problem_id, p.title, p.difficulty, p.capacity,
             (SELECT COUNT(*) FROM allocations a WHERE a.problem_id = p.problem_id AND a.round_id = ?) AS assigned
      FROM problems p WHERE p.round_id = ? AND p.status = 'PUBLISHED' ORDER BY p.problem_id
    `).all(roundId, roundId);
  }

  static overrideAllocation(teamId: string, roundId: number, newProblemId: string, adminActor: string, reason: string) {
    const team = db.prepare('SELECT team_id FROM teams WHERE team_id = ?').get(teamId);
    if (!team) throw new Error(`Team '${teamId}' not found.`);
    const problem = db.prepare("SELECT problem_id FROM problems WHERE problem_id = ? AND round_id = ? AND status = 'PUBLISHED'").get(newProblemId, roundId);
    if (!problem) throw new Error(`Problem '${newProblemId}' is not a published problem of Round ${roundId}.`);
    if (!reason || !reason.trim()) throw new Error('A reason is required for an allocation override.');

    const prev = db.prepare('SELECT problem_id FROM allocations WHERE team_id = ? AND round_id = ?').get(teamId, roundId) as any;
    transaction(() => {
      db.prepare(`
        INSERT INTO allocations (allocation_id, team_id, round_id, problem_id, priority_rank, is_override)
        VALUES (?, ?, ?, ?, 0, 1)
        ON CONFLICT(team_id, round_id) DO UPDATE SET
          problem_id = excluded.problem_id, priority_rank = 0, is_override = 1, allocated_at = CURRENT_TIMESTAMP
      `).run(`alloc_${roundId}_${teamId}`, teamId, roundId, newProblemId);
      audit(adminActor, 'ALLOCATION_OVERRIDE', `${teamId}:Round_${roundId}`, { from: prev?.problem_id ?? null, to: newProblemId, reason: reason.trim() });
    });
  }
}

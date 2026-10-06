import { db, audit, getSetting, setSetting, transaction } from '../db/database.js';
import { AllocationEngine } from './allocationEngine.js';
import { Realtime } from './realtime.js';

export type EventStage =
  | 'WAITING' | 'PRIORITY_SELECTION' | 'ALLOCATION' | 'CODING'
  | 'ROUND_ENDED' | 'SCOREBOARD' | 'FINAL_LEADERBOARD';

const TOTAL_ROUNDS = 2;

/**
 * The server is the only authority over event state. Phase timers are stored as an absolute
 * end timestamp (rounds.phase_ends_at) so they survive restarts, reconnects and client clock skew.
 */
export class EventEngine {
  private static activeRoundId = 1;
  private static ticker: NodeJS.Timeout | null = null;
  private static allocationError: string | null = null;

  /* ------------------------------------------------------------------ */
  /* boot                                                                */
  /* ------------------------------------------------------------------ */

  static start() {
    this.activeRoundId = getSetting<number>('active_round_id', 1);
    if (!this.round(this.activeRoundId)) this.activeRoundId = 1;

    // A round saved mid-phase by an older build has no end timestamp. Freeze it (paused, full
    // time) rather than letting the clock treat it as expired and silently advance the event.
    const legacy = db.prepare(`
      SELECT round_id, state, priority_duration_seconds AS p, coding_duration_seconds AS c FROM rounds
      WHERE state IN ('PRIORITY_SELECTION','CODING') AND phase_ends_at IS NULL AND paused_remaining IS NULL
    `).all() as Array<{ round_id: number; state: string; p: number; c: number }>;
    for (const r of legacy) {
      const remaining = r.state === 'PRIORITY_SELECTION' ? r.p : r.c;
      db.prepare('UPDATE rounds SET paused_remaining = ? WHERE round_id = ?').run(remaining, r.round_id);
      audit('SYSTEM', 'PAUSE_LEGACY_TIMER', `Round_${r.round_id}`, { state: r.state, remaining });
      console.warn(`[EventEngine] Round ${r.round_id} was saved in ${r.state} without a timer – paused with ${remaining}s. Resume it from the admin panel.`);
    }
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = setInterval(() => this.tick(), 1000);
    this.ticker.unref();
  }

  private static round(roundId: number) {
    return db.prepare('SELECT * FROM rounds WHERE round_id = ?').get(roundId) as any;
  }

  static get currentRoundId() { return this.activeRoundId; }

  /* ------------------------------------------------------------------ */
  /* state                                                               */
  /* ------------------------------------------------------------------ */

  static remainingSeconds(round: any): number {
    if (!round) return 0;
    if (round.state !== 'PRIORITY_SELECTION' && round.state !== 'CODING') return 0;
    if (round.paused_remaining !== null && round.paused_remaining !== undefined) return Math.max(0, round.paused_remaining);
    if (!round.phase_ends_at) return 0;
    return Math.max(0, Math.ceil((round.phase_ends_at - Date.now()) / 1000));
  }

  /** Absolute end time of the active timed phase (null if untimed or paused). */
  static phaseEndsAt(roundId = this.activeRoundId): number | null {
    const r = this.round(roundId);
    if (!r || r.paused_remaining !== null && r.paused_remaining !== undefined) return null;
    if (r.state !== 'PRIORITY_SELECTION' && r.state !== 'CODING') return null;
    return r.phase_ends_at ?? null;
  }

  static getEventState() {
    const round = this.round(this.activeRoundId);
    return {
      roundId: this.activeRoundId,
      roundNumber: round?.round_number ?? 1,
      totalRounds: TOTAL_ROUNDS,
      state: (round?.state ?? 'WAITING') as EventStage,
      remainingSeconds: this.remainingSeconds(round),
      paused: round?.paused_remaining !== null && round?.paused_remaining !== undefined,
      priorityDuration: round?.priority_duration_seconds ?? 180,
      codingDuration: round?.coding_duration_seconds ?? 600,
      phaseEndsAt: this.phaseEndsAt(),
      serverNow: Date.now(),
      allocationError: this.allocationError
    };
  }

  static broadcastStateChange() {
    Realtime.emitAll('round:state', this.getEventState());
  }

  /* ------------------------------------------------------------------ */
  /* ticking                                                             */
  /* ------------------------------------------------------------------ */

  private static tick() {
    const round = this.round(this.activeRoundId);
    if (!round) return;
    if (round.state !== 'PRIORITY_SELECTION' && round.state !== 'CODING') return;

    const paused = round.paused_remaining !== null && round.paused_remaining !== undefined;
    const remaining = this.remainingSeconds(round);
    Realtime.emitAll('round:timer', {
      roundId: round.round_id,
      stage: round.state,
      remainingSeconds: remaining,
      paused,
      serverNow: Date.now(),
      phaseEndsAt: paused ? null : round.phase_ends_at
    });

    if (!paused && remaining <= 0) {
      try {
        if (round.state === 'PRIORITY_SELECTION') this.closePriority('SYSTEM');
        else this.endCoding('SYSTEM');
      } catch (err) {
        console.error('[EventEngine] auto transition failed', err);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* transitions                                                         */
  /* ------------------------------------------------------------------ */

  private static setState(roundId: number, state: EventStage, durationSeconds: number | null, actor: string) {
    const endsAt = durationSeconds ? Date.now() + durationSeconds * 1000 : null;
    db.prepare(`UPDATE rounds SET state = ?, phase_ends_at = ?, paused_remaining = NULL, start_time = COALESCE(start_time, ?) WHERE round_id = ?`)
      .run(state, endsAt, new Date().toISOString(), roundId);
    audit(actor, 'STAGE_CHANGE', `Round_${roundId}`, { state, durationSeconds });
  }

  private static assertState(expected: EventStage | EventStage[], action: string) {
    const round = this.round(this.activeRoundId);
    const list = Array.isArray(expected) ? expected : [expected];
    if (!list.includes(round.state)) {
      throw new Error(`Cannot ${action} while the round is in state ${round.state}.`);
    }
    return round;
  }

  /** WAITING -> PRIORITY_SELECTION: reveals the five problems to first-years. */
  static openPriority(actor: string) {
    const round = this.assertState('WAITING', 'open priority selection');

    const problems = AllocationEngine.roundProblems(round.round_id);
    if (problems.length !== 5) {
      throw new Error(`Round ${round.round_id} needs exactly 5 published problems (found ${problems.length}).`);
    }
    for (const p of problems) {
      const n = (db.prepare('SELECT COUNT(*) AS c FROM problem_test_cases WHERE problem_id = ?').get(p.problem_id) as any).c;
      if (!n) throw new Error(`Problem ${p.problem_id} has no test cases.`);
    }
    if (AllocationEngine.activeTeamCount() < 1) throw new Error('No active teams are registered.');

    this.allocationError = null;
    transaction(() => {
      AllocationEngine.calculateAndSetCapacities(round.round_id);
      this.setState(round.round_id, 'PRIORITY_SELECTION', round.priority_duration_seconds, actor);
    });
    Realtime.emitAll('priority:opened', { roundId: round.round_id });
    this.broadcastStateChange();
  }

  /** PRIORITY_SELECTION -> ALLOCATION: freezes rankings and runs the deterministic allocation. */
  static closePriority(actor: string) {
    const round = this.assertState('PRIORITY_SELECTION', 'close priority selection');
    this.setState(round.round_id, 'ALLOCATION', null, actor);
    this.allocationError = null;
    Realtime.emitAll('priority:closed', { roundId: round.round_id });

    try {
      const result = AllocationEngine.runAllocation(round.round_id, actor);
      this.announceAllocation(round.round_id, result);
    } catch (err: any) {
      // Allocation failed: keep participants frozen on the allocation screen and shout at the admin.
      this.allocationError = err.message || 'Allocation failed.';
      audit('SYSTEM', 'ALLOCATION_FAILED', `Round_${round.round_id}`, { error: this.allocationError });
      Realtime.emitAdmin('admin:alert', { level: 'error', message: `Allocation failed: ${this.allocationError}` });
    }
    this.broadcastStateChange();
  }

  /** Admin re-run while in the ALLOCATION state. */
  static rerunAllocation(actor: string) {
    const round = this.assertState('ALLOCATION', 're-run allocation');
    try {
      const result = AllocationEngine.runAllocation(round.round_id, actor);
      this.allocationError = null;
      this.announceAllocation(round.round_id, result);
      this.broadcastStateChange();
      return result;
    } catch (err: any) {
      this.allocationError = err.message;
      this.broadcastStateChange();
      throw err;
    }
  }

  private static announceAllocation(roundId: number, result: { totalAllocated: number; allocations: Array<{ teamId: string; problemId: string; priorityRank: number }>; exceptions: string[] }) {
    for (const a of result.allocations) {
      Realtime.emitTeam(a.teamId, 'allocation:complete', { roundId, problemId: a.problemId, priorityRank: a.priorityRank });
    }
    if (result.exceptions.length) {
      Realtime.emitAdmin('admin:alert', {
        level: 'error',
        message: `Allocation exception: ${result.exceptions.join(', ')} could not be assigned. Resolve with an override.`
      });
    }
    Realtime.emitAdmin('admin:alert', { level: 'info', message: `Allocation complete for Round ${roundId}: ${result.totalAllocated} teams assigned.` });
  }

  /** ALLOCATION -> CODING */
  static startCoding(actor: string, force = false) {
    const round = this.assertState('ALLOCATION', 'start coding');
    if (this.allocationError && !force) throw new Error(`Allocation has an error: ${this.allocationError}`);

    const allocated = (db.prepare('SELECT COUNT(*) AS c FROM allocations WHERE round_id = ?').get(round.round_id) as any).c as number;
    const teams = AllocationEngine.activeTeamCount();
    if (allocated < teams && !force) {
      throw new Error(`Only ${allocated} of ${teams} teams are allocated. Resolve exceptions (override allocation) or force start.`);
    }

    this.setState(round.round_id, 'CODING', round.coding_duration_seconds, actor);
    Realtime.emitAll('coding:started', { roundId: round.round_id });
    this.broadcastStateChange();
  }

  /** CODING -> ROUND_ENDED */
  static endCoding(actor: string) {
    const round = this.assertState('CODING', 'end coding');
    this.setState(round.round_id, 'ROUND_ENDED', null, actor);
    db.prepare('UPDATE rounds SET end_time = ? WHERE round_id = ?').run(new Date().toISOString(), round.round_id);
    Realtime.emitAll('round:ended', { roundId: round.round_id });
    this.broadcastStateChange();
  }

  /** ROUND_ENDED -> SCOREBOARD */
  static showScoreboard(actor: string) {
    const round = this.assertState('ROUND_ENDED', 'publish the scoreboard');
    this.setState(round.round_id, 'SCOREBOARD', null, actor);
    Realtime.emitAll('leaderboard:changed', {});
    this.broadcastStateChange();
  }

  /** SCOREBOARD -> next round's WAITING (or final leaderboard after the last round). */
  static nextRound(actor: string) {
    const round = this.assertState('SCOREBOARD', 'advance');
    if (round.round_id >= TOTAL_ROUNDS) {
      this.setState(round.round_id, 'FINAL_LEADERBOARD', null, actor);
    } else {
      const next = round.round_id + 1;
      this.activeRoundId = next;
      setSetting('active_round_id', next);
      this.allocationError = null;
      this.setState(next, 'WAITING', null, actor);
    }
    Realtime.emitAll('leaderboard:changed', {});
    this.broadcastStateChange();
  }

  static pause(actor: string) {
    const round = this.assertState(['PRIORITY_SELECTION', 'CODING'], 'pause');
    if (round.paused_remaining !== null && round.paused_remaining !== undefined) throw new Error('The timer is already paused.');
    const remaining = this.remainingSeconds(round);
    db.prepare('UPDATE rounds SET paused_remaining = ? WHERE round_id = ?').run(remaining, round.round_id);
    audit(actor, 'PAUSE_TIMER', `Round_${round.round_id}`, { remaining });
    Realtime.emitAll('round:paused', { roundId: round.round_id });
    this.broadcastStateChange();
  }

  static resume(actor: string) {
    const round = this.assertState(['PRIORITY_SELECTION', 'CODING'], 'resume');
    if (round.paused_remaining === null || round.paused_remaining === undefined) throw new Error('The timer is not paused.');
    db.prepare('UPDATE rounds SET phase_ends_at = ?, paused_remaining = NULL WHERE round_id = ?')
      .run(Date.now() + round.paused_remaining * 1000, round.round_id);
    audit(actor, 'RESUME_TIMER', `Round_${round.round_id}`, { remaining: round.paused_remaining });
    this.broadcastStateChange();
  }

  static extend(actor: string, seconds: number) {
    const round = this.assertState(['PRIORITY_SELECTION', 'CODING'], 'extend the timer');
    const add = Math.floor(seconds);
    if (!Number.isFinite(add) || add === 0 || Math.abs(add) > 3600) throw new Error('Extension must be between -3600 and 3600 seconds.');
    if (round.paused_remaining !== null && round.paused_remaining !== undefined) {
      db.prepare('UPDATE rounds SET paused_remaining = MAX(1, paused_remaining + ?) WHERE round_id = ?').run(add, round.round_id);
    } else {
      db.prepare('UPDATE rounds SET phase_ends_at = MAX(?, phase_ends_at + ?) WHERE round_id = ?').run(Date.now() + 1000, add * 1000, round.round_id);
    }
    audit(actor, 'EXTEND_TIMER', `Round_${round.round_id}`, { seconds: add });
    this.broadcastStateChange();
  }

  /**
   * Dress-rehearsal helper: wipes one round's participant data and returns it to WAITING.
   * Never allowed on a round that is not the active one.
   */
  static resetRound(roundId: number, actor: string) {
    if (roundId !== this.activeRoundId) throw new Error('Only the active round can be reset.');
    transaction(() => {
      db.prepare('DELETE FROM priorities WHERE round_id = ?').run(roundId);
      db.prepare('DELETE FROM allocations WHERE round_id = ?').run(roundId);
      db.prepare('DELETE FROM submissions WHERE round_id = ?').run(roundId);
      db.prepare('DELETE FROM scores WHERE round_id = ?').run(roundId);
      db.prepare('DELETE FROM code_autosaves WHERE round_id = ?').run(roundId);
      db.prepare('UPDATE problems SET remaining_capacity = capacity WHERE round_id = ?').run(roundId);
      db.prepare("UPDATE rounds SET state = 'WAITING', phase_ends_at = NULL, paused_remaining = NULL, start_time = NULL, end_time = NULL WHERE round_id = ?").run(roundId);
      audit(actor, 'RESET_ROUND', `Round_${roundId}`);
    });
    this.allocationError = null;
    Realtime.emitAll('leaderboard:changed', {});
    this.broadcastStateChange();
  }
}

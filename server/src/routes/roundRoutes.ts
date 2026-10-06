import { Router } from 'express';
import { requireAuth, requireRole, requireExamEligible, AuthenticatedRequest } from '../middleware/authMiddleware.js';
import { EventEngine } from '../services/eventEngine.js';
import { AllocationEngine } from '../services/allocationEngine.js';
import { ScoringService } from '../services/scoringService.js';
import { JudgeService } from '../services/judgeService.js';
import { Realtime } from '../services/realtime.js';
import { db } from '../db/database.js';

const router = Router();

const PROBLEM_COLUMNS = 'problem_id, round_id, title, difficulty, weight, statement, constraints, sample_input, sample_output, time_limit_ms, memory_limit_mb';
const STATEMENT_VISIBLE = new Set(['CODING', 'ROUND_ENDED', 'SCOREBOARD', 'FINAL_LEADERBOARD']);
const RESULTS_VISIBLE = new Set(['SCOREBOARD', 'FINAL_LEADERBOARD']);

router.get('/current', (_req, res) => res.json(EventEngine.getEventState()));

// Public scoreboard – only once the admin has published it.
router.get('/leaderboard', requireAuth, (req: AuthenticatedRequest, res) => {
  const state = EventEngine.getEventState();
  if (req.user!.role !== 'ADMIN' && !RESULTS_VISIBLE.has(state.state)) {
    return res.status(403).json({ error: 'The scoreboard has not been published yet.' });
  }
  return res.json(ScoringService.leaderboard());
});

// Running score for the header chip (own team only).
router.get('/my-score', requireAuth, requireRole(['FIRST_YEAR', 'SENIOR']), (req: AuthenticatedRequest, res) => {
  const mine = ScoringService.teamSummary(req.user!.teamId);
  return res.json({
    teamId: req.user!.teamId,
    round1Score: mine?.round1Score ?? 0,
    round2Score: mine?.round2Score ?? 0,
    codingScore: (mine?.round1Score ?? 0) + (mine?.round2Score ?? 0),
    aptitudeScore: mine?.aptitudeScore ?? 0,
    totalScore: mine?.totalScore ?? 0
  });
});

// The five problems of a round. Capacity is never exposed; seniors only see their allocated problem.
router.get('/:roundId/problems', requireAuth, (req: AuthenticatedRequest, res) => {
  const roundId = parseInt(req.params.roundId);
  const user = req.user!;
  const state = EventEngine.getEventState();

  if (user.role !== 'ADMIN') {
    if (roundId !== state.roundId) return res.status(403).json({ error: 'That round is not active.' });
    if (state.state === 'WAITING') return res.status(403).json({ error: 'Problems are revealed when priority selection opens.' });
    if (user.role === 'SENIOR' && !RESULTS_VISIBLE.has(state.state)) {
      return res.status(403).json({ error: 'Seniors receive only their allocated problem.' });
    }
  }

  const problems = db.prepare(`SELECT ${PROBLEM_COLUMNS} FROM problems WHERE round_id = ? AND status = 'PUBLISHED' ORDER BY problem_id ASC`).all(roundId);
  return res.json(problems);
});

// First-years submit the complete ranking. Final, timestamped and sequenced by the server.
router.post('/:roundId/priority', requireAuth, requireRole(['FIRST_YEAR']), requireExamEligible, (req: AuthenticatedRequest, res) => {
  try {
    const roundId = parseInt(req.params.roundId);
    const state = EventEngine.getEventState();
    if (roundId !== state.roundId || state.state !== 'PRIORITY_SELECTION') {
      return res.status(400).json({ error: 'Priority selection is not open.' });
    }
    if (!state.paused && state.remainingSeconds <= 0) {
      return res.status(400).json({ error: 'Priority selection has just closed.' });
    }
    if (state.paused) return res.status(400).json({ error: 'The round is paused by the administrator.' });

    const result = AllocationEngine.submitPriorities(req.user!.teamId, roundId, req.body?.rankings);
    Realtime.emitAdmin('priority:submitted', { teamId: req.user!.teamId, sequenceNo: result.sequenceNo, ...AllocationEngine.priorityProgress(roundId) });
    Realtime.emitTeam(req.user!.teamId, 'priority:submitted', { sequenceNo: result.sequenceNo });
    return res.json({ message: 'Priorities submitted.', result });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/:roundId/priority', requireAuth, requireRole(['FIRST_YEAR']), (req: AuthenticatedRequest, res) => {
  const roundId = parseInt(req.params.roundId);
  const prio = db.prepare('SELECT rank1, rank2, rank3, rank4, rank5, sequence_no, submitted_at FROM priorities WHERE team_id = ? AND round_id = ?')
    .get(req.user!.teamId, roundId) as any;
  if (!prio) return res.json(null);
  return res.json({
    rankings: [prio.rank1, prio.rank2, prio.rank3, prio.rank4, prio.rank5],
    sequenceNo: prio.sequence_no,
    submittedAt: prio.submitted_at
  });
});

// The team's allocated problem. The statement stays hidden until the coding timer starts.
router.get('/:roundId/assignment', requireAuth, requireRole(['FIRST_YEAR', 'SENIOR']), (req: AuthenticatedRequest, res) => {
  const roundId = parseInt(req.params.roundId);
  const state = EventEngine.getEventState();
  const alloc = AllocationEngine.getTeamAllocation(req.user!.teamId, roundId) as any;

  if (!alloc) return res.json(null);
  if (roundId === state.roundId && (state.state === 'WAITING' || state.state === 'PRIORITY_SELECTION')) return res.json(null);

  const revealed = roundId !== state.roundId || STATEMENT_VISIBLE.has(state.state);
  if (!revealed) {
    return res.json({
      allocation_id: alloc.allocation_id, team_id: alloc.team_id, round_id: alloc.round_id,
      problem_id: alloc.problem_id, priority_rank: alloc.priority_rank, allocated_at: alloc.allocated_at,
      is_override: alloc.is_override, title: alloc.title, difficulty: alloc.difficulty, weight: alloc.weight,
      statement: '', constraints: '', sample_input: '', sample_output: '',
      time_limit_ms: alloc.time_limit_ms, memory_limit_mb: alloc.memory_limit_mb, hidden: true
    });
  }
  return res.json({ ...alloc, hidden: false });
});

// First-year monitoring view: senior status without any code or judge detail.
router.get('/:roundId/team-status', requireAuth, requireRole(['FIRST_YEAR', 'SENIOR']), (req: AuthenticatedRequest, res) => {
  const roundId = parseInt(req.params.roundId);
  const teamId = req.user!.teamId;
  const state = EventEngine.getEventState();
  const activity = JudgeService.teamActivity(teamId, roundId);

  const senior = db.prepare("SELECT session_id, last_seen FROM sessions WHERE team_id = ? AND role = 'SENIOR' AND expires_at > ? ORDER BY last_seen DESC")
    .all(teamId, new Date().toISOString()) as Array<{ session_id: string; last_seen: string }>;
  const seniorOnline = senior.some(s => Realtime.isSessionConnected(s.session_id) || Date.now() - Date.parse(s.last_seen) < 45_000);

  const recentlyActive = activity.lastActivityAt
    ? Date.now() - Date.parse(activity.lastActivityAt.replace(' ', 'T') + (activity.lastActivityAt.includes('Z') ? '' : 'Z')) < 45_000
    : false;
  const last = activity.lastSubmission;

  let seniorStatus = 'NOT_STARTED';
  if (state.state !== 'CODING') seniorStatus = state.state === 'ROUND_ENDED' || RESULTS_VISIBLE.has(state.state) ? 'FINISHED' : 'WAITING';
  else if (!seniorOnline) seniorStatus = 'OFFLINE';
  else if (last?.status === 'Pending' || last?.status === 'Judging') seniorStatus = 'JUDGING';
  else if (recentlyActive) seniorStatus = 'CODING';
  else if (last) seniorStatus = 'SUBMITTED';
  else seniorStatus = 'NOT_STARTED';

  return res.json({
    seniorStatus,
    seniorOnline,
    submissionCount: activity.submissionCount,
    lastSubmission: last ? { status: last.status, passed: last.passed_count, total: last.total_cases, score: last.score, at: last.submitted_at } : null
  });
});

export default router;

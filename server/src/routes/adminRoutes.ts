import { Router, Response } from 'express';
import { requireAuth, requireRole, AuthenticatedRequest } from '../middleware/authMiddleware.js';
import { CredentialsService } from '../services/credentialsService.js';
import { EventEngine } from '../services/eventEngine.js';
import { AllocationEngine } from '../services/allocationEngine.js';
import { JudgeService } from '../services/judgeService.js';
import { ScoringService } from '../services/scoringService.js';
import { ProctorService } from '../services/proctorService.js';
import { SettingsService } from '../services/settingsService.js';
import { SimilarityService } from '../services/similarityService.js';
import { Realtime } from '../services/realtime.js';
import { db, audit, transaction } from '../db/database.js';

const router = Router();
router.use(requireAuth, requireRole(['ADMIN']));

const actor = (req: AuthenticatedRequest) => 'ADMIN';
const bad = (res: Response, err: any, status = 400) => res.status(status).json({ error: err?.message || String(err) });

/* ---------------------------------------------------------------- */
/* Overview                                                          */
/* ---------------------------------------------------------------- */
router.get('/overview', (_req, res) => {
  const state = EventEngine.getEventState();
  const teams = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status='ACTIVE' THEN 1 ELSE 0 END) AS active, SUM(locked) AS locked FROM teams").get() as any;
  const subs = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status IN ('Pending','Judging') THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN status = 'Accepted' THEN 1 ELSE 0 END) AS accepted
    FROM submissions WHERE round_id = ?`).get(state.roundId) as any;
  const viol = db.prepare("SELECT COUNT(*) AS open_count, SUM(CASE WHEN severity='HIGH' THEN 1 ELSE 0 END) AS high FROM violations WHERE reviewed = 0").get() as any;
  const allocated = (db.prepare('SELECT COUNT(*) AS c FROM allocations WHERE round_id = ?').get(state.roundId) as any).c as number;
  const sessions = CredentialsService.getActiveSessions();

  return res.json({
    state,
    teams: { total: teams.total, active: teams.active, locked: teams.locked ?? 0, online: new Set(sessions.filter(s => s.online).map(s => s.team_id)).size },
    sessions: { active: sessions.length, online: sessions.filter(s => s.online).length },
    pendingRequests: (db.prepare("SELECT COUNT(*) AS c FROM login_requests WHERE status = 'PENDING'").get() as any).c,
    priority: AllocationEngine.priorityProgress(state.roundId),
    allocation: { allocated, summary: AllocationEngine.allocationSummary(state.roundId) },
    submissions: { total: subs.total ?? 0, pending: subs.pending ?? 0, accepted: subs.accepted ?? 0 },
    violations: { open: viol.open_count ?? 0, high: viol.high ?? 0 }
  });
});

/* ---------------------------------------------------------------- */
/* Event control (state machine)                                     */
/* ---------------------------------------------------------------- */
router.post('/event/:action', (req: AuthenticatedRequest, res) => {
  try {
    const who = actor(req);
    const body = req.body ?? {};
    switch (req.params.action) {
      case 'open-priority': EventEngine.openPriority(who); break;
      case 'close-priority': EventEngine.closePriority(who); break;
      case 'rerun-allocation': EventEngine.rerunAllocation(who); break;
      case 'start-coding': EventEngine.startCoding(who, Boolean(body.force)); break;
      case 'end-coding': EventEngine.endCoding(who); break;
      case 'show-scoreboard': EventEngine.showScoreboard(who); break;
      case 'next-round': EventEngine.nextRound(who); break;
      case 'pause': EventEngine.pause(who); break;
      case 'resume': EventEngine.resume(who); break;
      case 'extend': EventEngine.extend(who, Number(body.seconds)); break;
      case 'reset':
        if (body.confirm !== 'RESET') return res.status(400).json({ error: 'Type RESET to confirm.' });
        EventEngine.resetRound(EventEngine.currentRoundId, who);
        break;
      default: return res.status(404).json({ error: 'Unknown action.' });
    }
    return res.json({ state: EventEngine.getEventState() });
  } catch (err: any) {
    return bad(res, err);
  }
});

/* ---------------------------------------------------------------- */
/* Allocation                                                        */
/* ---------------------------------------------------------------- */
router.get('/rounds/:id/allocations', (req, res) => {
  const roundId = parseInt(req.params.id);
  const rows = db.prepare(`
    SELECT t.team_id, t.team_name,
           pr.sequence_no, pr.submitted_at, pr.rank1, pr.rank2, pr.rank3, pr.rank4, pr.rank5,
           a.problem_id, a.priority_rank, a.is_override, p.title
    FROM teams t
    LEFT JOIN priorities pr ON pr.team_id = t.team_id AND pr.round_id = ?
    LEFT JOIN allocations a ON a.team_id = t.team_id AND a.round_id = ?
    LEFT JOIN problems p ON p.problem_id = a.problem_id
    WHERE t.status = 'ACTIVE'
    ORDER BY (pr.sequence_no IS NULL), pr.sequence_no, t.team_id
  `).all(roundId, roundId);
  return res.json({ rows, summary: AllocationEngine.allocationSummary(roundId) });
});

router.post('/rounds/:id/override-allocation', (req: AuthenticatedRequest, res) => {
  try {
    const roundId = parseInt(req.params.id);
    const { teamId, newProblemId, reason } = req.body ?? {};
    AllocationEngine.overrideAllocation(String(teamId), roundId, String(newProblemId), actor(req), String(reason ?? ''));
    Realtime.emitTeam(String(teamId), 'allocation:complete', { roundId, problemId: newProblemId, priorityRank: 0 });
    return res.json({ message: 'Allocation overridden.' });
  } catch (err: any) {
    return bad(res, err);
  }
});

/* ---------------------------------------------------------------- */
/* Password manager & sessions                                       */
/* ---------------------------------------------------------------- */
router.get('/login-requests', (_req, res) => res.json(CredentialsService.getPendingRequests()));

router.post('/approve-request', (req: AuthenticatedRequest, res) => {
  try {
    const { requestId } = req.body ?? {};
    if (!requestId) return res.status(400).json({ error: 'requestId is required.' });
    return res.json(CredentialsService.approveAccess(String(requestId), actor(req)));
  } catch (err: any) {
    return bad(res, err);
  }
});

router.post('/issue-password', (req: AuthenticatedRequest, res) => {
  try {
    const { requestId } = req.body ?? {};
    if (!requestId) return res.status(400).json({ error: 'requestId is required.' });
    return res.json(CredentialsService.approveAccess(String(requestId), actor(req)));
  } catch (err: any) {
    return bad(res, err);
  }
});

router.post('/reject-request', (req: AuthenticatedRequest, res) => {
  try {
    const { requestId } = req.body ?? {};
    if (!requestId) return res.status(400).json({ error: 'requestId is required.' });
    CredentialsService.rejectRequest(String(requestId), actor(req));
    return res.json({ message: 'Request rejected.' });
  } catch (err: any) {
    return bad(res, err);
  }
});

router.get('/credential-history', (_req, res) => res.json(CredentialsService.getCredentialHistory()));
router.get('/sessions', (_req, res) => res.json(CredentialsService.getActiveSessions()));

router.post('/sessions/:id/revoke', (req: AuthenticatedRequest, res) => {
  try {
    CredentialsService.revokeSession(req.params.id, actor(req));
    return res.json({ message: 'Session revoked.' });
  } catch (err: any) {
    return bad(res, err, 500);
  }
});

/* ---------------------------------------------------------------- */
/* Teams                                                             */
/* ---------------------------------------------------------------- */
router.get('/teams', (_req, res) => {
  const state = EventEngine.getEventState();
  const rid = state.roundId;
  const teams = db.prepare('SELECT team_id, team_name, status, aptitude_score, locked, lock_reason FROM teams ORDER BY team_id').all() as any[];
  const sessions = CredentialsService.getActiveSessions();
  const prio = new Map((db.prepare('SELECT team_id, sequence_no FROM priorities WHERE round_id = ?').all(rid) as any[]).map(p => [p.team_id, p.sequence_no]));
  const alloc = new Map((db.prepare('SELECT a.team_id, a.problem_id, a.priority_rank, p.title FROM allocations a JOIN problems p ON p.problem_id = a.problem_id WHERE a.round_id = ?').all(rid) as any[]).map(a => [a.team_id, a]));
  const lastSub = new Map((db.prepare(`
      SELECT s.team_id, s.status, s.passed_count, s.total_cases, s.submitted_at, c.n
      FROM submissions s
      JOIN (SELECT team_id, MAX(submitted_at) AS m, COUNT(*) AS n FROM submissions WHERE round_id = ? GROUP BY team_id) c
        ON c.team_id = s.team_id AND c.m = s.submitted_at
      WHERE s.round_id = ?`).all(rid, rid) as any[]).map(s => [s.team_id, s]));
  const viol = new Map((db.prepare('SELECT team_id, COUNT(*) AS n FROM violations WHERE reviewed = 0 GROUP BY team_id').all() as any[]).map(v => [v.team_id, v.n]));
  const board = new Map(ScoringService.leaderboard().map(r => [r.teamId, r]));

  return res.json(teams.map(t => {
    const mine = sessions.filter(s => s.team_id === t.team_id);
    const fy = mine.filter(s => s.role === 'FIRST_YEAR');
    const sr = mine.filter(s => s.role === 'SENIOR');
    const hb = mine.map(s => s.last_heartbeat).filter(Boolean).sort().pop() ?? null;
    const a = alloc.get(t.team_id);
    const ls = lastSub.get(t.team_id);
    return {
      ...t,
      firstYearOnline: fy.filter(s => s.online).length,
      seniorOnline: sr.filter(s => s.online).length,
      notFullscreen: mine.some(s => s.online && s.fullscreen === 0),
      lastHeartbeat: hb,
      prioritySeq: prio.get(t.team_id) ?? null,
      problemId: a?.problem_id ?? null,
      problemTitle: a?.title ?? null,
      priorityRank: a?.priority_rank ?? null,
      submissionCount: ls?.n ?? 0,
      lastSubmission: ls ? { status: ls.status, passed: ls.passed_count, total: ls.total_cases, at: ls.submitted_at } : null,
      openFlags: viol.get(t.team_id) ?? 0,
      totalScore: board.get(t.team_id)?.totalScore ?? 0,
      rank: board.get(t.team_id)?.rank ?? null
    };
  }));
});

router.post('/teams', (req: AuthenticatedRequest, res) => {
  try {
    const { teamId, teamName, aptitudeScore } = req.body ?? {};
    const id = String(teamId || '').trim().toUpperCase();
    const name = String(teamName || '').trim();
    if (!/^[A-Z0-9_-]{1,12}$/.test(id)) return res.status(400).json({ error: 'Team ID must be 1–12 letters, digits, - or _.' });
    if (!name) return res.status(400).json({ error: 'Team name is required.' });
    db.prepare('INSERT INTO teams (team_id, team_name, aptitude_score) VALUES (?, ?, ?)').run(id, name, Number(aptitudeScore) || 0);
    audit(actor(req), 'CREATE_TEAM', id, { name });
    return res.json({ message: 'Team created.' });
  } catch (err: any) {
    return bad(res, /UNIQUE/.test(err.message) ? new Error('That team ID already exists.') : err);
  }
});

// Bulk import: one team per line — "T33, Team Name[, aptitude]"
router.post('/teams/import', (req: AuthenticatedRequest, res) => {
  try {
    const text = String(req.body?.csv ?? '');
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return res.status(400).json({ error: 'Nothing to import.' });
    if (lines.length > 500) return res.status(400).json({ error: 'Import at most 500 teams at a time.' });

    const created: string[] = [];
    const skipped: string[] = [];
    transaction(() => {
      const insert = db.prepare('INSERT OR IGNORE INTO teams (team_id, team_name, aptitude_score) VALUES (?, ?, ?)');
      for (const line of lines) {
        const parts = line.split(',').map(p => p.trim());
        if (/^team.?id$/i.test(parts[0])) continue; // header row
        const id = (parts[0] || '').toUpperCase();
        const name = parts[1] || '';
        if (!/^[A-Z0-9_-]{1,12}$/.test(id) || !name) { skipped.push(line); continue; }
        const r = insert.run(id, name, Number(parts[2]) || 0) as any;
        (r.changes ? created : skipped).push(r.changes ? id : line);
      }
      audit(actor(req), 'IMPORT_TEAMS', 'teams', { created: created.length, skipped: skipped.length });
    });
    return res.json({ created: created.length, skipped });
  } catch (err: any) {
    return bad(res, err);
  }
});

router.patch('/teams/:id', (req: AuthenticatedRequest, res) => {
  try {
    const id = req.params.id;
    const t = db.prepare('SELECT * FROM teams WHERE team_id = ?').get(id) as any;
    if (!t) return res.status(404).json({ error: 'Team not found.' });
    const name = req.body?.teamName !== undefined ? String(req.body.teamName).trim() : t.team_name;
    const status = req.body?.status !== undefined ? String(req.body.status) : t.status;
    if (!name) return res.status(400).json({ error: 'Team name cannot be empty.' });
    if (!['ACTIVE', 'WITHDRAWN'].includes(status)) return res.status(400).json({ error: 'Status must be ACTIVE or WITHDRAWN.' });
    db.prepare('UPDATE teams SET team_name = ?, status = ? WHERE team_id = ?').run(name, status, id);
    audit(actor(req), 'UPDATE_TEAM', id, { name, status });
    return res.json({ message: 'Team updated.' });
  } catch (err: any) {
    return bad(res, err);
  }
});

router.post('/teams/:id/lock', (req: AuthenticatedRequest, res) => {
  try {
    const locked = Boolean(req.body?.locked);
    ProctorService.setLocked(req.params.id, locked, String(req.body?.reason || 'Locked by administrator'), actor(req));
    return res.json({ message: locked ? 'Team locked.' : 'Team unlocked.' });
  } catch (err: any) {
    return bad(res, err);
  }
});

/* ---------------------------------------------------------------- */
/* Problem manager                                                   */
/* ---------------------------------------------------------------- */
const DIFFICULTIES = ['Easy', 'Medium', 'Hard'];

/** Published content of the live round is frozen unless an emergency override (with a reason) is given. */
function assertEditable(problem: any, body: any) {
  const state = EventEngine.getEventState();
  const live = problem.status === 'PUBLISHED' && problem.round_id === state.roundId && state.state !== 'WAITING'
    && state.state !== 'SCOREBOARD' && state.state !== 'FINAL_LEADERBOARD';
  if (!live) return null;
  if (!body?.emergency || !String(body?.reason || '').trim()) {
    throw new Error('This problem is live. Editing needs an emergency override with a written reason.');
  }
  return String(body.reason).trim();
}

function validateForPublish(problemId: string): string[] {
  const p = db.prepare('SELECT * FROM problems WHERE problem_id = ?').get(problemId) as any;
  const issues: string[] = [];
  if (!p.title?.trim()) issues.push('Title is empty.');
  if (!p.statement?.trim()) issues.push('Statement is empty.');
  if (!p.sample_input?.trim() || !p.sample_output?.trim()) issues.push('Sample input and output are required.');
  if (!(p.weight > 0)) issues.push('Weight must be greater than 0.');
  if (!DIFFICULTIES.includes(p.difficulty)) issues.push('Difficulty must be Easy, Medium or Hard.');
  const tc = db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN hidden = 0 THEN 1 ELSE 0 END) AS pub FROM problem_test_cases WHERE problem_id = ?').get(problemId) as any;
  if (!tc.total) issues.push('Add at least one test case.');
  else if (!tc.pub) issues.push('Add at least one public (sample) test case.');
  const others = (db.prepare("SELECT COUNT(*) AS c FROM problems WHERE round_id = ? AND status = 'PUBLISHED' AND problem_id != ?").get(p.round_id, problemId) as any).c;
  if (others >= 5) issues.push('This round already has 5 published problems. Retire one first.');
  return issues;
}

router.get('/problems', (_req, res) => {
  return res.json(db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM problem_test_cases tc WHERE tc.problem_id = p.problem_id) AS test_case_count,
           (SELECT COUNT(*) FROM allocations a WHERE a.problem_id = p.problem_id) AS allocated_count
    FROM problems p ORDER BY p.round_id ASC, p.problem_id ASC
  `).all());
});

router.get('/problems/:id/test-cases', (req, res) => {
  return res.json(db.prepare('SELECT * FROM problem_test_cases WHERE problem_id = ? ORDER BY hidden ASC, rowid ASC').all(req.params.id));
});

router.post('/problems', (req: AuthenticatedRequest, res) => {
  try {
    const b = req.body ?? {};
    const roundId = parseInt(b.round_id);
    if (!db.prepare('SELECT 1 FROM rounds WHERE round_id = ?').get(roundId)) return res.status(400).json({ error: 'Unknown round.' });
    const title = String(b.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Title is required.' });
    if (!DIFFICULTIES.includes(b.difficulty)) return res.status(400).json({ error: 'Difficulty must be Easy, Medium or Hard.' });
    const weight = Number(b.weight);
    if (!(weight > 0)) return res.status(400).json({ error: 'Weight must be greater than 0.' });

    let id = String(b.problem_id || '').trim();
    if (!id) {
      const n = (db.prepare('SELECT COUNT(*) AS c FROM problems WHERE round_id = ?').get(roundId) as any).c + 1;
      id = `R${roundId}_P${n}`;
      while (db.prepare('SELECT 1 FROM problems WHERE problem_id = ?').get(id)) id = `R${roundId}_P${Math.floor(Math.random() * 900 + 100)}`;
    }
    db.prepare(`
      INSERT INTO problems (problem_id, round_id, title, difficulty, weight, capacity, remaining_capacity, statement, constraints, sample_input, sample_output, status, time_limit_ms, memory_limit_mb)
      VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 'DRAFT', ?, ?)
    `).run(id, roundId, title, b.difficulty, weight, b.statement || '', b.constraints || '', b.sample_input || '', b.sample_output || '',
      Math.max(500, Math.min(20000, Number(b.time_limit_ms) || 3000)), Math.max(32, Math.min(1024, Number(b.memory_limit_mb) || 256)));
    audit(actor(req), 'CREATE_PROBLEM', id, { title });
    return res.json({ message: 'Draft created.', problem_id: id });
  } catch (err: any) {
    return bad(res, err);
  }
});

router.put('/problems/:id', (req: AuthenticatedRequest, res) => {
  try {
    const p = db.prepare('SELECT * FROM problems WHERE problem_id = ?').get(req.params.id) as any;
    if (!p) return res.status(404).json({ error: 'Problem not found.' });
    const b = req.body ?? {};
    const emergencyReason = assertEditable(p, b);

    const title = b.title !== undefined ? String(b.title).trim() : p.title;
    const difficulty = b.difficulty !== undefined ? b.difficulty : p.difficulty;
    const weight = b.weight !== undefined ? Number(b.weight) : p.weight;
    if (!title) return res.status(400).json({ error: 'Title is required.' });
    if (!DIFFICULTIES.includes(difficulty)) return res.status(400).json({ error: 'Difficulty must be Easy, Medium or Hard.' });
    if (!(weight > 0)) return res.status(400).json({ error: 'Weight must be greater than 0.' });

    db.prepare(`
      UPDATE problems SET title = ?, difficulty = ?, weight = ?, statement = ?, constraints = ?, sample_input = ?, sample_output = ?,
        time_limit_ms = ?, memory_limit_mb = ? WHERE problem_id = ?
    `).run(title, difficulty, weight,
      b.statement ?? p.statement, b.constraints ?? p.constraints, b.sample_input ?? p.sample_input, b.sample_output ?? p.sample_output,
      Math.max(500, Math.min(20000, Number(b.time_limit_ms ?? p.time_limit_ms) || 3000)),
      Math.max(32, Math.min(1024, Number(b.memory_limit_mb ?? p.memory_limit_mb) || 256)),
      p.problem_id);
    audit(actor(req), emergencyReason ? 'EMERGENCY_EDIT_PROBLEM' : 'UPDATE_PROBLEM', p.problem_id, { reason: emergencyReason ?? undefined, weight });
    return res.json({ message: 'Problem saved.' });
  } catch (err: any) {
    return bad(res, err);
  }
});

router.get('/problems/:id/validate', (req, res) => {
  if (!db.prepare('SELECT 1 FROM problems WHERE problem_id = ?').get(req.params.id)) return res.status(404).json({ error: 'Problem not found.' });
  return res.json({ issues: validateForPublish(req.params.id) });
});

router.post('/problems/:id/publish', (req: AuthenticatedRequest, res) => {
  try {
    const p = db.prepare('SELECT * FROM problems WHERE problem_id = ?').get(req.params.id) as any;
    if (!p) return res.status(404).json({ error: 'Problem not found.' });
    const issues = validateForPublish(p.problem_id);
    if (issues.length) return res.status(400).json({ error: issues.join(' '), issues });
    db.prepare("UPDATE problems SET status = 'PUBLISHED' WHERE problem_id = ?").run(p.problem_id);
    audit(actor(req), 'PUBLISH_PROBLEM', p.problem_id);
    return res.json({ message: 'Problem published.' });
  } catch (err: any) {
    return bad(res, err);
  }
});

router.post('/problems/:id/retire', (req: AuthenticatedRequest, res) => {
  try {
    const p = db.prepare('SELECT * FROM problems WHERE problem_id = ?').get(req.params.id) as any;
    if (!p) return res.status(404).json({ error: 'Problem not found.' });
    const reason = assertEditable(p, req.body);
    db.prepare("UPDATE problems SET status = 'RETIRED' WHERE problem_id = ?").run(p.problem_id);
    audit(actor(req), reason ? 'EMERGENCY_RETIRE_PROBLEM' : 'RETIRE_PROBLEM', p.problem_id, { reason: reason ?? undefined });
    return res.json({ message: 'Problem retired.' });
  } catch (err: any) {
    return bad(res, err);
  }
});

router.delete('/problems/:id', (req: AuthenticatedRequest, res) => {
  try {
    const p = db.prepare('SELECT * FROM problems WHERE problem_id = ?').get(req.params.id) as any;
    if (!p) return res.status(404).json({ error: 'Problem not found.' });
    if (p.status !== 'DRAFT') return res.status(400).json({ error: 'Only drafts can be deleted. Retire published problems instead.' });
    db.prepare('DELETE FROM problems WHERE problem_id = ?').run(p.problem_id);
    audit(actor(req), 'DELETE_PROBLEM', p.problem_id);
    return res.json({ message: 'Draft deleted.' });
  } catch (err: any) {
    return bad(res, err);
  }
});

router.post('/problems/:id/test-cases', (req: AuthenticatedRequest, res) => {
  try {
    const p = db.prepare('SELECT * FROM problems WHERE problem_id = ?').get(req.params.id) as any;
    if (!p) return res.status(404).json({ error: 'Problem not found.' });
    const reason = assertEditable(p, req.body);
    const { input, expected_output, hidden } = req.body ?? {};
    if (typeof input !== 'string' || typeof expected_output !== 'string') return res.status(400).json({ error: 'input and expected_output are required.' });
    const id = `tc_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    db.prepare('INSERT INTO problem_test_cases (test_case_id, problem_id, input, expected_output, hidden) VALUES (?, ?, ?, ?, ?)')
      .run(id, p.problem_id, input, expected_output, hidden ? 1 : 0);
    audit(actor(req), reason ? 'EMERGENCY_ADD_TESTCASE' : 'ADD_TESTCASE', p.problem_id, { id, hidden: Boolean(hidden), reason: reason ?? undefined });
    return res.json({ message: 'Test case added.', tcId: id });
  } catch (err: any) {
    return bad(res, err);
  }
});

router.put('/test-cases/:tcId', (req: AuthenticatedRequest, res) => {
  try {
    const tc = db.prepare('SELECT * FROM problem_test_cases WHERE test_case_id = ?').get(req.params.tcId) as any;
    if (!tc) return res.status(404).json({ error: 'Test case not found.' });
    const p = db.prepare('SELECT * FROM problems WHERE problem_id = ?').get(tc.problem_id) as any;
    const reason = assertEditable(p, req.body);
    const b = req.body ?? {};
    db.prepare('UPDATE problem_test_cases SET input = ?, expected_output = ?, hidden = ? WHERE test_case_id = ?')
      .run(b.input ?? tc.input, b.expected_output ?? tc.expected_output, b.hidden === undefined ? tc.hidden : (b.hidden ? 1 : 0), tc.test_case_id);
    audit(actor(req), reason ? 'EMERGENCY_EDIT_TESTCASE' : 'EDIT_TESTCASE', tc.problem_id, { id: tc.test_case_id, reason: reason ?? undefined });
    return res.json({ message: 'Test case saved.' });
  } catch (err: any) {
    return bad(res, err);
  }
});

router.delete('/test-cases/:tcId', (req: AuthenticatedRequest, res) => {
  try {
    const tc = db.prepare('SELECT * FROM problem_test_cases WHERE test_case_id = ?').get(req.params.tcId) as any;
    if (!tc) return res.status(404).json({ error: 'Test case not found.' });
    const p = db.prepare('SELECT * FROM problems WHERE problem_id = ?').get(tc.problem_id) as any;
    const reason = assertEditable(p, req.body);
    db.prepare('DELETE FROM problem_test_cases WHERE test_case_id = ?').run(tc.test_case_id);
    audit(actor(req), reason ? 'EMERGENCY_DELETE_TESTCASE' : 'DELETE_TESTCASE', tc.problem_id, { id: tc.test_case_id, reason: reason ?? undefined });
    return res.json({ message: 'Test case deleted.' });
  } catch (err: any) {
    return bad(res, err);
  }
});

/* ---------------------------------------------------------------- */
/* Submissions                                                       */
/* ---------------------------------------------------------------- */
router.get('/submissions', (req, res) => {
  return res.json(JudgeService.getAllSubmissions({
    teamId: req.query.teamId ? String(req.query.teamId) : undefined,
    roundId: req.query.roundId ? parseInt(String(req.query.roundId)) : undefined
  }));
});

router.get('/submissions/:id', (req, res) => {
  const s = JudgeService.getSubmissionForAdmin(req.params.id);
  return s ? res.json(s) : res.status(404).json({ error: 'Submission not found.' });
});

router.post('/submissions/:id/rejudge', (req: AuthenticatedRequest, res) => {
  try {
    JudgeService.rejudge(req.params.id, actor(req));
    return res.json({ message: 'Re-queued for judging.' });
  } catch (err: any) {
    return bad(res, err);
  }
});

/* ---------------------------------------------------------------- */
/* Proctoring                                                        */
/* ---------------------------------------------------------------- */
router.get('/violations', (req, res) => {
  return res.json(ProctorService.list({
    teamId: req.query.teamId ? String(req.query.teamId) : undefined,
    severity: req.query.severity ? String(req.query.severity) : undefined
  }));
});

router.get('/violations/summary', (_req, res) => res.json(ProctorService.summary()));

router.post('/violations/:id/review', (req: AuthenticatedRequest, res) => {
  try {
    ProctorService.review(req.params.id, req.body?.reviewed !== false, String(req.body?.note || ''), actor(req));
    return res.json({ message: 'Updated.' });
  } catch (err: any) {
    return bad(res, err);
  }
});

router.get('/policy', (_req, res) => res.json({ policy: SettingsService.getPolicy(), config: SettingsService.getConfig() }));

router.put('/policy', (req: AuthenticatedRequest, res) => {
  try {
    const policy = SettingsService.setPolicy(req.body?.policy ?? {}, actor(req));
    const config = req.body?.config ? SettingsService.setConfig(req.body.config, actor(req)) : SettingsService.getConfig();
    Realtime.emitRole('FIRST_YEAR', 'proctor:policy', policy);
    Realtime.emitRole('SENIOR', 'proctor:policy', policy);
    return res.json({ policy, config });
  } catch (err: any) {
    return bad(res, err);
  }
});

router.get('/similarity-check', (req, res) => {
  const threshold = Math.max(10, Math.min(100, Number(req.query.threshold) || 50));
  return res.json(SimilarityService.analyze(threshold));
});

/* ---------------------------------------------------------------- */
/* Scores                                                            */
/* ---------------------------------------------------------------- */
router.get('/leaderboard', (_req, res) => res.json(ScoringService.leaderboard()));
router.get('/scores/adjustments', (_req, res) => res.json(ScoringService.adjustments()));

router.post('/scores/update-aptitude', (req: AuthenticatedRequest, res) => {
  try {
    ScoringService.setAptitude(String(req.body?.teamId), Number(req.body?.aptitudeScore), actor(req));
    Realtime.emitAll('leaderboard:changed', {});
    return res.json({ message: 'Aptitude score updated.' });
  } catch (err: any) {
    return bad(res, err);
  }
});

router.post('/scores/adjust', (req: AuthenticatedRequest, res) => {
  try {
    ScoringService.adjustScore(String(req.body?.teamId), Number(req.body?.delta), String(req.body?.reason || ''), actor(req));
    return res.json({ message: 'Adjustment recorded.' });
  } catch (err: any) {
    return bad(res, err);
  }
});

/* ---------------------------------------------------------------- */
/* Audit + exports                                                   */
/* ---------------------------------------------------------------- */
router.get('/audit-logs', (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Math.max(1, Math.min(1000, parseInt(String(req.query.limit)) || 200));
  if (q) {
    const like = `%${q}%`;
    return res.json(db.prepare('SELECT * FROM audit_logs WHERE actor LIKE ? OR action LIKE ? OR target LIKE ? OR metadata LIKE ? ORDER BY timestamp DESC LIMIT ?')
      .all(like, like, like, like, limit));
  }
  return res.json(db.prepare('SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT ?').all(limit));
});

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`; // neutralise spreadsheet formulas
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
}

router.get('/export/:kind', (req: AuthenticatedRequest, res) => {
  const kind = req.params.kind;
  let rows: Array<Record<string, unknown>>;
  switch (kind) {
    case 'audit': rows = db.prepare('SELECT * FROM audit_logs ORDER BY timestamp ASC').all() as any[]; break;
    case 'leaderboard': rows = ScoringService.leaderboard() as any[]; break;
    case 'violations': rows = db.prepare('SELECT violation_id, team_id, role, type, severity, timestamp, reviewed, review_note, metadata FROM violations ORDER BY timestamp ASC').all() as any[]; break;
    case 'submissions': rows = db.prepare('SELECT submission_id, team_id, round_id, problem_id, language, status, passed_count, total_cases, score, submitted_at, judged_at FROM submissions ORDER BY submitted_at ASC').all() as any[]; break;
    case 'credentials': rows = db.prepare('SELECT credential_id, team_id, role, issued_at, expires_at, used_at, revoked_at FROM temporary_credentials ORDER BY issued_at ASC').all() as any[]; break;
    default: return res.status(404).json({ error: 'Unknown export.' });
  }
  audit(actor(req), 'EXPORT', kind, { rows: rows.length });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${kind}-${new Date().toISOString().slice(0, 10)}.csv"`);
  return res.send('﻿' + toCsv(rows));
});

export default router;

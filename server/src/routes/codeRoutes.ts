import { Router } from 'express';
import { requireAuth, requireRole, requireExamEligible, AuthenticatedRequest } from '../middleware/authMiddleware.js';
import { JudgeService, SUPPORTED_LANGUAGES, MAX_SOURCE_BYTES } from '../services/judgeService.js';
import { EventEngine } from '../services/eventEngine.js';
import { SettingsService } from '../services/settingsService.js';
import { Cooldown } from '../utils/rateLimit.js';
import { db } from '../db/database.js';

/** Validates the team is in the CODING window and returns its allocated problem. */
function assertCodingAccess(teamId: string, roundId: number, problemId: string) {
  const state = EventEngine.getEventState();
  if (roundId !== state.roundId || state.state !== 'CODING') {
    const err: any = new Error('The coding window is closed.');
    err.status = 409;
    throw err;
  }
  const end = EventEngine.phaseEndsAt(roundId);
  if (end !== null && Date.now() > end) {
    const err: any = new Error('Time is up.');
    err.status = 409;
    throw err;
  }
  const alloc = db.prepare('SELECT problem_id FROM allocations WHERE team_id = ? AND round_id = ?').get(teamId, roundId) as any;
  if (!alloc || alloc.problem_id !== problemId) {
    const err: any = new Error('Your team is not allocated to this problem.');
    err.status = 403;
    throw err;
  }
}

const fail = (res: any, err: any) => res.status(err.status || 400).json({ error: err.message });

/* ------------------------------ /api/code ------------------------------ */
export const codeRouter = Router();
const runCooldown = new Cooldown(3000);

// Continuous autosave so a logout / crash never loses work.
codeRouter.post('/autosave', requireAuth, requireRole(['SENIOR']), requireExamEligible, (req: AuthenticatedRequest, res) => {
  try {
    const { roundId, problemId, sourceCode, language } = req.body ?? {};
    const teamId = req.user!.teamId;
    const rid = parseInt(roundId);
    if (!rid || typeof problemId !== 'string') return res.status(400).json({ error: 'roundId and problemId are required.' });
    if (typeof sourceCode !== 'string' || Buffer.byteLength(sourceCode, 'utf8') > MAX_SOURCE_BYTES) {
      return res.status(400).json({ error: 'Source code missing or too large.' });
    }
    const lang = String(language || 'python').toLowerCase();
    if (!(SUPPORTED_LANGUAGES as readonly string[]).includes(lang)) return res.status(400).json({ error: 'Unsupported language.' });

    assertCodingAccess(teamId, rid, problemId);

    db.prepare(`
      INSERT INTO code_autosaves (team_id, round_id, problem_id, source_code, language, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(team_id, round_id, problem_id) DO UPDATE SET
        source_code = excluded.source_code, language = excluded.language, updated_at = CURRENT_TIMESTAMP
    `).run(teamId, rid, problemId, sourceCode, lang);

    return res.json({ savedAt: new Date().toISOString() });
  } catch (err: any) {
    return fail(res, err);
  }
});

// A re-authenticated senior from the same team restores the team's code.
codeRouter.get('/autosave', requireAuth, requireRole(['SENIOR']), (req: AuthenticatedRequest, res) => {
  const roundId = parseInt(req.query.roundId as string);
  const problemId = String(req.query.problemId || '');
  const saved = db.prepare('SELECT source_code, language, updated_at FROM code_autosaves WHERE team_id = ? AND round_id = ? AND problem_id = ?')
    .get(req.user!.teamId, roundId, problemId);
  return res.json(saved || null);
});

// "Run" – public samples (and optional custom input) only. Never touches hidden tests.
codeRouter.post('/run', requireAuth, requireRole(['SENIOR']), requireExamEligible, async (req: AuthenticatedRequest, res) => {
  try {
    if (!SettingsService.getPolicy().allowRun) return res.status(403).json({ error: 'Running code is disabled for this event.' });
    const { roundId, problemId, sourceCode, language, customInput } = req.body ?? {};
    const teamId = req.user!.teamId;
    assertCodingAccess(teamId, parseInt(roundId), String(problemId));

    const wait = runCooldown.check(teamId);
    if (wait) return res.status(429).json({ error: `Please wait ${wait}s before running again.` });

    const result = await JudgeService.runSamples(String(problemId), String(sourceCode ?? ''), String(language), customInput);
    return res.json(result);
  } catch (err: any) {
    return fail(res, err);
  }
});

/* --------------------------- /api/submissions --------------------------- */
export const submissionRouter = Router();
const submitCooldown = new Cooldown(5000);

submissionRouter.post('/', requireAuth, requireRole(['SENIOR']), requireExamEligible, (req: AuthenticatedRequest, res) => {
  try {
    const { roundId, problemId, sourceCode, language } = req.body ?? {};
    const teamId = req.user!.teamId;
    const rid = parseInt(roundId);
    if (!rid || typeof problemId !== 'string' || typeof sourceCode !== 'string' || !language) {
      return res.status(400).json({ error: 'roundId, problemId, sourceCode and language are required.' });
    }

    assertCodingAccess(teamId, rid, problemId);

    const cooldownMs = SettingsService.getConfig().submitCooldownSeconds * 1000;
    const wait = submitCooldown.check(teamId, cooldownMs);
    if (wait) return res.status(429).json({ error: `Please wait ${wait}s before submitting again.` });

    const submission = JudgeService.submitCode(teamId, rid, problemId, sourceCode, language, EventEngine.phaseEndsAt(rid));
    return res.status(202).json(submission);
  } catch (err: any) {
    return fail(res, err);
  }
});

submissionRouter.get('/my', requireAuth, requireRole(['SENIOR']), (req: AuthenticatedRequest, res) => {
  const roundId = parseInt(req.query.roundId as string) || EventEngine.currentRoundId;
  return res.json(JudgeService.getTeamSubmissions(req.user!.teamId, roundId));
});

submissionRouter.get('/:id', requireAuth, requireRole(['SENIOR', 'ADMIN']), (req: AuthenticatedRequest, res) => {
  const sub = JudgeService.publicSubmission(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Submission not found.' });
  if (req.user!.role !== 'ADMIN' && sub.team_id !== req.user!.teamId) return res.status(403).json({ error: 'Forbidden.' });
  return res.json(sub);
});

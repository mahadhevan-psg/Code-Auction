import { Router } from 'express';
import { requireAuth, requireRole, AuthenticatedRequest } from '../middleware/authMiddleware.js';
import { ProctorService, VIOLATION_TYPES } from '../services/proctorService.js';
import { SettingsService } from '../services/settingsService.js';
import { rateLimit } from '../utils/rateLimit.js';
import { db } from '../db/database.js';

const router = Router();

/** Keep metadata small and flat – it is client-supplied. */
function sanitizeMeta(input: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!input || typeof input !== 'object') return out;
  for (const [k, v] of Object.entries(input as Record<string, unknown>).slice(0, 12)) {
    if (typeof v === 'string') out[k.slice(0, 40)] = v.slice(0, 200);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k.slice(0, 40)] = v;
  }
  return out;
}

// What the client must enforce, plus the participant's own tally.
router.get('/policy', requireAuth, requireRole(['FIRST_YEAR', 'SENIOR']), (req: AuthenticatedRequest, res) => {
  const team = db.prepare('SELECT locked, lock_reason FROM teams WHERE team_id = ?').get(req.user!.teamId) as any;
  return res.json({
    policy: SettingsService.getPolicy(),
    counts: ProctorService.counts(req.user!.teamId),
    locked: Boolean(team?.locked),
    lockReason: team?.lock_reason ?? null,
    labels: Object.fromEntries(Object.entries(VIOLATION_TYPES).map(([k, v]) => [k, v.label]))
  });
});

const reportLimiter = rateLimit({
  windowMs: 10_000, max: 40,
  key: req => (req.headers['x-session-id'] as string) || req.ip || 'unknown'
});

// Malpractice telemetry. Recorded as flags for review – never as automatic guilt.
router.post('/violation', reportLimiter, requireAuth, requireRole(['FIRST_YEAR', 'SENIOR']), (req: AuthenticatedRequest, res) => {
  try {
    const { type, metadata } = req.body ?? {};
    if (typeof type !== 'string') return res.status(400).json({ error: 'Violation type is required.' });

    const out = ProctorService.record({
      teamId: req.user!.teamId,
      role: req.user!.role,
      sessionId: req.user!.sessionId,
      type,
      metadata: sanitizeMeta(metadata)
    });
    return res.json({ ok: true, counts: out ? { total: out.total, serious: out.serious } : ProctorService.counts(req.user!.teamId) });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

export default router;

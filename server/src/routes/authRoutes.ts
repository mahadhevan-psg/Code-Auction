import { Router } from 'express';
import crypto from 'crypto';
import { CredentialsService } from '../services/credentialsService.js';
import { requireAuth, AuthenticatedRequest } from '../middleware/authMiddleware.js';
import { rateLimit } from '../utils/rateLimit.js';
import { SettingsService } from '../services/settingsService.js';
import { ProctorService } from '../services/proctorService.js';
import { db, audit } from '../db/database.js';

const router = Router();

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
if (!process.env.ADMIN_PASSWORD) {
  console.warn('[security] ADMIN_PASSWORD is not set – using the insecure default. Set it in server/.env before the event.');
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const requestLimiter = rateLimit({
  windowMs: 60_000, max: 8,
  key: req => `${req.ip}|${req.body?.teamId ?? ''}|${req.body?.role ?? ''}`,
  message: 'Too many password requests. Wait a minute and try again.'
});
const loginLimiter = rateLimit({
  windowMs: 60_000, max: 10,
  key: req => `${req.ip}|${req.body?.teamId ?? ''}`,
  message: 'Too many login attempts. Wait a minute and try again.'
});

// Public: lets the login screen show real teams instead of a hard-coded list.
router.get('/teams', (_req, res) => {
  const teams = db.prepare("SELECT team_id, team_name FROM teams WHERE status = 'ACTIVE' ORDER BY team_id").all();
  return res.json({ teams, pinRequired: Boolean(SettingsService.getConfig().eventPin) });
});

// Participant asks for a temporary password; it lands in the admin Password Manager.
router.post('/request-password', requestLimiter, (req, res) => {
  try {
    const { teamId, role, pin } = req.body ?? {};
    const request = CredentialsService.requestPassword(String(teamId || '').trim().toUpperCase(), String(role || ''), pin);
    return res.json({ message: 'Password request sent to the administrator.', request });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/request-status', (req, res) => {
  return res.json(CredentialsService.getRequestStatus(req.query.requestId as string | undefined));
});

// Participants: one-time password. Admin: the configured admin password.
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { teamId, role, password } = req.body ?? {};
    if (typeof password !== 'string' || !password) return res.status(400).json({ error: 'Password is required.' });
    const ip = req.ip || 'unknown';

    if (role === 'ADMIN') {
      if (!safeEqual(password, ADMIN_PASSWORD)) {
        audit('ADMIN', 'ADMIN_LOGIN_FAILED', 'admin', { ip });
        return res.status(401).json({ error: 'Invalid administrator password.' });
      }
      const session = CredentialsService.createAdminSession(ip);
      res.cookie('sessionId', session.sessionId, { httpOnly: true, sameSite: 'lax', maxAge: 8 * 3600_000 });
      return res.json(session);
    }

    const session = await CredentialsService.login(String(teamId || '').trim().toUpperCase(), String(role || ''), password, ip);
    res.cookie('sessionId', session.sessionId, { httpOnly: true, sameSite: 'lax', maxAge: 8 * 3600_000 });
    return res.json(session);
  } catch (err: any) {
    return res.status(401).json({ error: err.message });
  }
});

router.post('/logout', requireAuth, (req: AuthenticatedRequest, res) => {
  try {
    CredentialsService.revokeSession(req.user!.sessionId, `${req.user!.teamId}:${req.user!.role}`, 'LOGOUT');
    res.clearCookie('sessionId');
    return res.json({ message: 'Logged out.' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/me', requireAuth, (req: AuthenticatedRequest, res) => {
  const u = req.user!;
  const team = u.role === 'ADMIN' ? null : db.prepare('SELECT team_name, locked, lock_reason FROM teams WHERE team_id = ?').get(u.teamId) as any;
  return res.json({
    user: {
      sessionId: u.sessionId,
      teamId: u.teamId,
      role: u.role,
      teamName: team?.team_name ?? null,
      rulesAcked: u.rulesAcked,
      locked: Boolean(team?.locked),
      lockReason: team?.lock_reason ?? null
    }
  });
});

// Participant accepts the exam rules (required before any protected action when the policy says so).
router.post('/ack-rules', requireAuth, (req: AuthenticatedRequest, res) => {
  const u = req.user!;
  if (u.role === 'ADMIN') return res.json({ ok: true });
  CredentialsService.acknowledgeRules(u.sessionId);
  ProctorService.record({ teamId: u.teamId, role: u.role, sessionId: u.sessionId, type: 'RULES_ACKNOWLEDGED' });
  return res.json({ ok: true });
});

export default router;

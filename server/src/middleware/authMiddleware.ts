import { Request, Response, NextFunction } from 'express';
import { CredentialsService } from '../services/credentialsService.js';
import { SettingsService } from '../services/settingsService.js';
import { db } from '../db/database.js';

export type Role = 'FIRST_YEAR' | 'SENIOR' | 'ADMIN';

export interface AuthenticatedRequest extends Request {
  user?: {
    sessionId: string;
    teamId: string;
    role: Role;
    rulesAcked: boolean;
  };
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const sessionId = (req.headers['x-session-id'] as string) || req.cookies?.sessionId;
  if (!sessionId) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const session = CredentialsService.getSession(sessionId);
  if (!session) {
    return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
  }

  req.user = {
    sessionId: session.session_id,
    teamId: session.team_id,
    role: session.role,
    rulesAcked: Boolean(session.rules_ack_at)
  };
  next();
}

export function requireRole(allowedRoles: Role[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized.' });
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: `Role '${req.user.role}' cannot perform this action.` });
    }
    next();
  };
}

/** Participants must have accepted the exam rules (when the policy requires it) and not be locked by proctoring. */
export function requireExamEligible(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized.' });
  if (req.user.role === 'ADMIN') return next();

  const policy = SettingsService.getPolicy();
  if (policy.requireAck && !req.user.rulesAcked) {
    return res.status(428).json({ error: 'Accept the exam rules before continuing.', code: 'RULES_NOT_ACCEPTED' });
  }

  const team = db.prepare('SELECT locked, lock_reason FROM teams WHERE team_id = ?').get(req.user.teamId) as any;
  if (team?.locked) {
    return res.status(423).json({
      error: `Your team is locked by the proctor${team.lock_reason ? `: ${team.lock_reason}` : ''}. Contact an administrator.`,
      code: 'TEAM_LOCKED'
    });
  }
  next();
}

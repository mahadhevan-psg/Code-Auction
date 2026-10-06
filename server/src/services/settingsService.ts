import { getSetting, setSetting, audit } from '../db/database.js';

export interface ProctorPolicy {
  /** Participants must stay in fullscreen while a round phase is active. */
  requireFullscreen: boolean;
  /** Block copy/cut/paste outside the editor, and paste of text that did not originate in the editor. */
  blockClipboard: boolean;
  blockContextMenu: boolean;
  /** Block selecting/copying the problem statement text. */
  blockSelection: boolean;
  blockShortcuts: boolean;
  detectDevtools: boolean;
  /** Participant must accept the rules before any protected action. */
  requireAck: boolean;
  /** Enable the "Run on samples" button for seniors. */
  allowRun: boolean;
  /** Warnings shown to a participant before the UI says "flagged for review". */
  warnAfter: number;
  /** Auto-lock a team after N medium/high flags (0 = never; admin locks manually). */
  autoLockThreshold: number;
  /** Automatically force logout if the participant switches browser tabs. */
  autoLogoutOnTabSwitch: boolean;
  /** Automatically force logout if the participant window/system loses focus. */
  autoLogoutOnBlur: boolean;
  /** Automatically force logout after N seconds of inactivity/idle (0 = disabled). */
  idleTimeoutSeconds: number;
}

export const DEFAULT_POLICY: ProctorPolicy = {
  requireFullscreen: true,
  blockClipboard: true,
  blockContextMenu: true,
  blockSelection: true,
  blockShortcuts: true,
  detectDevtools: true,
  requireAck: true,
  allowRun: true,
  warnAfter: 3,
  autoLockThreshold: 0,
  autoLogoutOnTabSwitch: true,
  autoLogoutOnBlur: true,
  idleTimeoutSeconds: 120
};

export interface EventConfig {
  maxSessionsFirstYear: number;
  maxSessionsSenior: number;
  passwordTtlMinutes: number;
  /** Optional event PIN a participant must enter to request a password. Empty = disabled. */
  eventPin: string;
  submitCooldownSeconds: number;
}

export const DEFAULT_CONFIG: EventConfig = {
  maxSessionsFirstYear: 2,
  maxSessionsSenior: 3,
  passwordTtlMinutes: 8,
  eventPin: '',
  submitCooldownSeconds: 5
};

export class SettingsService {
  static getPolicy(): ProctorPolicy {
    return { ...DEFAULT_POLICY, ...getSetting<Partial<ProctorPolicy>>('proctor_policy', {}) };
  }

  static setPolicy(patch: Partial<ProctorPolicy>, actor: string): ProctorPolicy {
    const next = { ...this.getPolicy() };
    for (const key of Object.keys(DEFAULT_POLICY) as Array<keyof ProctorPolicy>) {
      if (patch[key] === undefined) continue;
      const def = DEFAULT_POLICY[key];
      if (typeof def === 'boolean') (next as any)[key] = Boolean(patch[key]);
      else (next as any)[key] = Math.max(0, Math.min(100, Math.floor(Number(patch[key]) || 0)));
    }
    setSetting('proctor_policy', next);
    audit(actor, 'UPDATE_PROCTOR_POLICY', 'policy', next);
    return next;
  }

  static getConfig(): EventConfig {
    return { ...DEFAULT_CONFIG, ...getSetting<Partial<EventConfig>>('event_config', {}) };
  }

  static setConfig(patch: Partial<EventConfig>, actor: string): EventConfig {
    const cur = this.getConfig();
    const next: EventConfig = {
      maxSessionsFirstYear: clampInt(patch.maxSessionsFirstYear, cur.maxSessionsFirstYear, 1, 10),
      maxSessionsSenior: clampInt(patch.maxSessionsSenior, cur.maxSessionsSenior, 1, 10),
      passwordTtlMinutes: clampInt(patch.passwordTtlMinutes, cur.passwordTtlMinutes, 1, 60),
      eventPin: patch.eventPin === undefined ? cur.eventPin : String(patch.eventPin).slice(0, 32),
      submitCooldownSeconds: clampInt(patch.submitCooldownSeconds, cur.submitCooldownSeconds, 0, 120)
    };
    setSetting('event_config', next);
    audit(actor, 'UPDATE_EVENT_CONFIG', 'config', { ...next, eventPin: next.eventPin ? '***' : '' });
    return next;
  }
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

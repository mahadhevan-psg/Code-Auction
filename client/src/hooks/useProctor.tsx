import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../services/api';
import { socket } from '../socket/socket';
import { useToast } from '../components/ui';
import type { EventState, ProctorPolicy, UserSession } from '../types';

const DEFAULT_POLICY: ProctorPolicy = {
  requireFullscreen: true, blockClipboard: true, blockContextMenu: true, blockSelection: true,
  blockShortcuts: true, detectDevtools: true, requireAck: true, allowRun: true, warnAfter: 3, autoLockThreshold: 0,
  autoLogoutOnTabSwitch: true, autoLogoutOnBlur: true, idleTimeoutSeconds: 120
};

export interface ProctorApi {
  /** True for participants (not admin). */
  enabled: boolean;
  policy: ProctorPolicy;
  /** A secure phase is running: restrictions are being enforced and flags are recorded. */
  active: boolean;
  acked: boolean;
  counts: { total: number; serious: number };
  flagged: boolean;
  locked: boolean;
  lockReason: string | null;
  isFullscreen: boolean;
  /** Fullscreen is required right now but missing: the UI must be blocked. */
  needsFullscreen: boolean;
  enterFullscreen: () => Promise<void>;
  acknowledge: () => Promise<void>;
  report: (type: string, meta?: Record<string, unknown>) => void;
  /** Text that may legitimately be pasted into the editor (e.g. a copied sample input). */
  allowClipboardText: (text: string) => void;
  /** True if an editor-originated paste was just allowed (so it is not also flagged as a large insert). */
  recentAllowedPaste: () => boolean;
}

const noop = async () => {};
const Ctx = createContext<ProctorApi>({
  enabled: false, policy: DEFAULT_POLICY, active: false, acked: true, counts: { total: 0, serious: 0 },
  flagged: false, locked: false, lockReason: null, isFullscreen: false, needsFullscreen: false,
  enterFullscreen: noop, acknowledge: noop, report: () => {}, allowClipboardText: () => {}, recentAllowedPaste: () => false
});
export const useProctor = () => useContext(Ctx);

/** Which phases are "secure" for each role. */
export function isSecurePhase(role: string, stage: EventState['state']): boolean {
  if (role === 'FIRST_YEAR') return stage === 'PRIORITY_SELECTION' || stage === 'ALLOCATION' || stage === 'CODING';
  if (role === 'SENIOR') return stage === 'ALLOCATION' || stage === 'CODING';
  return false;
}

let reloadChecked = false;
const norm = (s: string) => s.replace(/\r\n/g, '\n');
const inEditor = (t: EventTarget | null) => t instanceof Element && !!t.closest('[data-editor]');
const allowsPaste = (t: EventTarget | null) => t instanceof Element && !!t.closest('[data-allow-paste]');

export const ProctorProvider: React.FC<{
  user: UserSession | null;
  eventState: EventState;
  onAcked: () => void;
  children: React.ReactNode;
}> = ({ user, eventState, onAcked, children }) => {
  const toast = useToast();
  const enabled = !!user && user.role !== 'ADMIN';
  const role = user?.role ?? 'ADMIN';

  const [policy, setPolicy] = useState<ProctorPolicy>(DEFAULT_POLICY);
  const [counts, setCounts] = useState({ total: 0, serious: 0 });
  const [locked, setLocked] = useState(false);
  const [lockReason, setLockReason] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(!!document.fullscreenElement);
  const [labels, setLabels] = useState<Record<string, string>>({});

  const acked = !enabled || !policy.requireAck || !!user?.rulesAcked;
  const active = enabled && acked && isSecurePhase(role, eventState.state) && !locked;
  const needsFullscreen = active && policy.requireFullscreen && !isFullscreen;

  // Latest values for long-lived listeners.
  const live = useRef({ active, policy, labels, role });
  live.current = { active, policy, labels, role };
  const internalClip = useRef<string | null>(null);
  const lastAllowedPaste = useRef(0);
  const lastLocal = useRef<Record<string, number>>({});
  const queue = useRef<Array<{ type: string; meta: Record<string, unknown> }>>([]);

  /* ---------------- load policy / lock state ---------------- */
  useEffect(() => {
    if (!enabled) return;
    api.getPolicy().then(r => {
      setPolicy(r.policy); setCounts(r.counts); setLocked(r.locked); setLockReason(r.lockReason); setLabels(r.labels);
    }).catch(() => {});
    const onPolicy = (p: ProctorPolicy) => setPolicy(p);
    const onLock = (p: { locked: boolean; reason: string | null }) => { setLocked(p.locked); setLockReason(p.reason); };
    socket.on('proctor:policy', onPolicy);
    socket.on('proctor:lock', onLock);
    return () => { socket.off('proctor:policy', onPolicy); socket.off('proctor:lock', onLock); };
  }, [enabled, user?.sessionId]);

  /* ---------------- reporting (with offline retry) ---------------- */
  const flush = useCallback(async () => {
    while (queue.current.length) {
      const item = queue.current[0];
      try {
        const r = await api.reportViolation(item.type, item.meta);
        setCounts(r.counts);
        queue.current.shift();
      } catch (e: any) {
        if (e?.status && e.status < 500 && e.status !== 429) queue.current.shift(); // permanent failure, drop
        else break; // keep for the next reconnect
      }
    }
  }, []);

  const report = useCallback((type: string, meta: Record<string, unknown> = {}) => {
    if (!live.current.active) return;
    const now = Date.now();
    if (now - (lastLocal.current[type] ?? 0) < 1000) return;
    lastLocal.current[type] = now;
    queue.current.push({ type, meta });
    void flush();

    const label = live.current.labels[type] || type.replace(/_/g, ' ').toLowerCase();
    toast('warn', `Recorded: ${label}.`, 3500);
  }, [flush, toast]);

  useEffect(() => {
    if (!enabled) return;
    const retry = () => { void flush(); };
    socket.on('connect', retry);
    window.addEventListener('online', retry);
    return () => { socket.off('connect', retry); window.removeEventListener('online', retry); };
  }, [enabled, flush]);

  /* ---------------- fullscreen ---------------- */
  useEffect(() => {
    const onChange = () => {
      const fs = !!document.fullscreenElement;
      setIsFullscreen(fs);
      if (!fs && live.current.active && live.current.policy.requireFullscreen) report('FULLSCREEN_EXIT');
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [report]);

  const enterFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      // Where supported, make Esc require a long press so it is not an accidental exit.
      (navigator as any).keyboard?.lock?.(['Escape']).catch?.(() => {});
    } catch {
      toast('err', 'Your browser refused fullscreen. Click the button again or press F11.');
    }
  }, [toast]);

  const acknowledge = useCallback(async () => {
    await api.ackRules();
    onAcked();
    if (live.current.policy.requireFullscreen) await enterFullscreen();
  }, [onAcked, enterFullscreen]);

  const allowClipboardText = useCallback((text: string) => { internalClip.current = norm(text); }, []);
  const recentAllowedPaste = useCallback(() => Date.now() - lastAllowedPaste.current < 1500, []);

  /* ---------------- enforcement listeners ---------------- */
  useEffect(() => {
    if (!active) return;
    const p = policy;

    // Entering the secure phase: environment checks.
    if ((window.screen as any)?.isExtended) report('MULTI_MONITOR');
    // A reload counts only if the page was already inside a secure phase when it was reloaded.
    try {
      if (!reloadChecked) {
        reloadChecked = true;
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        if (nav?.type === 'reload' && sessionStorage.getItem('secureSession') === '1') report('RELOAD');
      }
      sessionStorage.setItem('secureSession', '1');
    } catch { /* ignore */ }

    const onVisibility = () => { if (document.hidden) report('TAB_SWITCH'); };

    let blurTimer: ReturnType<typeof setTimeout> | null = null;
    const onBlur = () => {
      blurTimer = setTimeout(() => {
        if (!document.hidden && !document.hasFocus()) report('FOCUS_LOST');
      }, 350);
    };
    const onFocus = () => { if (blurTimer) clearTimeout(blurTimer); };

    const onCopyCut = (e: ClipboardEvent) => {
      if (!p.blockClipboard) return;
      if (inEditor(e.target)) {
        // Remember what was copied inside the editor so it can be pasted back in.
        const text = e.clipboardData?.getData('text/plain');
        if (text) internalClip.current = norm(text);
        else {
          const sel = window.getSelection()?.toString();
          if (sel) internalClip.current = norm(sel);
        }
        return;
      }
      if (e.target instanceof Element && e.target.closest('[data-allow-copy]')) return;
      e.preventDefault();
      report('COPY_BLOCKED', { kind: e.type });
    };

    const onPaste = (e: ClipboardEvent) => {
      if (!p.blockClipboard) return;
      if (allowsPaste(e.target)) return;
      const text = norm(e.clipboardData?.getData('text/plain') ?? '');
      if (inEditor(e.target) && text && internalClip.current !== null && text === internalClip.current) {
        lastAllowedPaste.current = Date.now();
        return; // pasting text copied from the editor itself
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      report('PASTE_BLOCKED', { length: text.length });
    };

    const onContext = (e: MouseEvent) => {
      if (!p.blockContextMenu) return;
      e.preventDefault();
      report('CONTEXT_MENU');
    };

    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      report('DROP_BLOCKED');
    };
    const onDragOver = (e: DragEvent) => { e.preventDefault(); };
    const onDragStart = (e: DragEvent) => {
      // allow the ranking list's own drag handles; nothing else is draggable
      if (e.target instanceof Element && e.target.closest('[data-draggable]')) return;
      e.preventDefault();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!p.blockShortcuts) return;
      const k = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      const blocked =
        e.key === 'F12' ||
        (ctrl && e.shiftKey && ['i', 'j', 'c', 'k'].includes(k)) ||
        (ctrl && ['u', 's', 'p', 'o'].includes(k) && !e.shiftKey);
      if (blocked) {
        e.preventDefault();
        e.stopPropagation();
        report('BLOCKED_SHORTCUT', { key: `${ctrl ? 'Ctrl+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.key}` });
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'PrintScreen') {
        report('PRINT_ATTEMPT', { key: 'PrintScreen' });
        try { void navigator.clipboard.writeText(''); } catch { /* clipboard blocked */ }
      }
    };
    const onBeforePrint = () => report('PRINT_ATTEMPT', { key: 'print' });

    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };

    let devOpen = false;
    const devtoolsTimer = p.detectDevtools ? setInterval(() => {
      const wide = window.outerWidth - window.innerWidth > 170;
      const tall = window.outerHeight - window.innerHeight > 320;
      const open = wide || tall;
      if (open && !devOpen) report('DEVTOOLS_SUSPECTED', { w: window.outerWidth - window.innerWidth, h: window.outerHeight - window.innerHeight });
      devOpen = open;
    }, 2000) : null;

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('copy', onCopyCut, true);
    document.addEventListener('cut', onCopyCut, true);
    document.addEventListener('paste', onPaste, true);
    document.addEventListener('contextmenu', onContext, true);
    document.addEventListener('drop', onDrop, true);
    document.addEventListener('dragover', onDragOver, true);
    document.addEventListener('dragstart', onDragStart, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('beforeprint', onBeforePrint);
    window.addEventListener('beforeunload', onBeforeUnload);
    if (p.blockSelection) document.body.classList.add('exam-mode');

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('copy', onCopyCut, true);
      document.removeEventListener('cut', onCopyCut, true);
      document.removeEventListener('paste', onPaste, true);
      document.removeEventListener('contextmenu', onContext, true);
      document.removeEventListener('drop', onDrop, true);
      document.removeEventListener('dragover', onDragOver, true);
      document.removeEventListener('dragstart', onDragStart, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('beforeprint', onBeforePrint);
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (blurTimer) clearTimeout(blurTimer);
      if (devtoolsTimer) clearInterval(devtoolsTimer);
      document.body.classList.remove('exam-mode');
    };
  }, [active, policy, report]);

  // Leaving a secure phase clears the marker (a page unload does not run this).
  useEffect(() => {
    if (!active) { try { sessionStorage.removeItem('secureSession'); } catch { /* ignore */ } }
  }, [active]);

  /* ---------------- heartbeat to the admin monitor ---------------- */
  useEffect(() => {
    if (!enabled) return;
    const beat = () => socket.emit('proctor:heartbeat', {
      fullscreen: !!document.fullscreenElement,
      focused: document.hasFocus() && !document.hidden
    });
    beat();
    const id = setInterval(beat, 10_000);
    return () => clearInterval(id);
  }, [enabled]);

  const value = useMemo<ProctorApi>(() => ({
    enabled, policy, active, acked, counts, locked, lockReason, isFullscreen, needsFullscreen,
    flagged: counts.total >= policy.warnAfter && policy.warnAfter > 0,
    enterFullscreen, acknowledge, report, allowClipboardText, recentAllowedPaste
  }), [enabled, policy, active, acked, counts, locked, lockReason, isFullscreen, needsFullscreen, enterFullscreen, acknowledge, report, allowClipboardText, recentAllowedPaste]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

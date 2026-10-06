import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { socket, authenticateSocket } from './socket/socket';
import { api, getSessionId } from './services/api';
import { useEventState } from './hooks/useEventState';
import { ProctorProvider, useProctor } from './hooks/useProctor';
import { TopBar } from './components/TopBar';
import { PhaseBar } from './components/PhaseBar';
import { FlagNotice, FullscreenGate, LockScreen, RulesGate } from './components/ProctorOverlays';
import { Spinner, useToast } from './components/ui';
import { Login } from './pages/Login';
import { FirstYearDashboard } from './pages/FirstYearDashboard';
import { AdminDashboard } from './pages/AdminDashboard';
import type { UserRole, UserSession } from './types';

// The code editor (Monaco) is large; only seniors ever download it.
const SeniorDashboard = lazy(() => import('./pages/SeniorDashboard').then(m => ({ default: m.SeniorDashboard })));

type Theme = 'dark' | 'light';

/** Participant shell: phase bar, proctor gates, and the role dashboard. */
const ParticipantApp: React.FC<{
  user: UserSession;
  eventState: ReturnType<typeof useEventState>['state'];
  remaining: number;
  theme: Theme;
  scoreRefresh: number;
}> = ({ user, eventState, remaining, theme, scoreRefresh }) => {
  const proctor = useProctor();
  const needsRules = proctor.enabled && proctor.policy.requireAck && !user.rulesAcked;
  const blocked = needsRules || proctor.locked || proctor.needsFullscreen;

  return (
    <>
      {/* The contest is removed from view (not merely covered) while a gate is up. */}
      <div className="page" style={blocked ? { visibility: 'hidden' } : undefined} aria-hidden={blocked} {...(blocked ? { inert: true } : {})}>
        <div className="stack">
          <div className="card" style={{ padding: '10px 14px' }}>
            <PhaseBar stage={eventState.state} roundNumber={eventState.roundNumber} totalRounds={eventState.totalRounds} />
          </div>
          <FlagNotice />
          {user.role === 'FIRST_YEAR' ? (
            <FirstYearDashboard user={user} eventState={eventState} remaining={remaining} scoreRefresh={scoreRefresh} />
          ) : (
            <Suspense fallback={<div className="card"><div className="empty"><Spinner size={26} /><h4>Loading editor…</h4></div></div>}>
              <SeniorDashboard user={user} eventState={eventState} remaining={remaining} theme={theme} blocked={blocked} />
            </Suspense>
          )}
        </div>
      </div>
      {needsRules && <RulesGate role={user.role} teamId={user.teamId} />}
      {!needsRules && proctor.locked && <LockScreen teamId={user.teamId} />}
      {!needsRules && !proctor.locked && proctor.needsFullscreen && <FullscreenGate />}
    </>
  );
};

export const App: React.FC = () => {
  const toast = useToast();
  const [user, setUser] = useState<UserSession | null>(null);
  const [booting, setBooting] = useState(true);
  const [score, setScore] = useState<number | null>(null);
  const [scoreTick, setScoreTick] = useState(0);
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.getAttribute('data-theme') as Theme) || 'dark');
  const { state: eventState, remaining, connected } = useEventState();

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); } catch { /* storage blocked */ }
  }, [theme]);

  const clearSession = useCallback((message?: string) => {
    try { localStorage.removeItem('sessionId'); } catch { /* ignore */ }
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    setUser(null);
    setScore(null);
    if (message) toast('warn', message, 7000);
  }, [toast]);

  /* restore session on load */
  useEffect(() => {
    if (!getSessionId()) { setBooting(false); return; }
    api.getMe()
      .then(r => { setUser(r.user); authenticateSocket(getSessionId()); })
      .catch(() => { try { localStorage.removeItem('sessionId'); } catch { /* ignore */ } })
      .finally(() => setBooting(false));
  }, []);

  /* session killed elsewhere (admin force-logout, expiry) */
  useEffect(() => {
    const onExpired = () => clearSession('Your session ended. Please log in again.');
    const onRevoked = (p: { reason?: string }) => clearSession(p?.reason || 'You were logged out.');
    window.addEventListener('auth:expired', onExpired);
    socket.on('session:revoked', onRevoked);
    return () => { window.removeEventListener('auth:expired', onExpired); socket.off('session:revoked', onRevoked); };
  }, [clearSession]);

  /* Automatic force logout on tab switch, system focus loss, or idle inactivity for participants */
  useEffect(() => {
    if (!user || user.role === 'ADMIN') return;

    let isLoggingOut = false;
    const forceLogout = async (reason: string) => {
      if (isLoggingOut) return;
      isLoggingOut = true;
      try {
        await api.reportViolation('AUTO_LOGOUT', { reason });
      } catch { /* ignore */ }
      try {
        await api.logout();
      } catch { /* ignore */ }
      clearSession(reason);
    };

    // 1. Tab switch
    const onVisibilityChange = () => {
      if (document.hidden) {
        void forceLogout('Security Action: Automatically logged out due to tab switch.');
      }
    };

    // 2. Focus loss (system window blur)
    let blurTimer: ReturnType<typeof setTimeout> | null = null;
    const onBlur = () => {
      blurTimer = setTimeout(() => {
        if (!document.hidden && !document.hasFocus()) {
          void forceLogout('Security Action: Automatically logged out because system lost focus.');
        }
      }, 350);
    };

    const onFocus = () => {
      if (blurTimer) clearTimeout(blurTimer);
    };

    // 3. Idle timeout (2 minutes of user inactivity)
    const IDLE_TIMEOUT_MS = 2 * 60 * 1000;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        void forceLogout('Automatically logged out due to inactivity (idle).');
      }, IDLE_TIMEOUT_MS);
    };

    const activityEvents = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'wheel'];
    activityEvents.forEach(evt => window.addEventListener(evt, resetIdleTimer, { passive: true }));
    resetIdleTimer();

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      activityEvents.forEach(evt => window.removeEventListener(evt, resetIdleTimer));
      if (blurTimer) clearTimeout(blurTimer);
      if (idleTimer) clearTimeout(idleTimer);
    };
  }, [user, clearSession]);

  /* participant score chip */
  const isParticipant = !!user && user.role !== 'ADMIN';
  useEffect(() => {
    if (!isParticipant) return;
    const load = () => api.getMyScore().then(s => setScore(s.totalScore)).catch(() => {});
    load();
    const refresh = () => { load(); setScoreTick(t => t + 1); };
    socket.on('score:update', refresh);
    socket.on('leaderboard:changed', refresh);
    return () => { socket.off('score:update', refresh); socket.off('leaderboard:changed', refresh); };
  }, [isParticipant, eventState.state, user?.sessionId]);

  const handleLoginSuccess = async (sessionId: string, _teamId: string, _role: UserRole) => {
    authenticateSocket(sessionId);
    try {
      const me = await api.getMe();
      setUser(me.user);
    } catch {
      toast('err', 'Logged in, but loading your profile failed. Refresh the page.');
    }
  };

  const handleLogout = async () => {
    try { await api.logout(); } catch { /* already gone */ }
    clearSession();
  };

  if (booting) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: 'var(--text-3)' }}>
        <Spinner size={26} />
      </div>
    );
  }

  const toggleTheme = () => setTheme(t => (t === 'dark' ? 'light' : 'dark'));

  return (
    <ProctorProvider
      user={user}
      eventState={eventState}
      onAcked={() => setUser(u => (u ? { ...u, rulesAcked: true } : u))}
    >
      <TopBar
        user={user}
        eventState={eventState}
        remaining={remaining}
        connected={connected}
        theme={theme}
        score={score}
        onToggleTheme={toggleTheme}
        onLogout={handleLogout}
      />
      {!user ? (
        <Login onLoginSuccess={handleLoginSuccess} />
      ) : user.role === 'ADMIN' ? (
        <AdminDashboard eventState={eventState} remaining={remaining} />
      ) : (
        <ParticipantApp user={user} eventState={eventState} remaining={remaining} theme={theme} scoreRefresh={scoreTick} />
      )}
    </ProctorProvider>
  );
};

export default App;

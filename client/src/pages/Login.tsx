import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight, Clock, Code2, KeyRound, Loader2, ShieldCheck, Swords, UserCheck, Users, XCircle, Zap
} from 'lucide-react';
import { api } from '../services/api';
import { socket } from '../socket/socket';
import { Banner } from '../components/ui';
import type { ParticipantRole, UserRole } from '../types';

interface Props {
  onLoginSuccess: (sessionId: string, teamId: string, role: UserRole) => void;
}

type Stage = 'form' | 'waiting';
const STORAGE_KEY = 'pendingRequest';

interface Pending { requestId: string; teamId: string; role: ParticipantRole }

export const Login: React.FC<Props> = ({ onLoginSuccess }) => {
  const [mode, setMode] = useState<'PARTICIPANT' | 'ADMIN'>('PARTICIPANT');
  const [teams, setTeams] = useState<Array<{ team_id: string; team_name: string }>>([]);
  const [pinRequired, setPinRequired] = useState(false);
  const [teamId, setTeamId] = useState('');
  const [role, setRole] = useState<ParticipantRole>('FIRST_YEAR');
  const [pin, setPin] = useState('');
  const [adminPassword, setAdminPassword] = useState('');

  const [stage, setStage] = useState<Stage>('form');
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /* teams + restore an in-flight request after a refresh */
  useEffect(() => {
    api.getTeams().then(r => {
      setTeams(r.teams);
      setPinRequired(r.pinRequired);
      setTeamId(prev => prev || r.teams[0]?.team_id || '');
    }).catch(() => setError('Cannot reach the server. Is it running?'));

    try {
      const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null') as Pending | null;
      if (saved) {
        setPending(saved); setTeamId(saved.teamId); setRole(saved.role); setStage('waiting');
      }
    } catch { /* ignore */ }
  }, []);

  /* poll / listen for the admin approving the access request */
  useEffect(() => {
    if (stage === 'form' || !pending) return;
    let stop = false;

    const handleApproved = (sessionId: string) => {
      sessionStorage.removeItem(STORAGE_KEY);
      localStorage.setItem('sessionId', sessionId);
      onLoginSuccess(sessionId, pending.teamId, pending.role);
    };

    const check = async () => {
      try {
        const s = await api.requestStatus(pending.requestId);
        if (stop) return;
        if ((s.status === 'APPROVED' || s.status === 'ISSUED') && s.sessionId) {
          handleApproved(s.sessionId);
        } else if (s.status === 'PENDING') {
          setStage('waiting');
        } else if (s.status === 'REJECTED') {
          reset('The password manager declined this request. Speak to the organisers.');
        } else if (s.status === 'EXPIRED') {
          reset('Your access request expired. Please request again.');
        } else if (s.status === 'NONE') {
          reset(null);
        }
      } catch { /* transient */ }
    };

    check();
    const iv = setInterval(check, 1500);

    const onApprovedEvent = (data: any) => {
      if (data && data.requestId === pending.requestId && data.sessionId) {
        handleApproved(data.sessionId);
      }
    };
    const onRejectedEvent = (data: any) => {
      if (data && data.requestId === pending.requestId) {
        reset('The password manager declined this request. Speak to the organisers.');
      }
    };

    socket.on('auth:approved', onApprovedEvent);
    socket.on('auth:issued', check);
    socket.on('auth:rejected', onRejectedEvent);
    return () => {
      stop = true;
      clearInterval(iv);
      socket.off('auth:approved', onApprovedEvent);
      socket.off('auth:issued', check);
      socket.off('auth:rejected', onRejectedEvent);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage === 'form', pending?.requestId]);

  function reset(message: string | null) {
    sessionStorage.removeItem(STORAGE_KEY);
    setPending(null); setStage('form');
    setError(message);
  }

  const requestAccess = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      const res = await api.requestPassword(teamId, role, pin || undefined);
      const p = { requestId: res.request.requestId, teamId, role };
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(p));
      setPending(p);
      setStage('waiting');
    } catch (err: any) {
      setError(err.message);
    } finally { setBusy(false); }
  };

  const doAdminLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      const res = await api.loginAdmin(adminPassword);
      localStorage.setItem('sessionId', res.sessionId);
      onLoginSuccess(res.sessionId, 'ADMIN', 'ADMIN');
    } catch (err: any) {
      setError(err.message);
    } finally { setBusy(false); }
  };

  const selectedTeam = useMemo(() => teams.find(t => t.team_id === teamId), [teams, teamId]);

  return (
    <div className="hero-bg" style={{ minHeight: 'calc(100vh - var(--topbar-h))', display: 'grid', placeItems: 'center', padding: '32px 20px' }}>
      <div className="rise" style={{ width: '100%', maxWidth: 980, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 28, alignItems: 'center' }}>
        {/* ------------ brand panel ------------ */}
        <div style={{ padding: '8px 4px' }}>
          <div className="brand-mark" style={{ width: 52, height: 52, borderRadius: 15 }}><Code2 size={26} strokeWidth={2.3} /></div>
          <h1 style={{ fontSize: 40, fontWeight: 750, letterSpacing: '-0.035em', margin: '22px 0 10px', lineHeight: 1.05 }}>
            Algorithm<br />Auction
          </h1>
          <p className="muted" style={{ fontSize: 16, maxWidth: 420 }}>
            Rank the problems. Win your bucket. Solve fast. A two-round team coding contest — first-years strategise, seniors code.
          </p>
          <div style={{ display: 'grid', gap: 14, marginTop: 28, maxWidth: 420 }}>
            {[
              { icon: <Swords size={17} />, t: 'Strategic allocation', d: 'Fair first-come-first-served problem buckets.' },
              { icon: <Zap size={17} />, t: 'Live judging', d: 'Hidden tests, per-case verdicts, instant scores.' },
              { icon: <ShieldCheck size={17} />, t: 'Proctored', d: 'Fullscreen enforcement and an audited trail.' }
            ].map(({ icon, t, d }) => (
              <div key={t} style={{ display: 'flex', gap: 12 }}>
                <span style={{ color: 'var(--accent-text)', marginTop: 2 }}>{icon}</span>
                <div><div style={{ fontWeight: 600, fontSize: 14 }}>{t}</div><div className="subtle" style={{ fontSize: 13 }}>{d}</div></div>
              </div>
            ))}
          </div>
        </div>

        {/* ------------ form panel ------------ */}
        <div className="card" style={{ padding: 28, boxShadow: 'var(--shadow-lg)' }}>
          <div className="tabs" style={{ width: '100%', marginBottom: 22 }}>
            {(['PARTICIPANT', 'ADMIN'] as const).map(m => (
              <button key={m} className="tab" style={{ flex: 1, justifyContent: 'center' }} role="tab" aria-selected={mode === m}
                onClick={() => { setMode(m); setError(null); }}>
                {m === 'PARTICIPANT' ? <Users size={14} /> : <ShieldCheck size={14} />}
                {m === 'PARTICIPANT' ? 'Participant' : 'Administrator'}
              </button>
            ))}
          </div>

          {error && <div style={{ marginBottom: 16 }}><Banner kind="err">{error}</Banner></div>}

          {mode === 'ADMIN' ? (
            <form onSubmit={doAdminLogin} className="stack">
              <label className="field">
                <span className="label">Administrator password</span>
                <input className="input" type="password" autoFocus value={adminPassword} onChange={e => setAdminPassword(e.target.value)} placeholder="Enter password" required />
              </label>
              <button className="btn btn-primary btn-lg" disabled={busy || !adminPassword}>
                {busy ? <Loader2 size={16} className="spin" /> : <ArrowRight size={16} />} Open control room
              </button>
            </form>
          ) : stage === 'form' ? (
            <form onSubmit={requestAccess} className="stack">
              <label className="field">
                <span className="label">Team</span>
                <select className="select" value={teamId} onChange={e => setTeamId(e.target.value)} required>
                  {teams.map(t => <option key={t.team_id} value={t.team_id}>{t.team_id} — {t.team_name}</option>)}
                </select>
              </label>

              <div className="field">
                <span className="label">Your role</span>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  {([
                    ['FIRST_YEAR', 'First-year', 'Rank the problems', <Users size={16} key="a" />],
                    ['SENIOR', 'Senior', 'Write the code', <UserCheck size={16} key="b" />]
                  ] as const).map(([val, title, sub, icon]) => (
                    <button type="button" key={val} onClick={() => setRole(val)} aria-pressed={role === val}
                      style={{
                        textAlign: 'left', padding: '12px 14px', borderRadius: 10, background: role === val ? 'var(--accent-soft)' : 'var(--surface-2)',
                        border: `1px solid ${role === val ? 'var(--accent)' : 'var(--border)'}`, boxShadow: role === val ? 'var(--glow)' : 'none', transition: '.15s'
                      }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 650, fontSize: 14, color: role === val ? 'var(--accent-text)' : 'var(--text)' }}>{icon}{title}</div>
                      <div className="subtle" style={{ fontSize: 12, marginTop: 2 }}>{sub}</div>
                    </button>
                  ))}
                </div>
              </div>

              {pinRequired && (
                <label className="field">
                  <span className="label">Event PIN</span>
                  <input className="input num" inputMode="numeric" value={pin} onChange={e => setPin(e.target.value)} placeholder="Ask an organiser" required />
                </label>
              )}

              <button className="btn btn-primary btn-lg" disabled={busy || !teamId}>
                {busy ? <Loader2 size={16} className="spin" /> : <KeyRound size={16} />} Request Access
              </button>
              <p className="hint" style={{ textAlign: 'center' }}>Once the password manager approves your request, you will automatically be logged in.</p>
            </form>
          ) : (
            <div className="stack" style={{ textAlign: 'center', padding: '16px 0' }}>
              <div style={{ width: 64, height: 64, margin: '0 auto', borderRadius: 18, display: 'grid', placeItems: 'center', background: 'var(--accent-soft)', color: 'var(--accent-text)' }}>
                <Clock size={28} className="spin" />
              </div>
              <div>
                <h3 style={{ fontSize: 20 }}>Waiting for Access Approval</h3>
                <p className="muted" style={{ marginTop: 6, fontSize: 14 }}>
                  Access request sent for <b style={{ color: 'var(--text)' }}>{pending?.teamId}</b>{selectedTeam ? ` (${selectedTeam.team_name})` : ''} as {pending?.role === 'FIRST_YEAR' ? 'First-year' : 'Senior'}.
                </p>
                <p className="hint" style={{ marginTop: 8 }}>
                  The password manager will review your active sessions and approve access.
                </p>
              </div>
              <span className="badge badge-info" style={{ alignSelf: 'center', padding: '6px 14px' }}><Loader2 size={12} className="spin" /> Listening for approval...</span>
              <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'center', marginTop: 8 }} onClick={() => reset(null)}><XCircle size={14} /> Cancel request</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

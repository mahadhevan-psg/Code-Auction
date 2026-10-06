import React, { useState } from 'react';
import {
  ShieldCheck, ShieldAlert, Maximize, Lock, Eye, ClipboardX, MousePointerClick, Monitor, Keyboard,
  AppWindow, Loader2, FileWarning, Minimize
} from 'lucide-react';
import { useProctor } from '../hooks/useProctor';
import { useToast } from './ui';

/* ------------------------------------------------------------------ */
/* Rules acknowledgement (shown once per session, before the event)    */
/* ------------------------------------------------------------------ */
export const RulesGate: React.FC<{ role: string; teamId: string }> = ({ role, teamId }) => {
  const proctor = useProctor();
  const toast = useToast();
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const p = proctor.policy;

  const rules: Array<{ icon: React.ReactNode; title: string; text: string; on: boolean }> = [
    { icon: <Maximize size={18} />, title: 'Stay in fullscreen', text: 'Fullscreen is required while a round is running. Leaving it hides the contest until you return, and every exit is logged.', on: p.requireFullscreen },
    { icon: <AppWindow size={18} />, title: 'Stay on this tab', text: 'Switching tabs, minimising, or clicking another window is recorded with a timestamp.', on: true },
    { icon: <ClipboardX size={18} />, title: 'No outside text', text: 'Copy and paste is limited to text inside the editor. Pasting anything from outside the editor is blocked and flagged.', on: p.blockClipboard },
    { icon: <Keyboard size={18} />, title: 'No developer tools', text: 'Developer tools, view-source, save and print shortcuts are blocked. Opening developer tools is flagged.', on: p.blockShortcuts || p.detectDevtools },
    { icon: <MousePointerClick size={18} />, title: 'No right-click', text: 'The context menu is disabled during rounds.', on: p.blockContextMenu },
    { icon: <Monitor size={18} />, title: 'One screen, one tab', text: 'Use a single monitor and a single tab for this session. Duplicate tabs and extra monitors are flagged.', on: true },
  ].filter(r => r.on);

  const accept = async () => {
    setBusy(true);
    try { await proctor.acknowledge(); }
    catch (e: any) { toast('err', e?.message || 'Could not record your acceptance.'); setBusy(false); }
  };

  return (
    <div className="overlay" style={{ background: 'color-mix(in srgb, var(--bg) 88%, transparent)', zIndex: 120 }}>
      <div className="modal modal-lg rise" style={{ maxWidth: 680 }}>
        <div className="modal-head" style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <div className="brand-mark" style={{ width: 44, height: 44, borderRadius: 12 }}><ShieldCheck size={22} /></div>
          <div>
            <h3 style={{ fontSize: 19 }}>Exam rules & secure mode</h3>
            <p className="muted" style={{ fontSize: 13 }}>Team {teamId} · {role === 'FIRST_YEAR' ? 'First-year' : 'Senior'} member</p>
          </div>
        </div>
        <div className="modal-body" style={{ display: 'grid', gap: 10 }}>
          <p className="muted" style={{ fontSize: 13.5 }}>
            This contest is proctored. Unusual activity is recorded as a <b style={{ color: 'var(--text)' }}>flag for the organisers to review</b> — a flag is evidence, not a verdict.
          </p>
          {rules.map(r => (
            <div key={r.title} className="card-flat" style={{ display: 'flex', gap: 12, padding: '10px 14px' }}>
              <span style={{ color: 'var(--accent-text)', marginTop: 2 }}>{r.icon}</span>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{r.title}</div>
                <div className="muted" style={{ fontSize: 12.5 }}>{r.text}</div>
              </div>
            </div>
          ))}
          {p.autoLockThreshold > 0 && (
            <div className="banner banner-warn"><FileWarning size={17} /><div className="banner-body">After <b>{p.autoLockThreshold}</b> serious flags your team is locked until an organiser reviews it.</div></div>
          )}
          <label className="check" style={{ marginTop: 6 }}>
            <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} />
            <span>I have read the rules and agree to follow them. I understand my activity during rounds is logged.</span>
          </label>
        </div>
        <div className="modal-foot">
          <button className="btn btn-primary btn-lg" disabled={!agree || busy} onClick={accept}>
            {busy ? <Loader2 size={16} className="spin" /> : <Maximize size={16} />}
            {p.requireFullscreen ? 'Accept & enter fullscreen' : 'Accept & continue'}
          </button>
        </div>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Fullscreen required: blocks the whole UI until the user returns     */
/* ------------------------------------------------------------------ */
export const FullscreenGate: React.FC = () => {
  const { enterFullscreen, counts, policy } = useProctor();
  return (
    <div className="lockout" role="alertdialog" aria-labelledby="fs-title">
      <div className="lockout-card card card-pad rise" style={{ boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ width: 56, height: 56, borderRadius: 16, background: 'var(--warn-soft)', color: 'var(--warn)', display: 'grid', placeItems: 'center', margin: '0 auto 16px' }}>
          <Minimize size={26} />
        </div>
        <h2 id="fs-title" style={{ fontSize: 22 }}>Return to fullscreen to continue</h2>
        <p className="muted" style={{ marginTop: 8 }}>
          The contest is hidden while you are outside fullscreen. The timer keeps running on the server and this exit has been recorded.
        </p>
        {policy.warnAfter > 0 && counts.total > 0 && (
          <p className="subtle" style={{ marginTop: 10, fontSize: 12.5 }}>Flags so far: <b className="num">{counts.total}</b></p>
        )}
        <button className="btn btn-primary btn-lg" style={{ marginTop: 20 }} onClick={enterFullscreen} autoFocus>
          <Maximize size={17} /> Return to fullscreen
        </button>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Team locked by a proctor                                            */
/* ------------------------------------------------------------------ */
export const LockScreen: React.FC<{ teamId: string }> = ({ teamId }) => {
  const { lockReason } = useProctor();
  return (
    <div className="lockout" role="alertdialog">
      <div className="lockout-card card card-pad rise" style={{ boxShadow: 'var(--shadow-lg)' }}>
        <div style={{ width: 56, height: 56, borderRadius: 16, background: 'var(--err-soft)', color: 'var(--err)', display: 'grid', placeItems: 'center', margin: '0 auto 16px' }}>
          <Lock size={26} />
        </div>
        <h2 style={{ fontSize: 22 }}>Team {teamId} is locked</h2>
        <p className="muted" style={{ marginTop: 8 }}>An organiser has paused your access while they review activity from your session. Your code is saved and the timer is unaffected.</p>
        {lockReason && <div className="card-flat" style={{ marginTop: 14, padding: '8px 12px', fontSize: 13 }}>{lockReason}</div>}
        <p className="subtle" style={{ marginTop: 14, fontSize: 12.5 }}>Please raise your hand or speak to an invigilator. This screen clears automatically once you are unlocked.</p>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Top-bar status chip                                                 */
/* ------------------------------------------------------------------ */
export const ProctorChip: React.FC = () => {
  const p = useProctor();
  if (!p.enabled) return null;

  let tone: 'ok' | 'warn' | 'err' | 'idle' = 'ok';
  let label = 'Secure';
  let title = 'Your session is being monitored. No flags so far.';
  if (p.locked) { tone = 'err'; label = 'Locked'; title = 'Your team is locked by a proctor.'; }
  else if (p.flagged) { tone = 'err'; label = `${p.counts.total} flags`; title = 'Your session is flagged for organiser review.'; }
  else if (p.counts.total > 0) { tone = 'warn'; label = `${p.counts.total} flag${p.counts.total > 1 ? 's' : ''}`; title = 'Some activity was recorded.'; }
  else if (!p.active) { tone = 'idle'; label = p.isFullscreen ? 'Secure · standby' : 'Standby'; title = 'Secure mode activates when the round starts.'; }
  else if (p.policy.requireFullscreen && !p.isFullscreen) { tone = 'warn'; label = 'Not fullscreen'; title = 'Return to fullscreen.'; }

  const color = tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)' : tone === 'err' ? 'var(--err)' : 'var(--text-3)';
  const Icon = tone === 'err' || tone === 'warn' ? ShieldAlert : tone === 'idle' ? Eye : ShieldCheck;

  return (
    <button
      className="chip"
      title={title}
      onClick={() => { if (p.policy.requireFullscreen && !p.isFullscreen) void p.enterFullscreen(); }}
      style={{ color, cursor: p.policy.requireFullscreen && !p.isFullscreen ? 'pointer' : 'default' }}
    >
      <Icon size={15} />
      <span className="hide-sm">{label}</span>
    </button>
  );
};

/* ------------------------------------------------------------------ */
/* In-page notice once a participant has crossed the warning threshold */
/* ------------------------------------------------------------------ */
export const FlagNotice: React.FC = () => {
  const { flagged, counts, policy, locked } = useProctor();
  if (!flagged || locked) return null;
  return (
    <div className="banner banner-err fade-in">
      <ShieldAlert size={17} />
      <div className="banner-body">
        <b>Your session is flagged for review.</b> {counts.total} event{counts.total > 1 ? 's' : ''} recorded
        {policy.autoLockThreshold > 0 ? ` — your team locks automatically at ${policy.autoLockThreshold} serious flags` : ''}. Keep to the rules to avoid further flags.
      </div>
    </div>
  );
};

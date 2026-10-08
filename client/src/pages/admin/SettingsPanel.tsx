import React, { useEffect, useState } from 'react';
import { AlertTriangle, RotateCcw, Save } from 'lucide-react';
import { api } from '../../services/api';
import { useLoad } from '../../hooks/useLoad';
import { Banner, Field, Modal, useAction } from '../../components/ui';
import type { EventConfig, EventState } from '../../types';

export const SettingsPanel: React.FC<{ eventState: EventState }> = ({ eventState }) => {
  const q = useLoad(() => api.adminGetPolicy());
  const { run, busy } = useAction();
  const [cfg, setCfg] = useState<EventConfig | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetAllOpen, setResetAllOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [confirmAllText, setConfirmAllText] = useState('');

  useEffect(() => { if (q.data) setCfg(q.data.config); }, [q.data]);

  const set = <K extends keyof EventConfig>(k: K, v: EventConfig[K]) => setCfg(c => (c ? { ...c, [k]: v } : c));
  const save = async () => {
    if (!q.data || !cfg) return;
    const r = await run('save', () => api.adminSetPolicy(q.data!.policy, cfg), 'Settings saved.');
    if (r) setCfg(r.config);
  };
  const reset = async () => {
    await run('reset', () => api.adminEvent('reset', { confirm: 'RESET' }), `Round ${eventState.roundNumber} reset to the lobby.`);
    setResetOpen(false); setConfirmText('');
  };
  const resetAll = async () => {
    await run('reset-all', () => api.adminEvent('reset-all', { confirm: 'RESET_ALL' }), 'Entire event reset to Round 1 lobby.');
    setResetAllOpen(false); setConfirmAllText('');
  };

  if (!cfg) return <div className="skeleton" style={{ height: 320 }} />;

  return (
    <div className="stack">
      <div><div className="eyebrow">Records</div><h1 className="h-page">Settings</h1></div>

      <div className="card card-pad stack" style={{ gap: 18, maxWidth: 760 }}>
        <div><h3 style={{ fontSize: 15 }}>Access & credentials</h3><p className="hint">Applies to new logins and password requests.</p></div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
          <Field label="Password lifetime (minutes)" hint="Unused passwords expire after this."><input className="input num" type="number" min={1} max={60} value={cfg.passwordTtlMinutes} onChange={e => set('passwordTtlMinutes', Number(e.target.value))} /></Field>
          <Field label="Event PIN" hint="If set, participants must enter it to request a password. Leave empty to disable."><input className="input num" value={cfg.eventPin} onChange={e => set('eventPin', e.target.value)} placeholder="(disabled)" /></Field>
          <Field label="Max first-year sessions / team"><input className="input num" type="number" min={1} max={10} value={cfg.maxSessionsFirstYear} onChange={e => set('maxSessionsFirstYear', Number(e.target.value))} /></Field>
          <Field label="Max senior sessions / team"><input className="input num" type="number" min={1} max={10} value={cfg.maxSessionsSenior} onChange={e => set('maxSessionsSenior', Number(e.target.value))} /></Field>
          <Field label="Submit cooldown (seconds)" hint="Minimum gap between a team's submissions."><input className="input num" type="number" min={0} max={120} value={cfg.submitCooldownSeconds} onChange={e => set('submitCooldownSeconds', Number(e.target.value))} /></Field>
        </div>
        <div><button className="btn btn-primary" onClick={save} disabled={busy === 'save'}><Save size={15} /> Save settings</button></div>
      </div>

      <div className="card card-pad stack" style={{ gap: 14, maxWidth: 760, borderColor: 'color-mix(in srgb, var(--err) 35%, var(--border))' }}>
        <div><h3 style={{ fontSize: 15, color: 'var(--err)' }}>Danger zone</h3><p className="hint">For dress rehearsals. Can't be undone.</p></div>
        
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 600 }}>Reset Round {eventState.roundNumber}</div>
            <div className="muted" style={{ fontSize: 13 }}>Deletes this round's priorities, allocations, submissions, autosaves and scores, then returns to the lobby.</div>
          </div>
          <button className="btn btn-danger" onClick={() => { setConfirmText(''); setResetOpen(true); }}><RotateCcw size={15} /> Reset round</button>
        </div>

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 600 }}>Reset Everything (Back to Round 1)</div>
            <div className="muted" style={{ fontSize: 13 }}>Deletes priorities, allocations, submissions, autosaves, scores, score adjustments and violations across ALL rounds, and sets event back to Round 1 lobby.</div>
          </div>
          <button className="btn btn-danger" onClick={() => { setConfirmAllText(''); setResetAllOpen(true); }}><RotateCcw size={15} /> Reset everything</button>
        </div>
      </div>

      {resetOpen && (
        <Modal title={`Reset Round ${eventState.roundNumber}?`} onClose={() => setResetOpen(false)}
          footer={<><button className="btn" onClick={() => setResetOpen(false)}>Cancel</button><button className="btn btn-danger" disabled={confirmText !== 'RESET' || busy === 'reset'} onClick={reset}>Reset round</button></>}>
          <div className="stack">
            <Banner kind="err" icon={<AlertTriangle size={17} />}>All participant data for this round will be permanently deleted. The audit log is kept.</Banner>
            <Field label="Type RESET to confirm"><input className="input mono" value={confirmText} onChange={e => setConfirmText(e.target.value)} autoFocus /></Field>
          </div>
        </Modal>
      )}

      {resetAllOpen && (
        <Modal title="Reset Entire Event to Round 1?" onClose={() => setResetAllOpen(false)}
          footer={<><button className="btn" onClick={() => setResetAllOpen(false)}>Cancel</button><button className="btn btn-danger" disabled={confirmAllText !== 'RESET_ALL' || busy === 'reset-all'} onClick={resetAll}>Reset everything</button></>}>
          <div className="stack">
            <Banner kind="err" icon={<AlertTriangle size={17} />}>All participant data, submissions, allocations, scores, and violations across ALL rounds will be permanently deleted, and the event will return to the Round 1 lobby. The audit log is kept.</Banner>
            <Field label="Type RESET_ALL to confirm"><input className="input mono" value={confirmAllText} onChange={e => setConfirmAllText(e.target.value)} autoFocus /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
};

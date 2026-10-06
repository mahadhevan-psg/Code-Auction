import React, { useEffect, useState } from 'react';
import { CheckCheck, Copy, Eye, Lock, RotateCcw, ScanSearch, ShieldAlert, SlidersHorizontal, Unlock } from 'lucide-react';
import { api } from '../../services/api';
import { useLoad } from '../../hooks/useLoad';
import { Banner, Empty, Field, Modal, Switch, Tabs, timeOnly, useAction } from '../../components/ui';
import type { EventConfig, ProctorPolicy, Severity, Violation } from '../../types';

const sevBadge = (s: Severity) => <span className={`badge ${s === 'HIGH' ? 'badge-err' : s === 'MEDIUM' ? 'badge-warn' : ''}`}>{s}</span>;

/* ---------------------------- summary ---------------------------- */
const SummaryTab: React.FC<{ onOpenTeam: (id: string) => void }> = ({ onOpenTeam }) => {
  const q = useLoad(() => api.adminViolationSummary(), { interval: 6000, events: ['violation:new'] });
  const { run } = useAction();
  const [lock, setLock] = useState<{ id: string } | null>(null);
  const [reason, setReason] = useState('');
  const rows = q.data ?? [];

  return (
    <div className="card">
      {rows.length === 0 ? <Empty icon={<ShieldAlert size={28} />} title="No flags recorded" hint="Teams appear here the moment the proctoring system records something." /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Team</th><th className="r">High</th><th className="r">Medium</th><th className="r">Low</th><th className="r">Open</th><th>Last event</th><th></th></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.team_id}>
                  <td>
                    <div style={{ fontWeight: 650 }}>{r.team_id} <span className="subtle" style={{ fontWeight: 400, fontSize: 12 }}>{r.team_name}</span></div>
                    {r.locked ? <span className="badge badge-err" style={{ marginTop: 4 }}><Lock size={11} /> Locked{r.lock_reason ? ` · ${r.lock_reason}` : ''}</span> : null}
                  </td>
                  <td className="r num" style={{ color: r.high ? 'var(--err)' : 'var(--text-3)', fontWeight: r.high ? 700 : 400 }}>{r.high}</td>
                  <td className="r num" style={{ color: r.medium ? 'var(--warn)' : 'var(--text-3)' }}>{r.medium}</td>
                  <td className="r num subtle">{r.low}</td>
                  <td className="r num">{r.open_count}</td>
                  <td className="num subtle">{r.last_at ? timeOnly(r.last_at) : '—'}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm" onClick={() => onOpenTeam(r.team_id)}><Eye size={13} /> Evidence</button>{' '}
                    {r.locked
                      ? <button className="btn btn-sm btn-ok" onClick={() => run('unlock', () => api.adminLockTeam(r.team_id, false), 'Team unlocked.').then(q.reload)}><Unlock size={13} /> Unlock</button>
                      : <button className="btn btn-sm" onClick={() => { setLock({ id: r.team_id }); setReason(''); }}><Lock size={13} /> Lock</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {lock && (
        <Modal title={`Lock team ${lock.id}?`} description="They lose access to submit until you unlock them." onClose={() => setLock(null)}
          footer={<><button className="btn" onClick={() => setLock(null)}>Cancel</button><button className="btn btn-danger" onClick={async () => { await run('lock', () => api.adminLockTeam(lock.id, true, reason || 'Flagged by proctor'), 'Team locked.'); setLock(null); q.reload(); }}>Lock team</button></>}>
          <Field label="Reason (shown to the team)"><input className="input" autoFocus value={reason} onChange={e => setReason(e.target.value)} /></Field>
        </Modal>
      )}
    </div>
  );
};

/* ---------------------------- feed ---------------------------- */
const FeedTab: React.FC<{ team: string; setTeam: (t: string) => void }> = ({ team, setTeam }) => {
  const [sev, setSev] = useState('');
  const q = useLoad(() => api.adminViolations({ teamId: team.trim().toUpperCase() || undefined, severity: sev || undefined }), {
    interval: 5000, events: ['violation:new'], deps: [team, sev]
  });
  const { run } = useAction();
  const [note, setNote] = useState<Violation | null>(null);
  const [noteText, setNoteText] = useState('');
  const rows = q.data ?? [];

  const review = async (v: Violation, reviewed: boolean, text?: string) => {
    await run('rev', () => api.adminReviewViolation(v.violation_id, reviewed, text), reviewed ? 'Marked reviewed.' : 'Reopened.');
    q.reload();
  };
  const meta = (m?: string) => {
    try { const o = JSON.parse(m || '{}'); delete o.phase; return Object.entries(o).map(([k, v]) => `${k}: ${v}`).join(' · '); } catch { return ''; }
  };
  const phase = (m?: string) => { try { return JSON.parse(m || '{}').phase as string | undefined; } catch { return undefined; } };

  return (
    <div className="stack">
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <input className="input input-sm" style={{ width: 160 }} placeholder="Team ID" value={team} onChange={e => setTeam(e.target.value)} />
        <select className="select select-sm" style={{ width: 150 }} value={sev} onChange={e => setSev(e.target.value)}>
          <option value="">All severities</option><option value="HIGH">High</option><option value="MEDIUM">Medium</option><option value="LOW">Low</option>
        </select>
      </div>
      <div className="card">
        {rows.length === 0 ? <Empty icon={<ShieldAlert size={28} />} title="No events" /> : (
          <div className="table-wrap" style={{ maxHeight: 'calc(100vh - 300px)' }}>
            <table className="table">
              <thead><tr><th>Time</th><th>Team</th><th>Role</th><th>Event</th><th>Severity</th><th>Phase</th><th>Detail</th><th></th></tr></thead>
              <tbody>
                {rows.map(v => (
                  <tr key={v.violation_id} style={v.reviewed ? { opacity: .5 } : undefined}>
                    <td className="num subtle">{timeOnly(v.timestamp)}</td>
                    <td style={{ fontWeight: 600 }}>{v.team_id}</td>
                    <td className="subtle">{v.role === 'FIRST_YEAR' ? 'FY' : 'SR'}</td>
                    <td>{v.label}</td>
                    <td>{sevBadge(v.severity)}</td>
                    <td className="subtle" style={{ fontSize: 12 }}>{phase(v.metadata)?.replace('_', ' ').toLowerCase()}</td>
                    <td className="subtle num" style={{ fontSize: 12 }}>{meta(v.metadata)}{v.review_note ? ` — “${v.review_note}”` : ''}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {v.reviewed
                        ? <button className="btn btn-sm btn-ghost" onClick={() => review(v, false)}><RotateCcw size={13} /> Reopen</button>
                        : <button className="btn btn-sm" onClick={() => { setNote(v); setNoteText(''); }}><CheckCheck size={13} /> Clear</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {note && (
        <Modal title="Mark as reviewed" description="Flags are evidence, not a verdict. Cleared flags stop counting toward a team's open total." onClose={() => setNote(null)}
          footer={<><button className="btn" onClick={() => setNote(null)}>Cancel</button><button className="btn btn-primary" onClick={async () => { await review(note, true, noteText); setNote(null); }}>Mark reviewed</button></>}>
          <Field label="Note (optional)"><input className="input" autoFocus value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="e.g. Checked with invigilator — accidental" /></Field>
        </Modal>
      )}
    </div>
  );
};

/* ---------------------------- similarity ---------------------------- */
const SimilarityTab: React.FC = () => {
  const [threshold, setThreshold] = useState(50);
  const [run, setRun] = useState(0);
  const q = useLoad(() => api.adminSimilarity(threshold), { enabled: run > 0, deps: [run] });
  const [pair, setPair] = useState<{ a: string; b: string } | null>(null);
  const { run: act } = useAction();
  const [codes, setCodes] = useState<{ a?: any; b?: any }>({});

  const openPair = async (s1: string, s2: string) => {
    const [a, b] = await Promise.all([act('a', () => api.adminSubmission(s1)), act('b', () => api.adminSubmission(s2))]);
    setCodes({ a, b });
    setPair({ a: s1, b: s2 });
  };

  return (
    <div className="stack">
      <Banner kind="info" icon={<ScanSearch size={17} />}>
        Compares each team's best submission per problem after <b>stripping comments and renaming variables</b>, then measures overlap of 5-token sequences — so renaming variables or reformatting won't hide copying.
        Similar solutions to short problems are common; treat results as leads to inspect, not proof.
      </Banner>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="label" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          Report at or above
          <input type="range" min={20} max={95} step={5} value={threshold} onChange={e => setThreshold(Number(e.target.value))} />
          <b className="num">{threshold}%</b>
        </label>
        <button className="btn btn-primary" onClick={() => setRun(r => r + 1)}><ScanSearch size={15} /> Run analysis</button>
      </div>
      {run > 0 && (
        <div className="card">
          {(q.data ?? []).length === 0 ? <Empty icon={<Copy size={28} />} title={q.loading ? 'Analysing…' : 'No pairs above the threshold'} /> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Problem</th><th>Team A</th><th>Team B</th><th className="r">Similarity</th><th></th></tr></thead>
                <tbody>
                  {q.data!.map(m => (
                    <tr key={m.submission1 + m.submission2}>
                      <td className="num subtle">{m.problemId}</td>
                      <td style={{ fontWeight: 600 }}>{m.team1}</td>
                      <td style={{ fontWeight: 600 }}>{m.team2}</td>
                      <td className="r"><span className={`badge num ${m.similarityPercentage >= 80 ? 'badge-err' : m.similarityPercentage >= 60 ? 'badge-warn' : ''}`}>{m.similarityPercentage}%</span></td>
                      <td style={{ textAlign: 'right' }}><button className="btn btn-sm" onClick={() => openPair(m.submission1, m.submission2)}>Compare</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {pair && (
        <Modal size="lg" title="Side-by-side" onClose={() => setPair(null)} footer={<button className="btn btn-primary" onClick={() => setPair(null)}>Close</button>}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {[codes.a, codes.b].map((c, i) => (
              <div key={i}>
                <div className="eyebrow" style={{ marginBottom: 6 }}>{c?.team_id} · {c?.language}</div>
                <div className="code-block allow-select" style={{ maxHeight: 420, overflow: 'auto', fontSize: 12 }}>{c?.source_code}</div>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
};

/* ---------------------------- policy ---------------------------- */
const PolicyTab: React.FC = () => {
  const q = useLoad(() => api.adminGetPolicy());
  const { run, busy } = useAction();
  const [policy, setPolicy] = useState<ProctorPolicy | null>(null);
  useEffect(() => { if (q.data) setPolicy(q.data.policy); }, [q.data]);
  if (!policy) return <div className="skeleton" style={{ height: 300 }} />;

  const set = <K extends keyof ProctorPolicy>(k: K, v: ProctorPolicy[K]) => setPolicy(p => (p ? { ...p, [k]: v } : p));
  const save = async () => {
    const r = await run('save', () => api.adminSetPolicy(policy), 'Policy updated — live for all participants.');
    if (r) setPolicy(r.policy);
  };

  return (
    <div className="stack">
      <div className="card card-pad stack" style={{ gap: 18, maxWidth: 760 }}>
        <div>
          <h3 style={{ fontSize: 15 }}>Enforced during secure phases</h3>
          <p className="hint">Secure phases = first-year priority selection, allocation and coding (seniors: allocation and coding). Changes apply to connected participants immediately.</p>
        </div>
        <Switch checked={policy.requireFullscreen} onChange={v => set('requireFullscreen', v)} label="Require fullscreen" hint="The contest is hidden until the participant is back in fullscreen. Every exit is logged." />
        <Switch checked={policy.autoLogoutOnTabSwitch ?? true} onChange={v => set('autoLogoutOnTabSwitch', v)} label="Force logout on tab switch" hint="Automatically logs out participants immediately if they switch browser tabs or minimize the window." />
        <Switch checked={policy.autoLogoutOnBlur ?? true} onChange={v => set('autoLogoutOnBlur', v)} label="Force logout on focus loss" hint="Automatically logs out participants if the browser loses window focus." />
        <Switch checked={policy.blockClipboard} onChange={v => set('blockClipboard', v)} label="Restrict copy & paste" hint="Copy/paste works only inside the editor with text copied from the editor. Outside text is blocked and flagged HIGH." />
        <Switch checked={policy.blockContextMenu} onChange={v => set('blockContextMenu', v)} label="Disable right-click menu" />
        <Switch checked={policy.blockSelection} onChange={v => set('blockSelection', v)} label="Disable text selection" hint="Prevents selecting problem text outside the editor." />
        <Switch checked={policy.blockShortcuts} onChange={v => set('blockShortcuts', v)} label="Block developer shortcuts" hint="F12, Ctrl+Shift+I/J/C, Ctrl+U/S/P and PrintScreen logging." />
        <Switch checked={policy.detectDevtools} onChange={v => set('detectDevtools', v)} label="Detect developer tools" hint="Heuristic based on window geometry — a flag, not proof." />
        <Switch checked={policy.requireAck} onChange={v => set('requireAck', v)} label="Require rules acceptance" hint="Participants must accept the rules before ranking or submitting. Enforced by the API." />
        <Switch checked={policy.allowRun} onChange={v => set('allowRun', v)} label="Allow “Run on samples”" hint="Disable to make Submit the only way to test code." />
        <hr className="divider" />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
          <Field label="Auto logout when idle after" hint="Inactivity in seconds (default: 120s = 2m). 0 = disabled."><input className="input num" type="number" min={0} max={3600} value={policy.idleTimeoutSeconds ?? 120} onChange={e => set('idleTimeoutSeconds', Number(e.target.value))} /></Field>
          <Field label="Show “flagged” warning after" hint="Number of flags (0 = never)."><input className="input num" type="number" min={0} max={50} value={policy.warnAfter} onChange={e => set('warnAfter', Number(e.target.value))} /></Field>
          <Field label="Auto-lock team after" hint="Serious (medium/high) open flags. 0 = never auto-lock — recommended."><input className="input num" type="number" min={0} max={50} value={policy.autoLockThreshold} onChange={e => set('autoLockThreshold', Number(e.target.value))} /></Field>
        </div>
        <div><button className="btn btn-primary" onClick={save} disabled={busy === 'save'}><SlidersHorizontal size={15} /> Save policy</button></div>
      </div>
      <Banner kind="warn">
        No browser-based proctoring can stop a determined cheater with a second device. Use organiser-controlled lab machines, restrict outbound internet at the network, and use these flags as evidence for review.
      </Banner>
    </div>
  );
};

/* ---------------------------- panel ---------------------------- */
export const ProctoringPanel: React.FC = () => {
  const [tab, setTab] = useState('summary');
  const [team, setTeam] = useState('');
  return (
    <div className="stack">
      <div><div className="eyebrow">Integrity</div><h1 className="h-page">Proctoring</h1></div>
      <Tabs value={tab} onChange={setTab} items={[
        { id: 'summary', label: 'Flagged teams', icon: <ShieldAlert size={14} /> },
        { id: 'feed', label: 'Event feed', icon: <Eye size={14} /> },
        { id: 'similarity', label: 'Code similarity', icon: <Copy size={14} /> },
        { id: 'policy', label: 'Policy', icon: <SlidersHorizontal size={14} /> }
      ]} />
      {tab === 'summary' && <SummaryTab onOpenTeam={t => { setTeam(t); setTab('feed'); }} />}
      {tab === 'feed' && <FeedTab team={team} setTeam={setTeam} />}
      {tab === 'similarity' && <SimilarityTab />}
      {tab === 'policy' && <PolicyTab />}
    </div>
  );
};

export type { EventConfig };

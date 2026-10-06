import React, { useMemo, useState } from 'react';
import { AlertTriangle, ArrowRightLeft, Swords } from 'lucide-react';
import { api } from '../../services/api';
import { useLoad } from '../../hooks/useLoad';
import { Banner, DifficultyBadge, Empty, Field, Modal, timeOnly, useAction } from '../../components/ui';
import type { AllocationRow, EventState } from '../../types';

export const AllocationPanel: React.FC<{ eventState: EventState }> = ({ eventState }) => {
  const roundId = eventState.roundId;
  const q = useLoad(() => api.adminAllocations(roundId), {
    interval: 5000, events: ['priority:submitted', 'allocation:complete', 'round:state'], deps: [roundId]
  });
  const { run, busy } = useAction();
  const [target, setTarget] = useState<AllocationRow | null>(null);
  const [problemId, setProblemId] = useState('');
  const [reason, setReason] = useState('');

  const rows = q.data?.rows ?? [];
  const summary = useMemo(() => q.data?.summary ?? [], [q.data]);
  const titles = useMemo(() => new Map(summary.map(s => [s.problem_id, s.title])), [summary]);
  const short = (id: string | null) => (id ? id.replace(/^R\d+_/, '') : '—');

  const unallocated = rows.filter(r => !r.problem_id);
  const auto = rows.filter(r => r.sequence_no === null);
  const afterAlloc = eventState.state !== 'WAITING' && eventState.state !== 'PRIORITY_SELECTION';

  const openOverride = (r: AllocationRow) => { setTarget(r); setProblemId(r.problem_id ?? summary[0]?.problem_id ?? ''); setReason(''); };
  const doOverride = async () => {
    if (!target) return;
    const ok = await run('override', () => api.adminOverride(roundId, target.team_id, problemId, reason), `Team ${target.team_id} reassigned.`);
    if (ok) { setTarget(null); q.reload(); }
  };

  return (
    <div className="stack">
      <div><div className="eyebrow">Run</div><h1 className="h-page">Allocation · Round {eventState.roundNumber}</h1></div>

      {afterAlloc && unallocated.length > 0 && (
        <Banner kind="err" icon={<AlertTriangle size={17} />}>
          <b>{unallocated.length} team{unallocated.length > 1 ? 's have' : ' has'} no problem</b> ({unallocated.map(u => u.team_id).join(', ')}). Use <i>Override</i> to resolve each allocation exception before coding starts.
        </Banner>
      )}
      {afterAlloc && auto.length > 0 && (
        <Banner kind="warn">{auto.length} team{auto.length > 1 ? 's' : ''} never submitted priorities and {auto.length > 1 ? 'were' : 'was'} allocated last using the default order: {auto.map(a => a.team_id).join(', ')}.</Banner>
      )}

      <div className="grid-auto">
        {summary.map(b => (
          <div key={b.problem_id} className="card stat">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="eyebrow num">{short(b.problem_id)}</span>
              <DifficultyBadge difficulty={b.difficulty} />
            </div>
            <div style={{ fontWeight: 600, fontSize: 13.5, minHeight: 38 }}>{b.title}</div>
            <div className="stat-value">{b.assigned}<span className="subtle" style={{ fontSize: 16 }}> / {b.capacity}</span></div>
            <div className="progress"><span style={{ width: `${b.capacity ? (b.assigned / b.capacity) * 100 : 0}%` }} /></div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-head"><h3><Swords size={16} style={{ color: 'var(--accent-text)' }} /> Submission order & result</h3><span className="hint">Allocation is processed top to bottom.</span></div>
        {rows.length === 0 ? <Empty icon={<Swords size={28} />} title="Nothing to show yet" hint="Priorities appear here as teams submit." /> : (
          <div className="table-wrap" style={{ maxHeight: 'calc(100vh - 420px)', minHeight: 280 }}>
            <table className="table">
              <thead><tr><th style={{ width: 56 }}>Seq</th><th>Team</th><th>Submitted</th><th>Ranking (1 → 5)</th><th>Assigned</th><th></th></tr></thead>
              <tbody>
                {rows.map(r => {
                  const prefs = [r.rank1, r.rank2, r.rank3, r.rank4, r.rank5];
                  return (
                    <tr key={r.team_id}>
                      <td className="num">{r.sequence_no ?? <span className="subtle">—</span>}</td>
                      <td><div style={{ fontWeight: 600 }}>{r.team_name}</div><div className="subtle num" style={{ fontSize: 11.5 }}>{r.team_id}</div></td>
                      <td className="num subtle">{r.submitted_at ? timeOnly(r.submitted_at) : <span className="badge badge-warn">not submitted</span>}</td>
                      <td>
                        {r.sequence_no === null ? <span className="subtle">—</span> : (
                          <div style={{ display: 'flex', gap: 4 }}>
                            {prefs.map((p, i) => (
                              <span key={i} className="badge num" style={p === r.problem_id ? { background: 'var(--accent)', color: 'var(--on-accent)' } : undefined} title={titles.get(p ?? '') ?? ''}>{short(p)}</span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td>
                        {r.problem_id ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 13 }}>{r.title}</span>
                            {r.is_override ? <span className="badge badge-warn">override</span> : r.priority_rank ? <span className="badge badge-accent num">#{r.priority_rank}</span> : null}
                          </div>
                        ) : afterAlloc ? <span className="badge badge-err">unallocated</span> : <span className="subtle">pending</span>}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {afterAlloc && <button className="btn btn-sm" onClick={() => openOverride(r)}><ArrowRightLeft size={13} /> Override</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {target && (
        <Modal title={`Override allocation — ${target.team_id}`} description="Reassigns this team to a different problem. Capacity is not enforced for manual overrides, and the change is audited."
          onClose={() => setTarget(null)}
          footer={<><button className="btn" onClick={() => setTarget(null)}>Cancel</button><button className="btn btn-primary" onClick={doOverride} disabled={!reason.trim() || busy === 'override'}>Reassign</button></>}>
          <div className="stack">
            <Field label="Assign to">
              <select className="select" value={problemId} onChange={e => setProblemId(e.target.value)}>
                {summary.map(s => <option key={s.problem_id} value={s.problem_id}>{s.title} ({s.assigned}/{s.capacity})</option>)}
              </select>
            </Field>
            <Field label="Reason (required)"><input className="input" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Late login, bucket was full" /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
};

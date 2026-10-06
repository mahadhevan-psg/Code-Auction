import React, { useEffect, useState } from 'react';
import { AlertTriangle, Archive, CheckCircle2, Eye, EyeOff, FlaskConical, Pencil, Plus, Rocket, Trash2 } from 'lucide-react';
import { api } from '../../services/api';
import { useLoad } from '../../hooks/useLoad';
import { Banner, ConfirmModal, DifficultyBadge, Empty, Field, Modal, Tabs, useAction } from '../../components/ui';
import type { AdminProblem, Difficulty, EventState, TestCase } from '../../types';

const statusBadge = (s: AdminProblem['status']) =>
  s === 'PUBLISHED' ? <span className="badge badge-ok">Published</span> : s === 'DRAFT' ? <span className="badge badge-warn">Draft</span> : <span className="badge">Retired</span>;

const isLive = (p: AdminProblem, ev: EventState) =>
  p.status === 'PUBLISHED' && p.round_id === ev.roundId && ['PRIORITY_SELECTION', 'ALLOCATION', 'CODING', 'ROUND_ENDED'].includes(ev.state);

/* ------------------------------------------------------------------ */
/* Editor modal                                                        */
/* ------------------------------------------------------------------ */
const ProblemEditor: React.FC<{ problem: AdminProblem | null; round: number; eventState: EventState; onClose: () => void; onSaved: () => void }> = ({ problem, round, eventState, onClose, onSaved }) => {
  const { run, busy } = useAction();
  const [id, setId] = useState(problem?.problem_id ?? '');
  const [f, setF] = useState({
    title: problem?.title ?? '', difficulty: (problem?.difficulty ?? 'Easy') as Difficulty, weight: problem?.weight ?? 1,
    statement: problem?.statement ?? '', constraints: problem?.constraints ?? '', sample_input: problem?.sample_input ?? '',
    sample_output: problem?.sample_output ?? '', time_limit_ms: problem?.time_limit_ms ?? 3000, memory_limit_mb: problem?.memory_limit_mb ?? 256
  });
  const [reason, setReason] = useState('');
  const live = problem ? isLive(problem, eventState) : false;
  const emergency = live ? { emergency: true, reason } : {};

  const tcQ = useLoad<TestCase[]>(() => (id ? api.adminTestCases(id) : Promise.resolve([])), { deps: [id] });
  const checkQ = useLoad(() => (id ? api.adminValidateProblem(id) : Promise.resolve({ issues: [] as string[] })), { deps: [id, tcQ.data?.length] });
  const [tcIn, setTcIn] = useState('');
  const [tcOut, setTcOut] = useState('');
  const [tcHidden, setTcHidden] = useState(true);

  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(prev => ({ ...prev, [k]: v }));
  const needsReason = live && !reason.trim();

  const save = async () => {
    if (!id) {
      const r = await run('save', () => api.adminCreateProblem({ round_id: round, ...f }), 'Draft created — now add test cases.');
      if (r) { setId(r.problem_id); onSaved(); }
    } else {
      const r = await run('save', () => api.adminUpdateProblem(id, { ...f, ...emergency }), 'Problem saved.');
      if (r) { onSaved(); checkQ.reload(); }
    }
  };

  const addTc = async () => {
    const r = await run('tc', () => api.adminAddTestCase(id, { input: tcIn, expected_output: tcOut, hidden: tcHidden, ...emergency }), 'Test case added.');
    if (r) { setTcIn(''); setTcOut(''); tcQ.reload(); onSaved(); }
  };
  const delTc = async (tcId: string) => {
    await run('tcdel', () => api.adminDeleteTestCase(tcId, emergency), 'Test case removed.');
    tcQ.reload(); onSaved();
  };
  const toggleHidden = async (tc: TestCase) => {
    await run('tctoggle', () => api.adminUpdateTestCase(tc.test_case_id, { hidden: !tc.hidden, ...emergency }));
    tcQ.reload();
  };

  const tcs = tcQ.data ?? [];
  const issues = checkQ.data?.issues ?? [];

  return (
    <Modal size="lg" title={problem ? `Edit · ${problem.problem_id}` : id ? `Edit · ${id}` : `New problem · Round ${round}`} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Close</button>
        <button className="btn btn-primary" onClick={save} disabled={!f.title.trim() || busy === 'save' || needsReason}>{id ? 'Save changes' : 'Create draft'}</button>
      </>}>
      <div className="stack" style={{ gap: 14 }}>
        {live && (
          <Banner kind="warn" icon={<AlertTriangle size={17} />}>
            <b>This problem is live.</b> Changes need an emergency override and are audited.
            <input className="input input-sm" style={{ marginTop: 8 }} placeholder="Reason for the emergency edit (required)" value={reason} onChange={e => setReason(e.target.value)} />
          </Banner>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px 110px', gap: 12 }}>
          <Field label="Title"><input className="input" value={f.title} onChange={e => set('title', e.target.value)} /></Field>
          <Field label="Difficulty">
            <select className="select" value={f.difficulty} onChange={e => set('difficulty', e.target.value as Difficulty)}>
              {['Easy', 'Medium', 'Hard'].map(d => <option key={d}>{d}</option>)}
            </select>
          </Field>
          <Field label="Weight ×"><input className="input num" type="number" min={0.1} step={0.5} value={f.weight} onChange={e => set('weight', Number(e.target.value))} /></Field>
        </div>
        <Field label="Statement"><textarea className="textarea" rows={5} value={f.statement} onChange={e => set('statement', e.target.value)} /></Field>
        <Field label="Constraints"><textarea className="textarea mono" rows={2} value={f.constraints} onChange={e => set('constraints', e.target.value)} style={{ fontSize: 13 }} /></Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Sample input"><textarea className="textarea mono" rows={3} value={f.sample_input} onChange={e => set('sample_input', e.target.value)} style={{ fontSize: 13 }} /></Field>
          <Field label="Sample output"><textarea className="textarea mono" rows={3} value={f.sample_output} onChange={e => set('sample_output', e.target.value)} style={{ fontSize: 13 }} /></Field>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Time limit (ms)"><input className="input num" type="number" min={500} max={20000} step={500} value={f.time_limit_ms} onChange={e => set('time_limit_ms', Number(e.target.value))} /></Field>
          <Field label="Memory limit (MB)" hint="Enforced for JavaScript; recorded for others."><input className="input num" type="number" min={32} max={1024} step={32} value={f.memory_limit_mb} onChange={e => set('memory_limit_mb', Number(e.target.value))} /></Field>
        </div>

        {id ? (
          <>
            <hr className="divider" />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h4 style={{ fontSize: 14 }}>Test cases <span className="subtle num">({tcs.length})</span></h4>
              {issues.length === 0 && problem?.status !== 'PUBLISHED' && <span className="badge badge-ok"><CheckCircle2 size={12} /> Ready to publish</span>}
            </div>
            {issues.length > 0 && problem?.status !== 'PUBLISHED' && <Banner kind="warn"><ul style={{ paddingLeft: 16 }}>{issues.map(i => <li key={i}>{i}</li>)}</ul></Banner>}

            <div className="card-flat">
              {tcs.length === 0 ? <div className="empty" style={{ padding: 20 }}>No test cases yet.</div> : (
                <table className="table">
                  <thead><tr><th>Input</th><th>Expected</th><th>Visibility</th><th></th></tr></thead>
                  <tbody>
                    {tcs.map(tc => (
                      <tr key={tc.test_case_id}>
                        <td><pre className="mono" style={{ fontSize: 12, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{tc.input}</pre></td>
                        <td><pre className="mono" style={{ fontSize: 12, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>{tc.expected_output}</pre></td>
                        <td><button className="btn btn-sm" onClick={() => toggleHidden(tc)} disabled={needsReason} title="Toggle whether participants can see and run this case">
                          {tc.hidden ? <><EyeOff size={13} /> Hidden</> : <><Eye size={13} /> Public sample</>}</button></td>
                        <td style={{ textAlign: 'right' }}><button className="btn btn-sm btn-ghost btn-icon" onClick={() => delTc(tc.test_case_id)} disabled={needsReason} aria-label="Delete test case"><Trash2 size={14} /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="card-flat" style={{ padding: 12, display: 'grid', gap: 10 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <textarea className="textarea mono" rows={2} placeholder="New test input" value={tcIn} onChange={e => setTcIn(e.target.value)} style={{ fontSize: 13 }} />
                <textarea className="textarea mono" rows={2} placeholder="Expected output" value={tcOut} onChange={e => setTcOut(e.target.value)} style={{ fontSize: 13 }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label className="check"><input type="checkbox" checked={tcHidden} onChange={e => setTcHidden(e.target.checked)} /><span>Hidden (never shown to participants)</span></label>
                <button className="btn btn-sm btn-primary" onClick={addTc} disabled={!tcIn.length || !tcOut.length || busy === 'tc' || needsReason}><Plus size={13} /> Add test case</button>
              </div>
            </div>
          </>
        ) : <p className="hint">Create the draft first, then add test cases.</p>}
      </div>
    </Modal>
  );
};

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */
export const ProblemsPanel: React.FC<{ eventState: EventState }> = ({ eventState }) => {
  const q = useLoad(() => api.adminProblems(), { interval: 8000 });
  const { run } = useAction();
  const [round, setRound] = useState(String(eventState.roundId));
  const [editing, setEditing] = useState<AdminProblem | 'new' | null>(null);
  const [retire, setRetire] = useState<AdminProblem | null>(null);
  const [retireReason, setRetireReason] = useState('');
  const [del, setDel] = useState<AdminProblem | null>(null);

  useEffect(() => { setRound(String(eventState.roundId)); }, [eventState.roundId]);

  const all = q.data ?? [];
  const list = all.filter(p => String(p.round_id) === round);
  const publishedCount = list.filter(p => p.status === 'PUBLISHED').length;

  const publish = async (p: AdminProblem) => { await run('pub' + p.problem_id, () => api.adminPublishProblem(p.problem_id), 'Published.'); q.reload(); };
  const doRetire = async () => {
    if (!retire) return;
    await run('ret', () => api.adminRetireProblem(retire.problem_id, isLive(retire, eventState) ? { emergency: true, reason: retireReason } : {}), 'Retired.');
    setRetire(null); setRetireReason(''); q.reload();
  };
  const doDelete = async () => {
    if (!del) return;
    await run('del', () => api.adminDeleteProblem(del.problem_id), 'Draft deleted.');
    setDel(null); q.reload();
  };

  return (
    <div className="stack">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div><div className="eyebrow">Content</div><h1 className="h-page">Problem manager</h1></div>
        <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={15} /> New problem</button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <Tabs value={round} onChange={setRound} items={[1, 2].map(r => ({ id: String(r), label: `Round ${r}`, count: all.filter(p => p.round_id === r && p.status === 'PUBLISHED').length }))} />
        <span className={`badge ${publishedCount === 5 ? 'badge-ok' : 'badge-warn'}`}>{publishedCount} / 5 published{publishedCount !== 5 && ' — a round needs exactly 5'}</span>
      </div>

      <div className="card">
        {list.length === 0 ? <Empty icon={<FlaskConical size={28} />} title="No problems in this round" /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Problem</th><th>Difficulty</th><th>Status</th><th className="r">Tests</th><th className="r">Limits</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
              <tbody>
                {list.map(p => (
                  <tr key={p.problem_id} style={p.status === 'RETIRED' ? { opacity: .5 } : undefined}>
                    <td><div style={{ fontWeight: 600 }}>{p.title}</div><div className="subtle num" style={{ fontSize: 11.5 }}>{p.problem_id}</div></td>
                    <td><DifficultyBadge difficulty={p.difficulty} weight={p.weight} /></td>
                    <td>{statusBadge(p.status)}</td>
                    <td className="r num">{p.test_case_count}</td>
                    <td className="r num subtle">{(p.time_limit_ms ?? 3000) / 1000}s · {p.memory_limit_mb ?? 256}MB</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm" onClick={() => setEditing(p)}><Pencil size={13} /> Edit</button>{' '}
                      {p.status === 'DRAFT' && <><button className="btn btn-sm btn-ok" onClick={() => publish(p)}><Rocket size={13} /> Publish</button>{' '}<button className="btn btn-sm btn-ghost btn-icon" onClick={() => setDel(p)} aria-label="Delete draft"><Trash2 size={14} /></button></>}
                      {p.status === 'PUBLISHED' && <button className="btn btn-sm" onClick={() => setRetire(p)}><Archive size={13} /> Retire</button>}
                      {p.status === 'RETIRED' && <button className="btn btn-sm" onClick={() => publish(p)}><Rocket size={13} /> Republish</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <ProblemEditor
          problem={editing === 'new' ? null : editing}
          round={Number(round)}
          eventState={eventState}
          onClose={() => setEditing(null)}
          onSaved={() => q.reload()}
        />
      )}

      {retire && (
        <Modal title={`Retire ${retire.title}?`} onClose={() => setRetire(null)}
          footer={<><button className="btn" onClick={() => setRetire(null)}>Cancel</button><button className="btn btn-danger" onClick={doRetire} disabled={isLive(retire, eventState) && !retireReason.trim()}>Retire</button></>}>
          <p className="muted">Retired problems disappear from future rounds and can't be assigned.</p>
          {isLive(retire, eventState) && (
            <div style={{ marginTop: 12 }}>
              <Banner kind="warn" icon={<AlertTriangle size={17} />}>This problem is live in the current round — retiring it needs an emergency reason.</Banner>
              <input className="input" style={{ marginTop: 10 }} placeholder="Reason (required)" value={retireReason} onChange={e => setRetireReason(e.target.value)} />
            </div>
          )}
        </Modal>
      )}

      {del && <ConfirmModal title="Delete draft?" danger confirmLabel="Delete" body={<>“{del.title}” and its test cases will be removed permanently.</>} onCancel={() => setDel(null)} onConfirm={doDelete} />}
    </div>
  );
};

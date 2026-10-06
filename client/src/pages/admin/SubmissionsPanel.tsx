import React, { useState } from 'react';
import { ClipboardList, RotateCw } from 'lucide-react';
import { api } from '../../services/api';
import { useLoad } from '../../hooks/useLoad';
import { Empty, Modal, StatusBadge, Tabs, timeOnly, useAction } from '../../components/ui';
import type { EventState, Submission } from '../../types';

export const SubmissionsPanel: React.FC<{ eventState: EventState }> = ({ eventState }) => {
  const [round, setRound] = useState('all');
  const [team, setTeam] = useState('');
  const q = useLoad(() => api.adminSubmissions({ teamId: team.trim().toUpperCase() || undefined, roundId: round === 'all' ? undefined : Number(round) }), {
    interval: 5000, events: ['submission:status'], deps: [round, team]
  });
  const { run, busy } = useAction();
  const [view, setView] = useState<Submission | null>(null);

  const open = async (id: string) => {
    const s = await run('view', () => api.adminSubmission(id));
    if (s) setView(s);
  };
  const rejudge = async (id: string) => {
    await run('rejudge', () => api.adminRejudge(id), 'Re-queued for judging.');
    q.reload();
    setView(null);
  };

  const rows = q.data ?? [];
  const pending = rows.filter(r => r.status === 'Pending' || r.status === 'Judging').length;

  return (
    <div className="stack">
      <div><div className="eyebrow">Content</div><h1 className="h-page">Submissions</h1></div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <Tabs value={round} onChange={setRound} items={[{ id: 'all', label: 'All rounds' }, { id: '1', label: 'Round 1' }, { id: '2', label: 'Round 2' }]} />
        <input className="input input-sm" style={{ width: 160 }} placeholder="Filter by team ID" value={team} onChange={e => setTeam(e.target.value)} />
        {pending > 0 && <span className="badge badge-info">{pending} judging</span>}
        <span className="hint">Current: round {eventState.roundNumber}</span>
      </div>

      <div className="card">
        {rows.length === 0 ? <Empty icon={<ClipboardList size={28} />} title="No submissions" /> : (
          <div className="table-wrap" style={{ maxHeight: 'calc(100vh - 240px)' }}>
            <table className="table">
              <thead><tr><th>Time</th><th>Team</th><th>Round</th><th>Problem</th><th>Lang</th><th>Verdict</th><th className="r">Passed</th><th className="r">Score</th><th></th></tr></thead>
              <tbody>
                {rows.map(s => (
                  <tr key={s.submission_id}>
                    <td className="num subtle">{timeOnly(s.submitted_at)}</td>
                    <td><span style={{ fontWeight: 600 }}>{s.team_id}</span> <span className="subtle" style={{ fontSize: 12 }}>{s.team_name}</span></td>
                    <td className="num">{s.round_id}</td>
                    <td className="num subtle">{s.problem_id}</td>
                    <td className="subtle">{s.language}</td>
                    <td><StatusBadge status={s.status} /></td>
                    <td className="r num">{s.passed_count}/{s.total_cases}</td>
                    <td className="r num" style={{ fontWeight: 700 }}>{s.score}</td>
                    <td style={{ textAlign: 'right' }}><button className="btn btn-sm" onClick={() => open(s.submission_id)}>View</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {view && (
        <Modal size="lg" title={<>Submission · {view.team_id} · {view.problem_id}</>} onClose={() => setView(null)}
          footer={<>
            <button className="btn" onClick={() => rejudge(view.submission_id)} disabled={busy === 'rejudge'}><RotateCw size={14} /> Rejudge</button>
            <button className="btn btn-primary" onClick={() => setView(null)}>Close</button>
          </>}>
          <div className="stack" style={{ gap: 12 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <StatusBadge status={view.status} />
              <span className="num muted">{view.passed_count}/{view.total_cases} passed · {view.score} pts · {view.language}</span>
              <span className="subtle num">{timeOnly(view.submitted_at)}</span>
            </div>
            {view.results && view.results.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {view.results.map(r => <span key={r.index} className={`case-pill ${r.verdict.toLowerCase()}`}>#{r.index} {r.verdict}{r.hidden ? ' · hidden' : ''} · {r.timeMs}ms</span>)}
              </div>
            )}
            {view.compiler_output && <div className="code-block" style={{ whiteSpace: 'pre-wrap' }}>{view.compiler_output}</div>}
            <div className="code-block allow-select" style={{ maxHeight: 360, overflow: 'auto' }}>{view.source_code}</div>
          </div>
        </Modal>
      )}
    </div>
  );
};

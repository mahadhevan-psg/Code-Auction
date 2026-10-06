import React, { useState } from 'react';
import { Download, Pencil, Plus, Trophy } from 'lucide-react';
import { api } from '../../services/api';
import { useLoad } from '../../hooks/useLoad';
import { Banner, Empty, Field, Modal, timeAgo, useAction } from '../../components/ui';
import { Leaderboard } from '../../components/Leaderboard';
import type { LeaderboardEntry } from '../../types';

export const ScoresPanel: React.FC = () => {
  const board = useLoad(() => api.adminLeaderboard(), { interval: 6000, events: ['score:update', 'leaderboard:changed'] });
  const adj = useLoad(() => api.adminAdjustments(), { events: ['leaderboard:changed'] });
  const { run, busy } = useAction();
  const [target, setTarget] = useState<{ row: LeaderboardEntry; kind: 'adjust' | 'aptitude' } | null>(null);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');

  const open = (row: LeaderboardEntry, kind: 'adjust' | 'aptitude') => {
    setTarget({ row, kind });
    setValue(kind === 'aptitude' ? String(row.aptitudeScore) : '');
    setReason('');
  };

  const save = async () => {
    if (!target) return;
    const n = Number(value);
    const ok = target.kind === 'aptitude'
      ? await run('save', () => api.adminUpdateAptitude(target.row.teamId, n), 'Aptitude score updated.')
      : await run('save', () => api.adminAdjustScore(target.row.teamId, n, reason), 'Adjustment recorded.');
    if (ok) { setTarget(null); board.reload(); adj.reload(); }
  };

  const rows = board.data ?? [];
  const history = adj.data ?? [];

  return (
    <div className="stack">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div><div className="eyebrow">Records</div><h1 className="h-page">Scores</h1></div>
        <button className="btn" onClick={() => run('export', () => api.adminExport('leaderboard'))}><Download size={15} /> Export CSV</button>
      </div>

      <Banner kind="info">Total = Round 1 + Round 2 coding score + aptitude + adjustments. Coding scores come from judged submissions (passed tests × weight) and can't be edited directly; use an adjustment with a reason — it's audited.</Banner>

      <div className="card">
        <div className="card-head"><h3><Trophy size={16} style={{ color: 'var(--warn)' }} /> Live leaderboard</h3></div>
        {rows.length === 0 ? <Empty icon={<Trophy size={28} />} title="No scores yet" /> : (
          <div className="table-wrap" style={{ maxHeight: 560 }}>
            <table className="table">
              <thead><tr><th style={{ width: 70 }}>Rank</th><th>Team</th><th className="r">R1</th><th className="r">R2</th><th className="r">Aptitude</th><th className="r">Adj.</th><th className="r">Total</th><th></th></tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.teamId}>
                    <td className="num" style={{ fontWeight: 700 }}>#{r.rank}</td>
                    <td><div style={{ fontWeight: 600 }}>{r.teamName}</div><div className="subtle num" style={{ fontSize: 11.5 }}>{r.teamId}</div></td>
                    <td className="r num">{r.round1Score}</td>
                    <td className="r num">{r.round2Score}</td>
                    <td className="r num subtle">{r.aptitudeScore}</td>
                    <td className="r num subtle">{r.adjustment ? (r.adjustment > 0 ? `+${r.adjustment}` : r.adjustment) : '—'}</td>
                    <td className="r num" style={{ fontWeight: 700, fontSize: 15 }}>{r.totalScore}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm" onClick={() => open(r, 'aptitude')}><Pencil size={13} /> Aptitude</button>{' '}
                      <button className="btn btn-sm" onClick={() => open(r, 'adjust')}><Plus size={13} /> Adjust</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head"><h3>Adjustment history</h3></div>
        {history.length === 0 ? <div className="empty" style={{ padding: 28 }}>No manual adjustments.</div> : (
          <table className="table">
            <thead><tr><th>When</th><th>Team</th><th className="r">Δ</th><th>Reason</th><th>By</th></tr></thead>
            <tbody>
              {history.map(a => (
                <tr key={a.adjustment_id}>
                  <td className="subtle num">{timeAgo(a.created_at)}</td>
                  <td style={{ fontWeight: 600 }}>{a.team_id} <span className="subtle" style={{ fontWeight: 400, fontSize: 12 }}>{a.team_name}</span></td>
                  <td className="r num" style={{ color: a.delta > 0 ? 'var(--ok)' : 'var(--err)', fontWeight: 700 }}>{a.delta > 0 ? '+' : ''}{a.delta}</td>
                  <td>{a.reason}</td>
                  <td className="subtle">{a.actor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {target && (
        <Modal title={target.kind === 'aptitude' ? `Aptitude score — ${target.row.teamId}` : `Adjust score — ${target.row.teamId}`}
          description={target.kind === 'adjust' ? `Current total: ${target.row.totalScore}. Use a negative number to deduct.` : 'Set the first-year aptitude score (added to the total).'}
          onClose={() => setTarget(null)}
          footer={<><button className="btn" onClick={() => setTarget(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={busy === 'save' || value === '' || (target.kind === 'adjust' && reason.trim().length < 3)}>Save</button></>}>
          <div className="stack">
            <Field label={target.kind === 'aptitude' ? 'Aptitude score' : 'Points (+/−)'}><input className="input num" type="number" step="0.5" autoFocus value={value} onChange={e => setValue(e.target.value)} /></Field>
            {target.kind === 'adjust' && <Field label="Reason (required, audited)"><input className="input" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Penalty — confirmed paste of external code" /></Field>}
          </div>
        </Modal>
      )}
    </div>
  );
};

export { Leaderboard };

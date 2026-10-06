import React, { useState } from 'react';
import { Download, FileClock, Search } from 'lucide-react';
import { api } from '../../services/api';
import { useLoad } from '../../hooks/useLoad';
import { Empty, parseTs, useAction } from '../../components/ui';

const tone = (a: string) =>
  /FAIL|BLOCK|LOCK|REJECT|OVERRIDE|EMERGENCY|EXCEPTION|RESET|FORCE|UNAVAILABLE/.test(a) ? 'badge-warn'
  : /ISSUE|LOGIN|SUBMIT|PUBLISH|STAGE|RESULT|ALLOC/.test(a) ? 'badge-accent' : '';

export const AuditPanel: React.FC = () => {
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const logs = useLoad(() => api.adminAuditLogs(applied, 300), { interval: 8000, deps: [applied] });
  const { run, busy } = useAction();
  const rows = logs.data ?? [];

  const exports: Array<[string, string]> = [
    ['audit', 'Audit log'], ['submissions', 'Submissions'], ['violations', 'Violations'], ['leaderboard', 'Leaderboard'], ['credentials', 'Credential events']
  ];

  return (
    <div className="stack">
      <div><div className="eyebrow">Records</div><h1 className="h-page">Audit & export</h1></div>

      <div className="card card-pad" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <span className="eyebrow" style={{ marginRight: 6 }}>Event report (CSV)</span>
        {exports.map(([k, label]) => (
          <button key={k} className="btn btn-sm" disabled={busy === k} onClick={() => run(k, () => api.adminExport(k))}><Download size={13} /> {label}</button>
        ))}
      </div>

      <form className="card card-pad" style={{ display: 'flex', gap: 10 }} onSubmit={e => { e.preventDefault(); setApplied(q); }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: 11, color: 'var(--text-3)' }} />
          <input className="input" style={{ paddingLeft: 30 }} placeholder="Search actor, action, target or detail (e.g. T05, ISSUE_PASSWORD, OVERRIDE)…" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <button className="btn btn-primary">Search</button>
        {applied && <button type="button" className="btn" onClick={() => { setQ(''); setApplied(''); }}>Clear</button>}
      </form>

      <div className="card">
        {rows.length === 0 ? <Empty icon={<FileClock size={28} />} title="No entries" /> : (
          <div className="table-wrap" style={{ maxHeight: 'calc(100vh - 360px)', minHeight: 300 }}>
            <table className="table">
              <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
              <tbody>
                {rows.map(l => (
                  <tr key={l.log_id}>
                    <td className="num subtle" style={{ whiteSpace: 'nowrap' }}>{new Date(parseTs(l.timestamp)).toLocaleTimeString()}</td>
                    <td style={{ fontWeight: 600 }}>{l.actor}</td>
                    <td><span className={`badge ${tone(l.action)} num`} style={{ fontSize: 11 }}>{l.action}</span></td>
                    <td className="num subtle" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.target}</td>
                    <td className="num subtle" style={{ fontSize: 11.5, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={l.metadata ?? ''}>{l.metadata}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

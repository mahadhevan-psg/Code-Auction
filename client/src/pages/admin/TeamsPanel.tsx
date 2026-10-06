import React, { useMemo, useState } from 'react';
import { Ban, FileUp, Lock, Plus, Search, Unlock, Users, Monitor, MonitorOff } from 'lucide-react';
import { api } from '../../services/api';
import { useLoad } from '../../hooks/useLoad';
import { Empty, Field, Modal, StatusBadge, Tabs, timeAgo, useAction, useToast } from '../../components/ui';
import type { AdminTeam } from '../../types';

export const TeamsPanel: React.FC = () => {
  const q = useLoad(() => api.adminTeams(), { interval: 6000, events: ['admin:session_change', 'violation:new', 'submission:status', 'priority:submitted', 'round:state', 'score:update'] });
  const { run, busy } = useAction();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [lockTeam, setLockTeam] = useState<AdminTeam | null>(null);
  const [lockReason, setLockReason] = useState('');
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [csv, setCsv] = useState('');

  const teams = useMemo(() => q.data ?? [], [q.data]);
  const rows = useMemo(() => teams.filter(t => {
    const s = search.trim().toLowerCase();
    if (s && !(t.team_id.toLowerCase().includes(s) || t.team_name.toLowerCase().includes(s))) return false;
    if (filter === 'online') return t.firstYearOnline + t.seniorOnline > 0;
    if (filter === 'offline') return t.status === 'ACTIVE' && t.firstYearOnline + t.seniorOnline === 0;
    if (filter === 'flagged') return t.openFlags > 0 || !!t.locked;
    if (filter === 'unallocated') return t.status === 'ACTIVE' && !t.problemId;
    return true;
  }), [teams, search, filter]);

  const counts = {
    online: teams.filter(t => t.firstYearOnline + t.seniorOnline > 0).length,
    flagged: teams.filter(t => t.openFlags > 0 || t.locked).length
  };

  const addTeam = async () => {
    const r = await run('add', () => api.adminCreateTeam(newId, newName), 'Team created.');
    if (r) { setAddOpen(false); setNewId(''); setNewName(''); q.reload(); }
  };
  const importTeams = async () => {
    const r = await run('import', () => api.adminImportTeams(csv));
    if (r) {
      setImportOpen(false); setCsv(''); q.reload();
      // surface skipped lines
      toast(r.skipped.length ? 'warn' : 'ok', `Imported ${r.created} team(s)${r.skipped.length ? `; skipped ${r.skipped.length} (duplicate or invalid): ${r.skipped.slice(0, 3).join(' | ')}` : '.'}`, 8000);
    }
  };
  const doLock = async () => {
    if (!lockTeam) return;
    await run('lock', () => api.adminLockTeam(lockTeam.team_id, true, lockReason || 'Locked by administrator'), `Team ${lockTeam.team_id} locked.`);
    setLockTeam(null); setLockReason(''); q.reload();
  };

  return (
    <div className="stack">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div><div className="eyebrow">Run</div><h1 className="h-page">Teams</h1></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => setImportOpen(true)}><FileUp size={15} /> Import</button>
          <button className="btn btn-primary" onClick={() => setAddOpen(true)}><Plus size={15} /> Add team</button>
        </div>
      </div>

      <div className="card">
        <div className="card-head" style={{ flexWrap: 'wrap' }}>
          <Tabs value={filter} onChange={setFilter} items={[
            { id: 'all', label: 'All', count: teams.length },
            { id: 'online', label: 'Online', count: counts.online },
            { id: 'offline', label: 'Offline' },
            { id: 'unallocated', label: 'No problem' },
            { id: 'flagged', label: 'Flagged', count: counts.flagged, alert: true }
          ]} />
          <div style={{ position: 'relative', width: 240 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: 9, color: 'var(--text-3)' }} />
            <input className="input input-sm" style={{ paddingLeft: 30 }} placeholder="Search team…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
        {rows.length === 0 ? <Empty icon={<Users size={28} />} title="No teams match" /> : (
          <div className="table-wrap" style={{ maxHeight: 'calc(100vh - 260px)' }}>
            <table className="table">
              <thead><tr>
                <th>Team</th><th>Connection</th><th>Priority</th><th>Problem</th><th>Last submission</th><th className="r">Score</th><th>Flags</th><th></th>
              </tr></thead>
              <tbody>
                {rows.map(t => (
                  <tr key={t.team_id} style={t.status === 'WITHDRAWN' ? { opacity: .5 } : undefined}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{t.team_name}</div>
                      <div className="subtle num" style={{ fontSize: 11.5 }}>{t.team_id}{t.status === 'WITHDRAWN' && ' · withdrawn'}</div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <span className={`badge ${t.firstYearOnline ? 'badge-ok' : ''}`} title="First-year sessions online">FY {t.firstYearOnline}</span>
                        <span className={`badge ${t.seniorOnline ? 'badge-ok' : ''}`} title="Senior sessions online">SR {t.seniorOnline}</span>
                        {t.notFullscreen && <span title="A connected participant is not in fullscreen" style={{ color: 'var(--warn)' }}><MonitorOff size={15} /></span>}
                        {!t.notFullscreen && t.lastHeartbeat && <span title="Heartbeat OK" style={{ color: 'var(--ok)' }}><Monitor size={15} /></span>}
                      </div>
                    </td>
                    <td className="num">{t.prioritySeq ? <span className="badge badge-ok">#{t.prioritySeq}</span> : <span className="subtle">—</span>}</td>
                    <td>
                      {t.problemId ? (<><div style={{ fontSize: 13 }}>{t.problemTitle}</div><div className="subtle num" style={{ fontSize: 11 }}>{t.priorityRank ? `choice #${t.priorityRank}` : 'override'}</div></>) : <span className="subtle">—</span>}
                    </td>
                    <td>
                      {t.lastSubmission
                        ? <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><StatusBadge status={t.lastSubmission.status} /><span className="num subtle" style={{ fontSize: 12 }}>{t.lastSubmission.passed}/{t.lastSubmission.total} · {timeAgo(t.lastSubmission.at)}</span></div>
                        : <span className="subtle">—</span>}
                    </td>
                    <td className="r num" style={{ fontWeight: 700 }}>{t.totalScore}</td>
                    <td>
                      {t.locked ? <span className="badge badge-err"><Lock size={11} /> Locked</span>
                        : t.openFlags ? <span className="badge badge-warn">{t.openFlags}</span> : <span className="subtle">—</span>}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {t.locked
                        ? <button className="btn btn-sm btn-ok" onClick={() => run('unlock', () => api.adminLockTeam(t.team_id, false), `Team ${t.team_id} unlocked.`).then(q.reload)}><Unlock size={13} /> Unlock</button>
                        : <button className="btn btn-sm" onClick={() => setLockTeam(t)}><Lock size={13} /> Lock</button>}
                      {' '}
                      <button className="btn btn-sm btn-ghost btn-icon" title={t.status === 'ACTIVE' ? 'Withdraw team' : 'Reinstate team'}
                        onClick={() => run('status', () => api.adminUpdateTeam(t.team_id, { status: t.status === 'ACTIVE' ? 'WITHDRAWN' : 'ACTIVE' }), t.status === 'ACTIVE' ? 'Team withdrawn.' : 'Team reinstated.').then(q.reload)}>
                        <Ban size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {addOpen && (
        <Modal title="Add team" onClose={() => setAddOpen(false)} footer={<><button className="btn" onClick={() => setAddOpen(false)}>Cancel</button><button className="btn btn-primary" onClick={addTeam} disabled={!newId || !newName || busy === 'add'}>Create</button></>}>
          <div className="stack">
            <Field label="Team ID" hint="Letters / digits, e.g. T33"><input className="input num" value={newId} onChange={e => setNewId(e.target.value.toUpperCase())} maxLength={12} autoFocus /></Field>
            <Field label="Team name"><input className="input" value={newName} onChange={e => setNewName(e.target.value)} /></Field>
          </div>
        </Modal>
      )}

      {importOpen && (
        <Modal title="Import teams" description="One team per line: ID, name[, aptitude score]. Existing IDs are skipped." onClose={() => setImportOpen(false)}
          footer={<><button className="btn" onClick={() => setImportOpen(false)}>Cancel</button><button className="btn btn-primary" onClick={importTeams} disabled={!csv.trim() || busy === 'import'}>Import</button></>}>
          <textarea className="textarea mono" rows={9} value={csv} onChange={e => setCsv(e.target.value)} placeholder={'T33, Compile Time Heroes\nT34, Off By One, 18'} style={{ fontSize: 13 }} />
        </Modal>
      )}

      {lockTeam && (
        <Modal title={`Lock team ${lockTeam.team_id}?`} description="Locked teams can't submit priorities or code until unlocked. Their work stays saved." onClose={() => setLockTeam(null)}
          footer={<><button className="btn" onClick={() => setLockTeam(null)}>Cancel</button><button className="btn btn-danger" onClick={doLock} disabled={busy === 'lock'}><Lock size={14} /> Lock team</button></>}>
          <Field label="Reason (shown to the team)"><input className="input" value={lockReason} onChange={e => setLockReason(e.target.value)} placeholder="e.g. Switching windows during round" autoFocus /></Field>
        </Modal>
      )}
    </div>
  );
};

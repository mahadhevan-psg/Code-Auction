import React, { useState } from 'react';
import { Check, History, KeyRound, LogOut, Monitor, MonitorOff, Wifi, WifiOff, X } from 'lucide-react';
import { api } from '../../services/api';
import { useLoad } from '../../hooks/useLoad';
import { Empty, Tabs, timeAgo, timeOnly, useAction } from '../../components/ui';
import type { LoginRequest } from '../../types';

const roleLabel = (r: string) => (r === 'FIRST_YEAR' ? 'First-year' : 'Senior');

export const PasswordsPanel: React.FC = () => {
  const { run, busy } = useAction();
  const [tab, setTab] = useState('requests');

  const reqs = useLoad(() => api.adminLoginRequests(), { interval: 3000, events: ['admin:login_request', 'auth:approved', 'auth:issued', 'admin:session_change'] });
  const sessions = useLoad(() => api.adminSessions(), { interval: 5000, events: ['admin:session_change'] });
  const history = useLoad(() => api.adminCredentialHistory(), { interval: 8000, enabled: tab === 'history', deps: [tab] });

  const approve = async (r: LoginRequest) => {
    await run('approve:' + r.request_id, () => api.adminApproveAccess(r.request_id), `Access approved for Team ${r.team_id}.`);
    reqs.reload();
    sessions.reload();
  };
  const reject = async (r: LoginRequest) => {
    await run('reject:' + r.request_id, () => api.adminRejectRequest(r.request_id), 'Request rejected.');
    reqs.reload();
  };
  const logout = async (id: string) => {
    await run('logout:' + id, () => api.adminRevokeSession(id), 'Session ended.');
    sessions.reload();
  };

  const pending = (reqs.data ?? []);
  const sess = sessions.data ?? [];

  return (
    <div className="stack">
      <div><div className="eyebrow">Run</div><h1 className="h-page">Password & Access Manager</h1></div>

      <Tabs value={tab} onChange={setTab} items={[
        { id: 'requests', label: 'Access requests', count: pending.filter(p => p.status === 'PENDING').length, alert: true, icon: <KeyRound size={14} /> },
        { id: 'sessions', label: 'Active sessions', count: sess.length, icon: <Wifi size={14} /> },
        { id: 'history', label: 'Credential history', icon: <History size={14} /> }
      ]} />

      {tab === 'requests' && (
        <div className="card">
          {pending.length === 0 ? <Empty icon={<KeyRound size={28} />} title="No open requests" hint="When a participant requests access it appears here instantly." /> : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Team</th>
                    <th>Role</th>
                    <th>Active Logins</th>
                    <th>Requested</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pending.map(r => {
                    const activeCount = r.active_role_sessions ?? 0;
                    return (
                      <tr key={r.request_id}>
                        <td><div style={{ fontWeight: 650 }}>{r.team_id}</div><div className="subtle" style={{ fontSize: 12 }}>{r.team_name}</div></td>
                        <td><span className={`badge ${r.role === 'FIRST_YEAR' ? 'badge-info' : 'badge-accent'}`}>{roleLabel(r.role)}</span></td>
                        <td>
                          {activeCount > 0 ? (
                            <span className="badge badge-warn"><Wifi size={11} /> {activeCount} active ({roleLabel(r.role)})</span>
                          ) : (
                            <span className="badge badge-ok">0 active ({roleLabel(r.role)})</span>
                          )}
                        </td>
                        <td className="num"><div>{timeOnly(r.requested_at)}</div><div className="subtle" style={{ fontSize: 11.5 }}>{timeAgo(r.requested_at)}</div></td>
                        <td><span className="badge badge-warn">Awaiting approval</span></td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button className="btn btn-sm btn-primary" disabled={busy === 'approve:' + r.request_id} onClick={() => approve(r)}>
                            <Check size={14} /> Approve Access
                          </button>{' '}
                          <button className="btn btn-sm btn-ghost btn-danger" disabled={busy === 'reject:' + r.request_id} onClick={() => reject(r)}><X size={13} /> Reject</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'sessions' && (
        <div className="card">
          {sess.length === 0 ? <Empty icon={<WifiOff size={28} />} title="Nobody is logged in" /> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Team</th><th>Role</th><th>Status</th><th>Secure mode</th><th>Logged in</th><th>Last seen</th><th style={{ textAlign: 'right' }}></th></tr></thead>
                <tbody>
                  {sess.map(s => (
                    <tr key={s.session_id}>
                      <td><div style={{ fontWeight: 650 }}>{s.team_id}</div><div className="subtle" style={{ fontSize: 12 }}>{s.team_name}</div></td>
                      <td><span className={`badge ${s.role === 'FIRST_YEAR' ? 'badge-info' : 'badge-accent'}`}>{roleLabel(s.role)}</span></td>
                      <td>{s.online ? <span className="badge badge-ok"><span className="dot dot-ok" style={{ width: 6, height: 6 }} /> Online</span> : <span className="badge">Idle</span>}</td>
                      <td>
                        {!s.rules_ack_at ? <span className="badge badge-warn">Rules pending</span>
                          : s.fullscreen === 1 ? <span className="badge badge-ok"><Monitor size={11} /> Fullscreen</span>
                          : s.fullscreen === 0 ? <span className="badge badge-err"><MonitorOff size={11} /> Windowed</span>
                          : <span className="subtle">—</span>}
                      </td>
                      <td className="num subtle">{timeOnly(s.created_at)}</td>
                      <td className="num subtle">{timeAgo(s.last_seen)}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn btn-sm btn-danger" disabled={busy === 'logout:' + s.session_id} onClick={() => logout(s.session_id)}><LogOut size={13} /> Force logout</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'history' && (
        <div className="card">
          {(history.data ?? []).length === 0 ? <Empty icon={<History size={28} />} title="No credentials issued yet" /> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Team</th><th>Role</th><th>Issued</th><th>Expires</th><th>Used</th><th>Status</th></tr></thead>
                <tbody>
                  {history.data!.map(c => (
                    <tr key={c.credential_id}>
                      <td style={{ fontWeight: 650 }}>{c.team_id}</td>
                      <td>{roleLabel(c.role)}</td>
                      <td className="num">{timeOnly(c.issued_at)}</td>
                      <td className="num subtle">{timeOnly(c.expires_at)}</td>
                      <td className="num subtle">{c.used_at ? timeOnly(c.used_at) : '—'}</td>
                      <td><span className={`badge ${c.status === 'USED' ? 'badge-ok' : c.status === 'ISSUED' ? 'badge-info' : c.status === 'REVOKED' ? 'badge-warn' : 'badge-err'}`}>{c.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

    </div>
  );
};

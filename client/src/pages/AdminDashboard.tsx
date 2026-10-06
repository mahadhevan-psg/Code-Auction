import React, { useEffect, useState } from 'react';
import {
  Activity, ClipboardList, FileClock, FlaskConical, Gauge, KeyRound, Settings, ShieldAlert, Swords, Trophy, Users
} from 'lucide-react';
import { api } from '../services/api';
import { socket } from '../socket/socket';
import { useLoad } from '../hooks/useLoad';
import { useToast } from '../components/ui';
import { OverviewPanel } from './admin/OverviewPanel';
import { TeamsPanel } from './admin/TeamsPanel';
import { PasswordsPanel } from './admin/PasswordsPanel';
import { AllocationPanel } from './admin/AllocationPanel';
import { ProblemsPanel } from './admin/ProblemsPanel';
import { SubmissionsPanel } from './admin/SubmissionsPanel';
import { ProctoringPanel } from './admin/ProctoringPanel';
import { ScoresPanel } from './admin/ScoresPanel';
import { AuditPanel } from './admin/AuditPanel';
import { SettingsPanel } from './admin/SettingsPanel';
import type { EventState } from '../types';

type Section = 'overview' | 'teams' | 'passwords' | 'allocation' | 'problems' | 'submissions' | 'proctoring' | 'scores' | 'audit' | 'settings';

const NAV: Array<{ id: Section; label: string; icon: React.ReactNode; group: 'Run' | 'Content' | 'Integrity' | 'Records' }> = [
  { id: 'overview', label: 'Overview', icon: <Gauge size={17} />, group: 'Run' },
  { id: 'teams', label: 'Teams', icon: <Users size={17} />, group: 'Run' },
  { id: 'passwords', label: 'Password manager', icon: <KeyRound size={17} />, group: 'Run' },
  { id: 'allocation', label: 'Allocation', icon: <Swords size={17} />, group: 'Run' },
  { id: 'problems', label: 'Problems', icon: <FlaskConical size={17} />, group: 'Content' },
  { id: 'submissions', label: 'Submissions', icon: <ClipboardList size={17} />, group: 'Content' },
  { id: 'proctoring', label: 'Proctoring', icon: <ShieldAlert size={17} />, group: 'Integrity' },
  { id: 'scores', label: 'Scores', icon: <Trophy size={17} />, group: 'Records' },
  { id: 'audit', label: 'Audit & export', icon: <FileClock size={17} />, group: 'Records' },
  { id: 'settings', label: 'Settings', icon: <Settings size={17} />, group: 'Records' }
];

export const AdminDashboard: React.FC<{ eventState: EventState; remaining: number }> = ({ eventState, remaining }) => {
  const toast = useToast();
  const [section, setSection] = useState<Section>(() => (sessionStorage.getItem('adminSection') as Section) || 'overview');
  const overview = useLoad(() => api.adminOverview(), {
    interval: 5000,
    events: ['admin:login_request', 'admin:session_change', 'violation:new', 'submission:status', 'priority:submitted', 'score:update', 'round:state'],
    deps: [eventState.state, eventState.roundId]
  });

  useEffect(() => { try { sessionStorage.setItem('adminSection', section); } catch { /* ignore */ } }, [section]);

  // Operational alerts from the server.
  useEffect(() => {
    const onAlert = (a: { level: 'info' | 'warn' | 'error'; message: string }) =>
      toast(a.level === 'error' ? 'err' : a.level === 'warn' ? 'warn' : 'info', a.message, a.level === 'error' ? 9000 : 5000);
    const onRequest = (r: { team_id: string; role: string }) => toast('info', `Password requested: ${r.team_id} (${r.role === 'FIRST_YEAR' ? 'first-year' : 'senior'})`, 6000);
    socket.on('admin:alert', onAlert);
    socket.on('admin:login_request', onRequest);
    return () => { socket.off('admin:alert', onAlert); socket.off('admin:login_request', onRequest); };
  }, [toast]);

  const ov = overview.data;
  const badge = (id: Section) =>
    id === 'passwords' ? ov?.pendingRequests : id === 'proctoring' ? ov?.violations.high : undefined;

  const groups = ['Run', 'Content', 'Integrity', 'Records'] as const;

  return (
    <div className="admin-shell">
      <nav className="sidebar" aria-label="Admin sections">
        {groups.map(g => (
          <div key={g}>
            <div className="eyebrow nav-section">{g}</div>
            {NAV.filter(n => n.group === g).map(n => {
              const count = badge(n.id);
              return (
                <button key={n.id} className="nav-item" aria-current={section === n.id ? 'page' : undefined} onClick={() => setSection(n.id)}>
                  {n.icon}<span>{n.label}</span>
                  {!!count && <span className="nav-badge">{count}</span>}
                </button>
              );
            })}
          </div>
        ))}
        <div style={{ flex: 1 }} />
        <div className="subtle" style={{ fontSize: 11.5, padding: '16px 10px 0', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Activity size={13} /> Live · {ov ? `${ov.sessions.online} online` : '…'}
        </div>
      </nav>

      <main className="page page-wide" style={{ width: '100%', minWidth: 0 }}>
        {section === 'overview' && <OverviewPanel eventState={eventState} remaining={remaining} overview={ov} reload={overview.reload} go={s => setSection(s as Section)} />}
        {section === 'teams' && <TeamsPanel />}
        {section === 'passwords' && <PasswordsPanel />}
        {section === 'allocation' && <AllocationPanel eventState={eventState} />}
        {section === 'problems' && <ProblemsPanel eventState={eventState} />}
        {section === 'submissions' && <SubmissionsPanel eventState={eventState} />}
        {section === 'proctoring' && <ProctoringPanel />}
        {section === 'scores' && <ScoresPanel />}
        {section === 'audit' && <AuditPanel />}
        {section === 'settings' && <SettingsPanel eventState={eventState} />}
      </main>
    </div>
  );
};

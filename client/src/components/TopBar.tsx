import React from 'react';
import { Code2, LogOut, Moon, Pause, Sun, Timer, Trophy, Wifi, WifiOff, ShieldCheck, Users, UserCheck } from 'lucide-react';
import type { EventState, UserSession } from '../types';
import { formatClock } from './ui';
import { ProctorChip } from './ProctorOverlays';

interface Props {
  user: UserSession | null;
  eventState: EventState;
  remaining: number;
  connected: boolean;
  theme: 'dark' | 'light';
  score?: number | null;
  onToggleTheme: () => void;
  onLogout: () => void;
}

export const TopBar: React.FC<Props> = ({ user, eventState, remaining, connected, theme, score, onToggleTheme, onLogout }) => {
  const timed = eventState.state === 'PRIORITY_SELECTION' || eventState.state === 'CODING';
  const urgent = timed && !eventState.paused && remaining <= 60;
  const RoleIcon = user?.role === 'ADMIN' ? ShieldCheck : user?.role === 'FIRST_YEAR' ? Users : UserCheck;

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark"><Code2 size={18} strokeWidth={2.4} /></span>
        <span className="hide-sm">Algorithm Auction</span>
      </div>

      {user && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 6 }}>
          <span className="badge badge-accent">Round {eventState.roundNumber}</span>
          {timed && (
            <span className={`timer-chip timer ${urgent ? 'urgent' : ''} ${eventState.paused ? 'paused' : ''}`} title={eventState.paused ? 'Paused by the administrator' : 'Server-controlled countdown'}>
              {eventState.paused ? <Pause size={16} /> : <Timer size={16} />}
              {formatClock(remaining)}
            </span>
          )}
        </div>
      )}

      <div style={{ flex: 1 }} />

      {user && user.role !== 'ADMIN' && score !== undefined && score !== null && (
        <span className="chip" title="Team score so far">
          <Trophy size={15} style={{ color: 'var(--warn)' }} />
          <span className="num" style={{ color: 'var(--text)' }}>{score}</span>
          <span className="hide-sm subtle">pts</span>
        </span>
      )}

      {user && user.role !== 'ADMIN' && <ProctorChip />}

      <span className="chip hide-xs" title={connected ? 'Live connection to the server' : 'Reconnecting…'} style={{ padding: '0 10px' }}>
        {connected ? <Wifi size={15} style={{ color: 'var(--ok)' }} /> : <WifiOff size={15} style={{ color: 'var(--err)' }} />}
      </span>

      <button className="btn btn-icon btn-ghost" onClick={onToggleTheme} aria-label="Toggle theme" title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}>
        {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
      </button>

      {user && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 10, borderLeft: '1px solid var(--border)', flex: 'none' }}>
          <div style={{ lineHeight: 1.2, textAlign: 'right' }} className="hide-sm">
            <div style={{ fontSize: 13, fontWeight: 650 }}>{user.role === 'ADMIN' ? 'Administrator' : (user.teamName || `Team ${user.teamId}`)}</div>
            <div className="subtle" style={{ fontSize: 11 }}>
              {user.role === 'ADMIN' ? 'Control room' : `${user.teamId} · ${user.role === 'FIRST_YEAR' ? 'First-year' : 'Senior'}`}
            </div>
          </div>
          <span className="chip hide-xs" style={{ width: 34, padding: 0, justifyContent: 'center' }}><RoleIcon size={16} /></span>
          <button className="btn btn-sm" onClick={onLogout} title="Log out"><LogOut size={14} /><span className="hide-sm">Log out</span></button>
        </div>
      )}
    </header>
  );
};

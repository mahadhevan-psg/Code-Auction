import React from 'react';
import { Medal, Trophy } from 'lucide-react';
import type { LeaderboardEntry } from '../types';
import { Empty } from './ui';

const medal = (rank: number) =>
  rank === 1 ? 'var(--warn)' : rank === 2 ? '#9aa3b8' : rank === 3 ? '#c9833f' : null;

export const Leaderboard: React.FC<{ rows: LeaderboardEntry[]; myTeamId?: string; showAdjustment?: boolean; compact?: boolean }> = ({ rows, myTeamId, showAdjustment, compact }) => {
  if (!rows.length) return <Empty icon={<Trophy size={28} />} title="No scores yet" hint="Scores appear here once teams submit." />;

  return (
    <div className="table-wrap" style={compact ? { maxHeight: 520, overflowY: 'auto' } : undefined}>
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 70 }}>Rank</th>
            <th>Team</th>
            <th className="r">Round 1</th>
            <th className="r">Round 2</th>
            <th className="r">Aptitude</th>
            {showAdjustment && <th className="r">Adj.</th>}
            <th className="r">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const c = medal(r.rank);
            return (
              <tr key={r.teamId} className={r.teamId === myTeamId ? 'row-me' : ''}>
                <td>
                  <span className="num" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 700, color: c ?? 'var(--text-2)' }}>
                    {c && <Medal size={16} />}#{r.rank}
                  </span>
                </td>
                <td>
                  <div style={{ fontWeight: 600 }}>{r.teamName}</div>
                  <div className="subtle num" style={{ fontSize: 11.5 }}>{r.teamId}{r.teamId === myTeamId && ' · you'}</div>
                </td>
                <td className="r num">{r.round1Score}</td>
                <td className="r num">{r.round2Score}</td>
                <td className="r num subtle">{r.aptitudeScore}</td>
                {showAdjustment && <td className="r num subtle">{r.adjustment ? (r.adjustment > 0 ? `+${r.adjustment}` : r.adjustment) : '—'}</td>}
                <td className="r num" style={{ fontWeight: 700, fontSize: 15 }}>{r.totalScore}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

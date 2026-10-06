import React from 'react';
import { Check } from 'lucide-react';
import type { EventStage } from '../types';

const STEPS: Array<{ id: EventStage; label: string }> = [
  { id: 'WAITING', label: 'Lobby' },
  { id: 'PRIORITY_SELECTION', label: 'Priorities' },
  { id: 'ALLOCATION', label: 'Allocation' },
  { id: 'CODING', label: 'Coding' },
  { id: 'ROUND_ENDED', label: 'Time up' },
  { id: 'SCOREBOARD', label: 'Scoreboard' }
];

export const PhaseBar: React.FC<{ stage: EventStage; roundNumber: number; totalRounds: number }> = ({ stage, roundNumber, totalRounds }) => {
  const final = stage === 'FINAL_LEADERBOARD';
  const current = final ? STEPS.length : STEPS.findIndex(s => s.id === stage);
  return (
    <div className="stepper" aria-label={`Round ${roundNumber} of ${totalRounds}`}>
      {STEPS.map((s, i) => {
        const cls = i < current ? 'done' : i === current ? 'current' : '';
        return (
          <React.Fragment key={s.id}>
            <div className={`step ${cls}`} aria-current={i === current ? 'step' : undefined}>
              <span className="step-num">{i < current ? <Check size={12} strokeWidth={3} /> : i + 1}</span>
              {s.label}
            </div>
            {i < STEPS.length - 1 && <span className="step-line" />}
          </React.Fragment>
        );
      })}
    </div>
  );
};

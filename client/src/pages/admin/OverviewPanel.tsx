import React, { useState } from 'react';
import {
  CheckCircle2, ChevronRight, ClipboardList, Flag, KeyRound, Pause, Play, Plus, Minus, Radio, Swords,
  Trophy, Users, Square, Timer, AlertTriangle, Rocket, RotateCw, FastForward
} from 'lucide-react';
import { api } from '../../services/api';
import { Banner, ConfirmModal, Modal, StatCard, formatClock, useAction } from '../../components/ui';
import { PhaseBar } from '../../components/PhaseBar';
import type { AdminOverview, EventState } from '../../types';

interface Props {
  eventState: EventState;
  remaining: number;
  overview: AdminOverview | null;
  reload: () => void;
  go: (section: string) => void;
}

interface Step {
  label: string;
  action: string;
  icon: React.ReactNode;
  help: string;
  confirm?: { title: string; body: string };
  tone?: 'primary' | 'danger';
}

const STAGE_COPY: Record<EventState['state'], { title: string; blurb: string }> = {
  WAITING: { title: 'Lobby', blurb: 'Teams are logging in. Nothing is revealed yet.' },
  PRIORITY_SELECTION: { title: 'Priority selection', blurb: 'First-years rank the five problems. Allocation runs automatically when the timer ends.' },
  ALLOCATION: { title: 'Allocation done', blurb: 'Review the buckets, fix any exceptions, then start the coding timer.' },
  CODING: { title: 'Coding live', blurb: 'Seniors are coding. Submissions are judged as they arrive.' },
  ROUND_ENDED: { title: 'Time up', blurb: 'Submissions closed. Wait for the judge queue to drain, then publish the scoreboard.' },
  SCOREBOARD: { title: 'Scoreboard published', blurb: 'Participants can see the round standings.' },
  FINAL_LEADERBOARD: { title: 'Event complete', blurb: 'The final leaderboard is public.' }
};

function nextStep(s: EventState): Step | null {
  switch (s.state) {
    case 'WAITING': return { label: 'Open priority selection', action: 'open-priority', icon: <Rocket size={17} />, help: 'Reveals the five problems and starts the priority timer.' };
    case 'PRIORITY_SELECTION': return { label: 'Close & allocate now', action: 'close-priority', icon: <Swords size={17} />, help: 'Freezes rankings early and runs the allocation.', confirm: { title: 'Close priority selection early?', body: 'Teams that have not submitted will be allocated using the default problem order.' } };
    case 'ALLOCATION': return { label: 'Start coding', action: 'start-coding', icon: <Play size={17} />, help: 'Reveals statements and starts the coding timer.' };
    case 'CODING': return { label: 'End coding now', action: 'end-coding', icon: <Square size={17} />, help: 'Closes the coding window for everyone.', tone: 'danger', confirm: { title: 'End the coding round now?', body: 'All editors lock immediately and further submissions are rejected.' } };
    case 'ROUND_ENDED': return { label: 'Publish scoreboard', action: 'show-scoreboard', icon: <Trophy size={17} />, help: 'Shows round standings to all participants.' };
    case 'SCOREBOARD': return s.roundId >= s.totalRounds
      ? { label: 'Publish final leaderboard', action: 'next-round', icon: <Trophy size={17} />, help: 'Finishes the event and shows the final ranking.', confirm: { title: 'Publish the final leaderboard?', body: 'This marks the event as complete.' } }
      : { label: `Start round ${s.roundId + 1}`, action: 'next-round', icon: <ChevronRight size={17} />, help: 'Moves everyone to the next round lobby.' };
    default: return null;
  }
}

export const OverviewPanel: React.FC<Props> = ({ eventState, remaining, overview, reload, go }) => {
  const { run, busy } = useAction();
  const [confirm, setConfirm] = useState<Step | null>(null);
  const [forceModal, setForceModal] = useState(false);
  const step = nextStep(eventState);
  const timed = eventState.state === 'PRIORITY_SELECTION' || eventState.state === 'CODING';
  const copy = STAGE_COPY[eventState.state];

  const exec = async (action: string, body?: Record<string, unknown>, ok?: string) => {
    const r = await run(action, () => api.adminEvent(action, body), ok);
    if (r) reload();
    return r;
  };

  const onPrimary = async (st: Step) => {
    if (st.confirm) { setConfirm(st); return; }
    const r = await exec(st.action);
    // Starting coding can be blocked by unresolved allocation exceptions — offer a forced start.
    if (!r && st.action === 'start-coding') setForceModal(true);
  };

  const ov = overview;
  const prio = ov?.priority;
  const exceptions = ov ? Math.max(0, ov.teams.active - ov.allocation.allocated) : 0;

  return (
    <div className="stack">
      <div>
        <div className="eyebrow">Control room</div>
        <h1 className="h-page">Event overview</h1>
      </div>

      {eventState.allocationError && (
        <Banner kind="err" icon={<AlertTriangle size={17} />} action={<button className="btn btn-sm" onClick={() => exec('rerun-allocation', undefined, 'Allocation re-run.')}>Retry allocation</button>}>
          <b>Allocation failed.</b> Participants are frozen on the allocation screen. {eventState.allocationError}
        </Banner>
      )}

      {/* ---------------- stage control ---------------- */}
      <div className="card">
        <div className="card-body stack" style={{ gap: 18 }}>
          <PhaseBar stage={eventState.state} roundNumber={eventState.roundNumber} totalRounds={eventState.totalRounds} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ minWidth: 260, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="badge badge-accent">Round {eventState.roundNumber} of {eventState.totalRounds}</span>
                <span className="badge badge-ok"><Radio size={11} className="dot-live" /> Live</span>
              </div>
              <h2 style={{ fontSize: 24, marginTop: 8 }}>{copy.title}</h2>
              <p className="muted" style={{ marginTop: 4, maxWidth: 520 }}>{copy.blurb}</p>
            </div>

            {timed && (
              <div style={{ textAlign: 'center' }}>
                <div className="eyebrow">{eventState.paused ? 'Paused at' : 'Remaining'}</div>
                <div className="timer" style={{ fontSize: 48, lineHeight: 1.1, color: eventState.paused ? 'var(--warn)' : remaining <= 60 ? 'var(--err)' : 'var(--text)' }}>{formatClock(remaining)}</div>
                <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginTop: 8 }}>
                  {eventState.paused
                    ? <button className="btn btn-sm btn-ok" onClick={() => exec('resume', undefined, 'Timer resumed.')} disabled={!!busy}><Play size={13} /> Resume</button>
                    : <button className="btn btn-sm" onClick={() => exec('pause', undefined, 'Timer paused for everyone.')} disabled={!!busy}><Pause size={13} /> Pause</button>}
                  <button className="btn btn-sm" onClick={() => exec('extend', { seconds: -60 })} disabled={!!busy} title="Remove one minute"><Minus size={13} />1m</button>
                  <button className="btn btn-sm" onClick={() => exec('extend', { seconds: 60 })} disabled={!!busy} title="Add one minute"><Plus size={13} />1m</button>
                  <button className="btn btn-sm" onClick={() => exec('extend', { seconds: 300 })} disabled={!!busy} title="Add five minutes"><Plus size={13} />5m</button>
                </div>
              </div>
            )}

            <div style={{ display: 'grid', gap: 8, minWidth: 250 }}>
              {step ? (
                <>
                  <button className={`btn btn-lg ${step.tone === 'danger' ? 'btn-danger' : 'btn-primary'}`} onClick={() => onPrimary(step)} disabled={!!busy}>
                    {step.icon}{step.label}
                  </button>
                  <span className="hint" style={{ textAlign: 'center' }}>{step.help}</span>
                </>
              ) : (
                <span className="badge badge-ok" style={{ justifySelf: 'center' }}><CheckCircle2 size={13} /> Nothing left to run</span>
              )}
              {eventState.state === 'ALLOCATION' && (
                <button className="btn btn-sm" onClick={() => exec('rerun-allocation', undefined, 'Allocation re-run.')} disabled={!!busy}><RotateCw size={13} /> Re-run allocation</button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ---------------- live stats ---------------- */}
      <div className="grid-auto">
        <StatCard label="Teams online" icon={<Users size={16} />} tone="ok"
          value={<>{ov?.teams.online ?? '–'}<span className="subtle" style={{ fontSize: 16 }}> / {ov?.teams.active ?? '–'}</span></>}
          sub={`${ov?.sessions.online ?? 0} session${ov?.sessions.online === 1 ? '' : 's'} connected`} progress={ov && ov.teams.active ? ov.teams.online / ov.teams.active : 0} />
        <StatCard label="Password requests" icon={<KeyRound size={16} />} tone={ov?.pendingRequests ? 'warn' : undefined}
          value={ov?.pendingRequests ?? '–'} sub={<button className="btn-ghost" style={{ background: 'none', border: 0, padding: 0, color: 'var(--accent-text)', fontSize: 12 }} onClick={() => go('passwords')}>Open password manager →</button>} />
        <StatCard label="Priorities in" icon={<ClipboardList size={16} />} tone="accent"
          value={<>{prio?.submitted ?? '–'}<span className="subtle" style={{ fontSize: 16 }}> / {prio?.total ?? '–'}</span></>}
          sub={eventState.state === 'PRIORITY_SELECTION' ? 'Waiting on remaining teams' : 'This round'} progress={prio && prio.total ? prio.submitted / prio.total : 0} />
        <StatCard label="Allocated" icon={<Swords size={16} />} tone={exceptions && ov?.allocation.allocated ? 'err' : 'accent'}
          value={<>{ov?.allocation.allocated ?? '–'}<span className="subtle" style={{ fontSize: 16 }}> / {ov?.teams.active ?? '–'}</span></>}
          sub={exceptions && ov?.allocation.allocated ? `${exceptions} unallocated — check exceptions` : 'Teams with a problem'} progress={ov && ov.teams.active ? ov.allocation.allocated / ov.teams.active : 0} />
        <StatCard label="Submissions" icon={<Timer size={16} />} tone="accent"
          value={ov?.submissions.total ?? '–'} sub={`${ov?.submissions.accepted ?? 0} accepted · ${ov?.submissions.pending ?? 0} judging`} />
        <StatCard label="Open flags" icon={<Flag size={16} />} tone={ov?.violations.high ? 'err' : ov?.violations.open ? 'warn' : undefined}
          value={ov?.violations.open ?? '–'} sub={<button className="btn-ghost" style={{ background: 'none', border: 0, padding: 0, color: 'var(--accent-text)', fontSize: 12 }} onClick={() => go('proctoring')}>{ov?.violations.high ?? 0} high severity →</button>} />
      </div>

      {/* ---------------- buckets ---------------- */}
      <div className="card">
        <div className="card-head"><h3><Swords size={16} style={{ color: 'var(--accent-text)' }} /> Problem buckets</h3><span className="hint">Visible to admins only — participants never see capacity.</span></div>
        <div className="card-body" style={{ display: 'grid', gap: 12 }}>
          {ov?.allocation.summary.length ? ov.allocation.summary.map(b => (
            <div key={b.problem_id} style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 260px) 1fr 72px', gap: 14, alignItems: 'center' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.title}</div>
                <div className="subtle num" style={{ fontSize: 11.5 }}>{b.problem_id} · {b.difficulty}</div>
              </div>
              <div className="progress"><span style={{ width: `${b.capacity ? (b.assigned / b.capacity) * 100 : 0}%`, background: b.assigned > b.capacity ? 'var(--err)' : b.assigned === b.capacity && b.capacity ? 'var(--ok)' : 'var(--accent)' }} /></div>
              <div className="num r" style={{ textAlign: 'right', fontSize: 13 }}>{b.assigned} / {b.capacity}</div>
            </div>
          )) : <p className="muted">No published problems for this round.</p>}
        </div>
      </div>

      {confirm && (
        <ConfirmModal
          title={confirm.confirm!.title}
          body={confirm.confirm!.body}
          confirmLabel={confirm.label}
          danger={confirm.tone === 'danger'}
          busy={busy === confirm.action}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => { const c = confirm; await exec(c.action); setConfirm(null); }}
        />
      )}

      {forceModal && (
        <Modal title="Some teams have no problem" onClose={() => setForceModal(false)}
          footer={<>
            <button className="btn" onClick={() => { setForceModal(false); go('allocation'); }}>Resolve in Allocation</button>
            <button className="btn btn-danger" onClick={async () => { await exec('start-coding', { force: true }); setForceModal(false); }}><FastForward size={15} /> Start anyway</button>
          </>}>
          <p className="muted">Coding can't start cleanly while teams are unallocated. Assign them a problem manually, or force-start and those teams will be unable to submit.</p>
        </Modal>
      )}
    </div>
  );
};

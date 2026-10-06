import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import confetti from 'canvas-confetti';
import {
  ArrowDown, ArrowUp, CheckCircle2, ChevronDown, Clock, Eye, GripVertical, Hourglass, ListOrdered,
  Lock, Send, Sparkles, Target, Trophy, Loader2, Radio
} from 'lucide-react';
import { api } from '../services/api';
import { socket } from '../socket/socket';
import { useLoad } from '../hooks/useLoad';
import { Banner, ConfirmModal, DifficultyBadge, Empty, StatusBadge, formatClock, timeAgo, useAction } from '../components/ui';
import { Leaderboard } from '../components/Leaderboard';
import type { EventState, TeamAllocation, TeamStatus, UserSession } from '../types';

interface Props {
  user: UserSession;
  eventState: EventState;
  remaining: number;
  scoreRefresh: number;
}

const draftKey = (teamId: string, roundId: number) => `rank-draft:${teamId}:${roundId}`;

/* ------------------------------------------------------------------ */
/* Priority selection                                                  */
/* ------------------------------------------------------------------ */
const PrioritySelection: React.FC<Props> = ({ user, eventState, remaining }) => {
  const roundId = eventState.roundId;
  const { run, busy } = useAction();
  const problemsQ = useLoad(() => api.getProblems(roundId), { deps: [roundId] });
  const submittedQ = useLoad(() => api.getMyPriorities(roundId), { deps: [roundId] });

  const [order, setOrder] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  const problems = useMemo(() => problemsQ.data ?? [], [problemsQ.data]);
  const submitted = submittedQ.data;
  const byId = useMemo(() => new Map(problems.map(p => [p.problem_id, p])), [problems]);
  const closed = eventState.state !== 'PRIORITY_SELECTION';

  // Initialise (or restore a saved draft of) the ranking once problems arrive.
  useEffect(() => {
    if (!problems.length) return;
    let initial = problems.map(p => p.problem_id);
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey(user.teamId, roundId)) || 'null') as string[] | null;
      if (saved && saved.length === initial.length && saved.every(id => byId.has(id))) initial = saved;
    } catch { /* ignore */ }
    setOrder(initial);
  }, [problems.length, roundId, user.teamId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (order.length) { try { localStorage.setItem(draftKey(user.teamId, roundId), JSON.stringify(order)); } catch { /* ignore */ } }
  }, [order, user.teamId, roundId]);

  const move = useCallback((from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return;
    setOrder(prev => {
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }, [order.length]);

  const submit = async () => {
    await run('submit', async () => {
      await api.submitPriorities(roundId, order);
      await submittedQ.reload();
      setConfirm(false);
    }, 'Priorities submitted. Allocation runs when the timer ends.');
    setConfirm(false);
  };

  if (problemsQ.loading) return <div className="card card-pad"><div className="skeleton" style={{ height: 320 }} /></div>;
  if (problemsQ.error) return <Banner kind="err">{problemsQ.error}</Banner>;

  const lockedIn = !!submitted;
  const display = lockedIn ? submitted!.rankings : order;
  const urgent = remaining <= 30 && !lockedIn;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 16, alignItems: 'start' }} className="fy-grid">
      <div className="stack">
        <div className="card">
          <div className="card-head">
            <h3><ListOrdered size={17} style={{ color: 'var(--accent-text)' }} /> Rank the five problems</h3>
            {lockedIn
              ? <span className="badge badge-ok"><Lock size={12} /> Locked in · #{submitted!.sequenceNo} to submit</span>
              : closed
                ? <span className="badge badge-err">Closed</span>
                : <span className="badge badge-warn"><Clock size={12} /> Not submitted</span>}
          </div>
          <div className="card-body stack" style={{ gap: 10 }}>
            {!lockedIn && !closed && (
              <p className="muted" style={{ fontSize: 13 }}>
                Put your <b style={{ color: 'var(--text)' }}>favourite first</b>. Teams are processed in the order they submit: you get your highest-ranked problem that still has room.
                Drag the handle or use the arrows.
              </p>
            )}
            {display.map((id, idx) => {
              const p = byId.get(id);
              if (!p) return null;
              const open = expanded === id;
              return (
                <div key={id}>
                  <div
                    className={`rank-item ${dragIdx === idx ? 'dragging' : ''} ${overIdx === idx && dragIdx !== null && dragIdx !== idx ? 'over' : ''}`}
                    draggable={!lockedIn && !closed}
                    data-draggable
                    onDragStart={e => { setDragIdx(idx); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); }}
                    onDragOver={e => { if (dragIdx !== null) { e.preventDefault(); setOverIdx(idx); } }}
                    onDrop={e => { e.preventDefault(); if (dragIdx !== null) move(dragIdx, idx); setDragIdx(null); setOverIdx(null); }}
                    onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
                  >
                    <span className={`rank-badge ${idx === 0 ? 'r1' : idx === 1 ? 'r2' : idx === 2 ? 'r3' : ''}`}>{idx + 1}</span>
                    <span className="grip" title="Drag to reorder" style={{ visibility: lockedIn || closed ? 'hidden' : 'visible' }}><GripVertical size={18} /></span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 650, fontSize: 15 }}>{p.title}</span>
                        <DifficultyBadge difficulty={p.difficulty} weight={p.weight} />
                      </div>
                      <button className="btn-ghost" style={{ border: 0, background: 'none', padding: 0, marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12.5, color: 'var(--text-3)' }}
                        onClick={() => setExpanded(open ? null : id)}>
                        <ChevronDown size={14} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: '.15s' }} />
                        {open ? 'Hide statement' : 'Read statement'}
                      </button>
                    </div>
                    {!lockedIn && !closed && (
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button className="btn btn-sm btn-icon" onClick={() => move(idx, idx - 1)} disabled={idx === 0} aria-label={`Move ${p.title} up`}><ArrowUp size={15} /></button>
                        <button className="btn btn-sm btn-icon" onClick={() => move(idx, idx + 1)} disabled={idx === display.length - 1} aria-label={`Move ${p.title} down`}><ArrowDown size={15} /></button>
                      </div>
                    )}
                  </div>
                  {open && (
                    <div className="card-flat fade-in" style={{ margin: '6px 0 0 50px', padding: 14 }}>
                      <div className="prose allow-select" style={{ fontSize: 13.5 }}>{p.statement}</div>
                      {p.constraints && <div className="code-block" style={{ marginTop: 10 }}>{p.constraints}</div>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <aside className="stack" style={{ position: 'sticky', top: 'calc(var(--topbar-h) + 16px)' }}>
        <div className="card card-pad stack" style={{ gap: 14 }}>
          <div>
            <div className="eyebrow">Time left to submit</div>
            <div className={`timer`} style={{ fontSize: 40, lineHeight: 1.1, color: urgent ? 'var(--err)' : 'var(--text)' }}>{formatClock(remaining)}</div>
            {eventState.paused && <span className="badge badge-warn" style={{ marginTop: 6 }}>Paused by organiser</span>}
          </div>
          {lockedIn ? (
            <Banner kind="ok"><b>Submitted.</b> You were #{submitted!.sequenceNo}. Sit tight — allocation runs when the timer reaches zero.</Banner>
          ) : closed ? (
            <Banner kind="warn">Submissions closed before you ranked. Your team is allocated automatically using the default order.</Banner>
          ) : (
            <>
              <button className="btn btn-primary btn-lg" onClick={() => setConfirm(true)} disabled={busy === 'submit' || order.length !== 5}>
                <Send size={16} /> Submit priorities
              </button>
              <p className="hint">Submissions are final. Submitting earlier means being processed earlier.</p>
            </>
          )}
        </div>
        <div className="card card-pad">
          <div className="eyebrow" style={{ marginBottom: 8 }}>How allocation works</div>
          <ol className="muted" style={{ fontSize: 12.5, paddingLeft: 18, display: 'grid', gap: 6 }}>
            <li>Each problem has limited room — you can't see how much.</li>
            <li>Teams are handled in submission order.</li>
            <li>You get your highest-ranked problem that still has room.</li>
          </ol>
        </div>
      </aside>

      {confirm && (
        <ConfirmModal
          title="Submit these priorities?"
          confirmLabel="Submit — final"
          busy={busy === 'submit'}
          onCancel={() => setConfirm(false)}
          onConfirm={submit}
          body={
            <ol style={{ paddingLeft: 18, display: 'grid', gap: 4, color: 'var(--text)' }}>
              {order.map(id => <li key={id}>{byId.get(id)?.title}</li>)}
            </ol>
          }
        />
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Allocation result                                                   */
/* ------------------------------------------------------------------ */
const AllocationView: React.FC<{ eventState: EventState; assignment: TeamAllocation | null }> = ({ eventState, assignment }) => {
  if (eventState.allocationError) {
    return <Banner kind="warn"><b>Allocation needs attention.</b> The organisers are resolving it — please wait. You'll move on automatically.</Banner>;
  }
  if (!assignment) {
    return (
      <div className="card"><Empty icon={<Loader2 size={30} className="spin" />} title="Allocating problems…" hint="Priorities are locked. Your team's problem appears here in a moment." /></div>
    );
  }
  return (
    <div className="card card-pad rise" style={{ textAlign: 'center', padding: '40px 20px' }}>
      <div className="eyebrow">Your team is assigned</div>
      <h2 style={{ fontSize: 30, margin: '10px 0 12px' }}>{assignment.title}</h2>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
        <DifficultyBadge difficulty={assignment.difficulty} weight={assignment.weight} />
        {assignment.priority_rank > 0
          ? <span className="badge badge-accent"><Target size={12} /> Your #{assignment.priority_rank} choice</span>
          : <span className="badge badge-warn">Assigned by organiser</span>}
      </div>
      <p className="muted" style={{ marginTop: 18 }}>The statement is revealed to your senior when coding starts.</p>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Coding monitor                                                      */
/* ------------------------------------------------------------------ */
const SENIOR_STATUS: Record<TeamStatus['seniorStatus'], { label: string; tone: string; hint: string }> = {
  WAITING: { label: 'Waiting', tone: 'badge', hint: 'Coding has not started yet.' },
  NOT_STARTED: { label: 'Not started', tone: 'badge-warn', hint: 'No code saved or submitted yet.' },
  CODING: { label: 'Coding', tone: 'badge-ok', hint: 'Your senior is actively editing.' },
  JUDGING: { label: 'Judging', tone: 'badge-info', hint: 'A submission is being evaluated.' },
  SUBMITTED: { label: 'Submitted', tone: 'badge-accent', hint: 'At least one submission made.' },
  OFFLINE: { label: 'Offline', tone: 'badge-err', hint: 'Your senior is not connected.' },
  FINISHED: { label: 'Finished', tone: 'badge', hint: 'The coding window closed.' }
};

const CodingMonitor: React.FC<{ eventState: EventState; remaining: number; assignment: TeamAllocation | null }> = ({ eventState, remaining, assignment }) => {
  const statusQ = useLoad(() => api.getTeamStatus(eventState.roundId), {
    interval: 5000, events: ['submission:status', 'score:update'], deps: [eventState.roundId, eventState.state]
  });
  const st = statusQ.data;
  const info = st ? SENIOR_STATUS[st.seniorStatus] : null;
  const [showStatement, setShowStatement] = useState(false);

  return (
    <div className="stack">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
        <div className="card stat">
          <span className="eyebrow">Assigned problem</span>
          <div style={{ fontSize: 18, fontWeight: 650 }}>{assignment?.title ?? '—'}</div>
          {assignment && <div><DifficultyBadge difficulty={assignment.difficulty} weight={assignment.weight} /></div>}
        </div>
        <div className="card stat">
          <span className="eyebrow">Time remaining</span>
          <div className="stat-value" style={{ color: remaining <= 60 && eventState.state === 'CODING' ? 'var(--err)' : undefined }}>
            {eventState.state === 'CODING' ? formatClock(remaining) : '00:00'}
          </div>
          {eventState.paused && <span className="badge badge-warn">Paused</span>}
        </div>
        <div className="card stat">
          <span className="eyebrow">Senior status</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {info ? <span className={`badge ${info.tone}`}><Radio size={11} className={st?.seniorStatus === 'CODING' ? 'dot-live' : ''} /> {info.label}</span> : <span className="skeleton" style={{ width: 90, height: 22 }} />}
          </div>
          <span className="stat-sub">{info?.hint}</span>
        </div>
        <div className="card stat">
          <span className="eyebrow">Submissions</span>
          <div className="stat-value">{st?.submissionCount ?? 0}</div>
          {st?.lastSubmission ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <StatusBadge status={st.lastSubmission.status} />
              <span className="stat-sub num">{st.lastSubmission.passed}/{st.lastSubmission.total} · {st.lastSubmission.score} pts · {timeAgo(st.lastSubmission.at)}</span>
            </div>
          ) : <span className="stat-sub">None yet</span>}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3><Eye size={16} style={{ color: 'var(--accent-text)' }} /> Observer view</h3>
          <button className="btn btn-sm" onClick={() => setShowStatement(s => !s)}>{showStatement ? 'Hide' : 'Show'} problem statement</button>
        </div>
        <div className="card-body">
          {!showStatement ? (
            <p className="muted" style={{ fontSize: 13 }}>
              You're watching — only your senior can edit and submit code. Use this time to help think through the problem out loud.
            </p>
          ) : assignment && !assignment.hidden ? (
            <div className="stack">
              <div className="prose">{assignment.statement}</div>
              {assignment.constraints && <div className="code-block">{assignment.constraints}</div>}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
                <div><div className="eyebrow" style={{ marginBottom: 4 }}>Sample input</div><div className="code-block">{assignment.sample_input}</div></div>
                <div><div className="eyebrow" style={{ marginBottom: 4 }}>Sample output</div><div className="code-block">{assignment.sample_output}</div></div>
              </div>
            </div>
          ) : <p className="muted">The statement is not available yet.</p>}
        </div>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */
export const FirstYearDashboard: React.FC<Props> = (props) => {
  const { user, eventState, remaining, scoreRefresh } = props;
  const stage = eventState.state;
  const roundId = eventState.roundId;

  const assignQ = useLoad(() => api.getAssignment(roundId), {
    enabled: stage === 'ALLOCATION' || stage === 'CODING' || stage === 'ROUND_ENDED' || stage === 'SCOREBOARD',
    deps: [roundId, stage], events: ['allocation:complete', 'coding:started'], interval: stage === 'ALLOCATION' ? 2500 : undefined
  });
  const boardQ = useLoad(() => api.getPublicLeaderboard(), {
    enabled: stage === 'SCOREBOARD' || stage === 'FINAL_LEADERBOARD', deps: [stage, scoreRefresh], events: ['leaderboard:changed']
  });
  const scoreQ = useLoad(() => api.getMyScore(), { deps: [scoreRefresh, stage] });

  // Celebrate a podium finish on the final board.
  const celebrated = useRef(false);
  useEffect(() => {
    if (stage !== 'FINAL_LEADERBOARD' || celebrated.current || !boardQ.data) return;
    const mine = boardQ.data.find(r => r.teamId === user.teamId);
    if (mine && mine.rank <= 3) {
      celebrated.current = true;
      confetti({ particleCount: 140, spread: 80, origin: { y: 0.3 } });
    }
  }, [stage, boardQ.data, user.teamId]);

  // Refresh on server-pushed allocation.
  useEffect(() => {
    const h = () => assignQ.reload();
    socket.on('allocation:complete', h);
    return () => { socket.off('allocation:complete', h); };
  }, [assignQ]);

  return (
    <div className="stack">
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div className="eyebrow">First-year · strategy desk</div>
          <h1 className="h-page">{user.teamName || `Team ${user.teamId}`} <span className="subtle num" style={{ fontSize: 14, fontWeight: 500 }}>{user.teamId}</span></h1>
        </div>
        <div style={{ display: 'flex', gap: 24 }}>
          <div><div className="eyebrow">Coding</div><div className="num" style={{ fontSize: 22, fontWeight: 700 }}>{scoreQ.data?.codingScore ?? 0}</div></div>
          <div><div className="eyebrow">Aptitude</div><div className="num" style={{ fontSize: 22, fontWeight: 700 }}>{scoreQ.data?.aptitudeScore ?? 0}</div></div>
          <div><div className="eyebrow">Total</div><div className="num" style={{ fontSize: 22, fontWeight: 700, color: 'var(--accent-text)' }}>{scoreQ.data?.totalScore ?? 0}</div></div>
        </div>
      </div>

      {stage === 'WAITING' && (
        <div className="card"><Empty icon={<Hourglass size={32} />} title={`Round ${eventState.roundNumber} hasn't started`} hint="Stay on this screen. The five problems are revealed the moment the organiser opens priority selection." /></div>
      )}

      {stage === 'PRIORITY_SELECTION' && <PrioritySelection {...props} />}

      {stage === 'ALLOCATION' && <AllocationView eventState={eventState} assignment={assignQ.data ?? null} />}

      {(stage === 'CODING' || stage === 'ROUND_ENDED') && (
        <>
          {stage === 'ROUND_ENDED' && <Banner kind="info" icon={<Clock size={17} />}><b>Time's up.</b> Final submissions are being judged. The scoreboard is published by the organisers.</Banner>}
          <CodingMonitor eventState={eventState} remaining={remaining} assignment={assignQ.data ?? null} />
        </>
      )}

      {(stage === 'SCOREBOARD' || stage === 'FINAL_LEADERBOARD') && (
        <div className="card">
          <div className="card-head">
            <h3><Trophy size={17} style={{ color: 'var(--warn)' }} /> {stage === 'FINAL_LEADERBOARD' ? 'Final leaderboard' : `Round ${eventState.roundNumber} scoreboard`}</h3>
            {stage === 'FINAL_LEADERBOARD' && <span className="badge badge-ok"><Sparkles size={12} /> Official results</span>}
          </div>
          <Leaderboard rows={boardQ.data ?? []} myTeamId={user.teamId} />
        </div>
      )}

      {stage === 'CODING' && <div className="subtle" style={{ fontSize: 12 }}><CheckCircle2 size={12} style={{ verticalAlign: -2 }} /> Timer is controlled by the server.</div>}
    </div>
  );
};

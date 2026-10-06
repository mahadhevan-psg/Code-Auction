import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import {
  AlertTriangle, Check, CheckCircle2, Clock, CloudOff, Copy, FileCode2, Hourglass, Loader2, Lock,
  Play, RotateCcw, Save, Send, Terminal, Trophy, XCircle, Target, Timer, Cpu
} from 'lucide-react';
import { api, ApiError } from '../services/api';
import { socket } from '../socket/socket';
import { useLoad } from '../hooks/useLoad';
import { useProctor } from '../hooks/useProctor';
import { THEME_DARK, THEME_LIGHT } from '../monaco';
import { Banner, DifficultyBadge, Empty, StatusBadge, Tabs, formatClock, timeOnly, useToast } from '../components/ui';
import { Leaderboard } from '../components/Leaderboard';
import type { EventState, SampleRun, Submission, TeamAllocation, UserSession } from '../types';

type Lang = 'python' | 'cpp' | 'javascript';

const STARTERS: Record<Lang, string> = {
  python: `import sys


def main():
    data = sys.stdin.read().split("\\n")
    # TODO: solve and print the answer


main()
`,
  cpp: `#include <bits/stdc++.h>
using namespace std;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    // TODO: read from stdin, print the answer to stdout
    return 0;
}
`,
  javascript: `const lines = require('fs').readFileSync(0, 'utf8').split('\\n');

// TODO: solve and console.log the answer
`
};

const LANG_LABEL: Record<Lang, string> = { python: 'Python 3', cpp: 'C++17', javascript: 'JavaScript' };
const monacoLang = (l: Lang) => (l === 'cpp' ? 'cpp' : l);
const AUTOSAVE_MS = 3000;

interface Props {
  user: UserSession;
  eventState: EventState;
  remaining: number;
  theme: 'dark' | 'light';
  /** A proctor gate (rules / fullscreen / lock) is currently covering the page. */
  blocked: boolean;
}

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'offline';

export const SeniorDashboard: React.FC<Props> = ({ user, eventState, remaining, theme, blocked }) => {
  const toast = useToast();
  const proctor = useProctor();
  const stage = eventState.state;
  const roundId = eventState.roundId;
  const coding = stage === 'CODING';

  /* ------------------------ assignment ------------------------ */
  const assignQ = useLoad(() => api.getAssignment(roundId), {
    enabled: stage === 'ALLOCATION' || stage === 'CODING' || stage === 'ROUND_ENDED',
    deps: [roundId, stage], events: ['allocation:complete', 'coding:started'],
    interval: stage === 'ALLOCATION' ? 2500 : undefined
  });
  const assignment: TeamAllocation | null = assignQ.data ?? null;
  const statementShown = !!assignment && !assignment.hidden;

  const boardQ = useLoad(() => api.getPublicLeaderboard(), {
    enabled: stage === 'SCOREBOARD' || stage === 'FINAL_LEADERBOARD', deps: [stage], events: ['leaderboard:changed']
  });

  /* ------------------------ editor state ------------------------ */
  const [lang, setLang] = useState<Lang>('python');
  const [code, setCode] = useState(STARTERS.python);
  const buffers = useRef<Record<Lang, string>>({ ...STARTERS });
  const codeRef = useRef(code);
  const langRef = useRef(lang);
  codeRef.current = code;
  langRef.current = lang;
  const suppressInsertUntil = useRef(0);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const restoredFor = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const readOnly = !coding || blocked || proctor.locked;

  const applyProgrammatic = (value: string) => {
    suppressInsertUntil.current = Date.now() + 1000;
    setCode(value);
  };

  /* restore the team's saved code (also on re-login / refresh) */
  useEffect(() => {
    if (!assignment || assignment.hidden) return;
    const key = `${roundId}:${assignment.problem_id}`;
    if (restoredFor.current === key) return;
    restoredFor.current = key;
    api.getAutosavedCode(roundId, assignment.problem_id).then(saved => {
      if (saved?.source_code) {
        const l = (['python', 'cpp', 'javascript'].includes(saved.language) ? saved.language : 'python') as Lang;
        buffers.current[l] = saved.source_code;
        setLang(l);
        applyProgrammatic(saved.source_code);
        setSavedAt(saved.updated_at);
        setSaveState('saved');
      }
    }).catch(() => {});
  }, [assignment?.problem_id, assignment?.hidden, roundId]); // eslint-disable-line react-hooks/exhaustive-deps

  /* autosave */
  const save = useCallback(async () => {
    if (!assignment || assignment.hidden || !coding) return;
    setSaveState('saving');
    try {
      const r = await api.autosaveCode(roundId, assignment.problem_id, codeRef.current, langRef.current);
      setSavedAt(r.savedAt);
      setSaveState('saved');
    } catch (e) {
      // 409 = window closed; nothing to retry. Anything else: keep trying.
      if (e instanceof ApiError && e.status === 409) setSaveState('idle');
      else setSaveState('offline');
    }
  }, [assignment, coding, roundId]);

  const scheduleSave = useCallback(() => {
    setSaveState(s => (s === 'offline' ? s : 'dirty'));
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(save, AUTOSAVE_MS);
  }, [save]);

  // Retry while offline; flush when the tab is hidden or closing so nothing is lost.
  useEffect(() => {
    if (saveState !== 'offline') return;
    const id = setInterval(save, 5000);
    return () => clearInterval(id);
  }, [saveState, save]);

  useEffect(() => {
    if (!assignment || assignment.hidden || !coding) return;
    const flush = () => {
      if (saveState !== 'dirty' && saveState !== 'offline') return;
      try {
        const body = new Blob([JSON.stringify({ roundId, problemId: assignment.problem_id, sourceCode: codeRef.current, language: langRef.current })], { type: 'application/json' });
        // the session cookie authenticates the beacon
        navigator.sendBeacon('/api/code/autosave', body);
      } catch { /* ignore */ }
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [assignment, coding, roundId, saveState]);

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  const onCodeChange = (value: string | undefined) => {
    const v = value ?? '';
    setCode(v);
    buffers.current[langRef.current] = v;
    // Programmatic replacements (restore / language switch) schedule their own save.
    if (Date.now() >= suppressInsertUntil.current) scheduleSave();
  };

  const switchLang = (next: Lang) => {
    if (next === lang) return;
    buffers.current[lang] = code;
    setLang(next);
    applyProgrammatic(buffers.current[next]);
    scheduleSave();
  };

  const [confirmReset, setConfirmReset] = useState(false);
  const resetTemplate = () => {
    buffers.current[lang] = STARTERS[lang];
    applyProgrammatic(STARTERS[lang]);
    scheduleSave();
    setConfirmReset(false);
  };

  /* ------------------------ editor mount / proctor hooks ------------------------ */
  const proctorRef = useRef(proctor);
  proctorRef.current = proctor;
  const onMount: OnMount = (editor) => {
    editor.onDidChangeModelContent(e => {
      if (e.isUndoing || e.isRedoing || e.isFlush) return;
      if (Date.now() < suppressInsertUntil.current) return;
      const biggest = Math.max(0, ...e.changes.map(c => c.text.length));
      if (biggest > 160 && !proctorRef.current.recentAllowedPaste()) {
        proctorRef.current.report('LARGE_INSERT', { length: biggest });
      }
    });
  };

  /* ------------------------ submissions ------------------------ */
  const subsQ = useLoad(() => api.getMySubmissions(roundId), {
    enabled: stage === 'CODING' || stage === 'ROUND_ENDED', deps: [roundId, stage], events: ['submission:status']
  });
  const submissions: Submission[] = subsQ.data ?? [];
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = submissions.find(s => s.submission_id === activeId) ?? submissions[0] ?? null;

  // Live verdict updates pushed by the judge.
  useEffect(() => {
    const h = (s: Submission) => {
      subsQ.setData(prev => {
        const list = prev ? [...prev] : [];
        const i = list.findIndex(x => x.submission_id === s.submission_id);
        if (i >= 0) list[i] = s; else list.unshift(s);
        return list;
      });
    };
    socket.on('submission:status', h);
    return () => { socket.off('submission:status', h); };
  }, [subsQ]);

  // Fallback polling while something is still being judged (socket may have dropped).
  const judging = submissions.some(s => s.status === 'Pending' || s.status === 'Judging');
  useEffect(() => {
    if (!judging) return;
    const id = setInterval(() => subsQ.reload(), 2500);
    return () => clearInterval(id);
  }, [judging, subsQ]);

  const [submitting, setSubmitting] = useState(false);
  const submit = async () => {
    if (!assignment) return;
    if (!code.trim()) { toast('warn', 'Write some code first.'); return; }
    setSubmitting(true);
    try {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      await save();
      const s = await api.submitCode(roundId, assignment.problem_id, code, lang);
      setActiveId(s.submission_id);
      setSide('result');
      subsQ.setData(prev => [s, ...(prev ?? []).filter(x => x.submission_id !== s.submission_id)]);
      toast('info', 'Submitted — judging…', 2500);
    } catch (e: any) {
      toast('err', e.message);
    } finally { setSubmitting(false); }
  };

  /* ------------------------ run samples ------------------------ */
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<SampleRun | null>(null);
  const [customInput, setCustomInput] = useState('');
  const [side, setSide] = useState<'result' | 'samples' | 'custom'>('result');

  const run = async () => {
    if (!assignment) return;
    setRunning(true);
    try {
      const r = await api.runSamples(roundId, assignment.problem_id, code, lang, customInput || undefined);
      setRunResult(r);
      setSide(customInput && !r.samples.length ? 'custom' : 'samples');
    } catch (e: any) {
      toast('err', e.message);
    } finally { setRunning(false); }
  };

  /* ------------------------ copy helpers ------------------------ */
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (key: string, text: string) => {
    proctor.allowClipboardText(text); // public sample data may be pasted into the editor
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  const [leftTab, setLeftTab] = useState<'problem' | 'history'>('problem');
  const monacoTheme = theme === 'dark' ? THEME_DARK : THEME_LIGHT;
  const urgent = coding && remaining <= 60;

  const saveLabel = useMemo(() => {
    switch (saveState) {
      case 'saving': return { icon: <Loader2 size={13} className="spin" />, text: 'Saving…', color: 'var(--text-3)' };
      case 'saved': return { icon: <CheckCircle2 size={13} />, text: `Saved ${savedAt ? timeOnly(savedAt) : ''}`, color: 'var(--ok)' };
      case 'dirty': return { icon: <Save size={13} />, text: 'Unsaved changes', color: 'var(--warn)' };
      case 'offline': return { icon: <CloudOff size={13} />, text: 'Offline — retrying', color: 'var(--err)' };
      default: return { icon: <Save size={13} />, text: 'Autosave on', color: 'var(--text-3)' };
    }
  }, [saveState, savedAt]);

  /* ======================== render ======================== */

  if (stage === 'WAITING' || stage === 'PRIORITY_SELECTION') {
    return (
      <div className="card rise" style={{ maxWidth: 640, margin: '40px auto', padding: '44px 28px', textAlign: 'center' }}>
        <div style={{ width: 64, height: 64, margin: '0 auto 18px', borderRadius: 18, background: 'var(--accent-soft)', color: 'var(--accent-text)', display: 'grid', placeItems: 'center' }}>
          <Hourglass size={28} />
        </div>
        <h2 style={{ fontSize: 22 }}>{stage === 'WAITING' ? `Round ${eventState.roundNumber} hasn't started` : 'First-years are choosing your problem'}</h2>
        <p className="muted" style={{ marginTop: 10, maxWidth: 440, marginInline: 'auto' }}>
          {stage === 'WAITING'
            ? 'Keep this tab open. The round begins when the organiser opens priority selection.'
            : <>First-year members are selecting your team's problem. You will receive the problem once allocation is complete.</>}
        </p>
        {stage === 'PRIORITY_SELECTION' && (
          <div style={{ marginTop: 20 }}><span className="badge badge-info"><Timer size={12} /> <span className="num">{formatClock(remaining)}</span> left</span></div>
        )}
      </div>
    );
  }

  if (stage === 'SCOREBOARD' || stage === 'FINAL_LEADERBOARD') {
    return (
      <div className="card">
        <div className="card-head"><h3><Trophy size={17} style={{ color: 'var(--warn)' }} /> {stage === 'FINAL_LEADERBOARD' ? 'Final leaderboard' : `Round ${eventState.roundNumber} scoreboard`}</h3></div>
        <Leaderboard rows={boardQ.data ?? []} myTeamId={user.teamId} />
      </div>
    );
  }

  if (!assignment) {
    return (
      <div className="card">
        {eventState.allocationError
          ? <Empty icon={<AlertTriangle size={30} />} title="Allocation needs attention" hint="The organisers are resolving this. You'll move on automatically." />
          : <Empty icon={<Loader2 size={30} className="spin" />} title="Waiting for your allocation…" hint="Priorities are locked and problems are being assigned." />}
      </div>
    );
  }

  if (stage === 'ALLOCATION') {
    return (
      <div className="card card-pad rise" style={{ maxWidth: 640, margin: '40px auto', textAlign: 'center', padding: '44px 28px' }}>
        <div className="eyebrow">Allocation complete</div>
        <h2 style={{ fontSize: 28, margin: '10px 0 12px' }}>{assignment.title}</h2>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
          <DifficultyBadge difficulty={assignment.difficulty} weight={assignment.weight} />
          {assignment.priority_rank > 0 && <span className="badge badge-accent"><Target size={12} /> Your #{assignment.priority_rank} choice</span>}
        </div>
        <p className="muted" style={{ marginTop: 18 }}>The full statement and the editor unlock the moment the coding timer starts.</p>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 12 }}>
      {stage === 'ROUND_ENDED' && <Banner kind="info" icon={<Clock size={17} />}><b>Time's up.</b> The editor is locked. Your last submissions are still being judged.</Banner>}
      {proctor.locked && <Banner kind="err" icon={<Lock size={17} />}>Your team is locked by a proctor. Your code is safe.</Banner>}

      <div className="ide">
        {/* ============ LEFT: problem + history ============ */}
        <section className="card ide-pane">
          <div className="card-head" style={{ padding: '10px 14px' }}>
            <Tabs value={leftTab} onChange={v => setLeftTab(v as 'problem' | 'history')} items={[
              { id: 'problem', label: 'Problem', icon: <FileCode2 size={14} /> },
              { id: 'history', label: 'Submissions', count: submissions.length }
            ]} />
          </div>
          <div className="ide-scroll" style={{ padding: 20 }}>
            {leftTab === 'problem' ? (
              statementShown ? (
                <div className="stack" style={{ gap: 18 }}>
                  <div>
                    <h2 style={{ fontSize: 21 }}>{assignment.title}</h2>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                      <DifficultyBadge difficulty={assignment.difficulty} weight={assignment.weight} />
                      <span className="badge badge-outline"><Timer size={11} /> {(assignment.time_limit_ms ?? 3000) / 1000}s</span>
                      <span className="badge badge-outline"><Cpu size={11} /> {assignment.memory_limit_mb ?? 256} MB</span>
                    </div>
                  </div>
                  <div className="prose">{assignment.statement}</div>
                  {assignment.constraints && (
                    <div><div className="eyebrow" style={{ marginBottom: 6 }}>Constraints</div><div className="code-block">{assignment.constraints}</div></div>
                  )}
                  {([['in', 'Sample input', assignment.sample_input], ['out', 'Sample output', assignment.sample_output]] as const).map(([k, label, text]) => (
                    <div key={k}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <span className="eyebrow">{label}</span>
                        <button className="btn btn-ghost btn-sm" onClick={() => copy(k, text)}>{copied === k ? <Check size={13} /> : <Copy size={13} />}{copied === k ? 'Copied' : 'Copy'}</button>
                      </div>
                      <div className="code-block">{text}</div>
                    </div>
                  ))}
                  <p className="hint">Hidden test cases are used when you submit. Your score is passed tests × {assignment.weight}.</p>
                </div>
              ) : <Empty icon={<Loader2 size={24} className="spin" />} title="Loading statement…" />
            ) : submissions.length === 0 ? (
              <Empty icon={<Send size={26} />} title="No submissions yet" hint="Submit to see per-test verdicts and your score." />
            ) : (
              <div className="stack" style={{ gap: 8 }}>
                {submissions.map(s => (
                  <button key={s.submission_id} onClick={() => { setActiveId(s.submission_id); setSide('result'); }}
                    className="card-flat" style={{ textAlign: 'left', padding: '10px 12px', borderColor: active?.submission_id === s.submission_id ? 'var(--accent)' : undefined, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <div><StatusBadge status={s.status} /><div className="subtle" style={{ fontSize: 11.5, marginTop: 4 }}>{timeOnly(s.submitted_at)} · {LANG_LABEL[s.language as Lang] ?? s.language}</div></div>
                    <div className="num" style={{ textAlign: 'right', fontSize: 12.5 }}>
                      <div>{s.passed_count}/{s.total_cases}</div>
                      <div style={{ color: 'var(--accent-text)', fontWeight: 700 }}>{s.score} pts</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* ============ RIGHT: editor + console ============ */}
        <section className="ide-pane" style={{ gap: 12 }}>
          <div className="card" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
            <div className="card-head" style={{ padding: '8px 12px', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <select className="select select-sm" style={{ width: 140 }} value={lang} onChange={e => switchLang(e.target.value as Lang)} disabled={readOnly} aria-label="Language">
                  {(Object.keys(LANG_LABEL) as Lang[]).map(l => <option key={l} value={l}>{LANG_LABEL[l]}</option>)}
                </select>
                <button className="btn btn-sm btn-ghost" onClick={() => setConfirmReset(true)} disabled={readOnly} title="Reset to template"><RotateCcw size={14} /><span className="hide-sm">Reset</span></button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: saveLabel.color }}>{saveLabel.icon}{saveLabel.text}</span>
                <span className={`timer-chip timer ${urgent ? 'urgent' : ''}`} style={{ height: 30, fontSize: 15, padding: '0 10px' }}><Timer size={14} />{coding ? formatClock(remaining) : '00:00'}</span>
              </div>
            </div>

            <div data-editor className="ide-editor" style={{ flex: 1, minHeight: 0, position: 'relative' }}>
              <Editor
                height="100%"
                language={monacoLang(lang)}
                theme={monacoTheme}
                value={code}
                onChange={onCodeChange}
                onMount={onMount}
                loading={<div className="empty"><Loader2 className="spin" /></div>}
                options={{
                  readOnly,
                  fontSize: 14,
                  fontFamily: "'JetBrains Mono Variable', ui-monospace, Consolas, monospace",
                  fontLigatures: false,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  padding: { top: 12, bottom: 12 },
                  tabSize: 4,
                  contextmenu: false,
                  dragAndDrop: false,
                  dropIntoEditor: { enabled: false },
                  links: false,
                  renderLineHighlight: 'line',
                  smoothScrolling: true,
                  cursorSmoothCaretAnimation: 'on',
                  bracketPairColorization: { enabled: true }
                }}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '10px 12px', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
              <span className="hint">{readOnly ? 'Editor locked.' : <>Samples only on <b>Run</b>. <b>Submit</b> judges against all tests.</>}</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn" onClick={run} disabled={readOnly || running || !proctor.policy.allowRun || submitting} title={proctor.policy.allowRun ? 'Run against sample tests' : 'Running is disabled for this event'}>
                  {running ? <Loader2 size={15} className="spin" /> : <Play size={15} />} Run
                </button>
                <button className="btn btn-primary" onClick={submit} disabled={readOnly || submitting || running}>
                  {submitting ? <Loader2 size={15} className="spin" /> : <Send size={15} />} Submit
                </button>
              </div>
            </div>
          </div>

          {/* ---- console ---- */}
          <div className="card" style={{ height: 250, display: 'flex', flexDirection: 'column', flex: 'none' }}>
            <div className="card-head" style={{ padding: '8px 12px' }}>
              <Tabs value={side} onChange={v => setSide(v as typeof side)} items={[
                { id: 'result', label: 'Result', icon: <Trophy size={13} /> },
                { id: 'samples', label: 'Samples', icon: <Terminal size={13} /> },
                { id: 'custom', label: 'Custom input' }
              ]} />
              {active && side === 'result' && <span className="num" style={{ fontSize: 12.5 }}><b style={{ color: 'var(--accent-text)' }}>{active.score}</b> pts</span>}
            </div>
            <div className="ide-scroll" style={{ padding: 14 }}>
              {side === 'result' && <ResultPanel sub={active} />}
              {side === 'samples' && <SamplesPanel run={runResult} />}
              {side === 'custom' && (
                <div className="stack" style={{ gap: 10 }}>
                  <textarea className="textarea mono" data-allow-paste rows={4} placeholder="Type or paste custom stdin, then press Run…" value={customInput} onChange={e => setCustomInput(e.target.value)} style={{ fontSize: 13 }} />
                  {runResult?.custom && (
                    <div>
                      <div className="eyebrow" style={{ marginBottom: 4 }}>Output {runResult.custom.timedOut && <span className="badge badge-warn">timed out</span>} <span className="num subtle">{runResult.custom.timeMs} ms</span></div>
                      <div className="code-block">{runResult.custom.stdout || '(empty)'}</div>
                      {runResult.custom.stderr && <div className="code-block" style={{ marginTop: 6, color: 'var(--err)' }}>{runResult.custom.stderr}</div>}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>
      </div>

      {confirmReset && (
        <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) setConfirmReset(false); }}>
          <div className="modal">
            <div className="modal-head"><h3>Reset to template?</h3></div>
            <div className="modal-body muted">Your current {LANG_LABEL[lang]} code will be replaced by the starter template.</div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setConfirmReset(false)}>Cancel</button>
              <button className="btn btn-danger" onClick={resetTemplate}>Reset code</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Console panels                                                      */
/* ------------------------------------------------------------------ */
const VERDICT_TEXT = { AC: 'Passed', WA: 'Wrong answer', TLE: 'Time limit', RE: 'Runtime error' } as const;

const ResultPanel: React.FC<{ sub: Submission | null }> = ({ sub }) => {
  if (!sub) return <Empty icon={<Send size={24} />} title="No submission yet" hint="Submit your solution to see the verdict here." />;
  const pending = sub.status === 'Pending' || sub.status === 'Judging';
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {sub.status === 'Accepted' ? <CheckCircle2 size={20} style={{ color: 'var(--ok)' }} />
            : pending ? <Loader2 size={20} className="spin" style={{ color: 'var(--info)' }} />
            : <XCircle size={20} style={{ color: 'var(--err)' }} />}
          <span style={{ fontWeight: 700, fontSize: 16 }}>{sub.status === 'Accepted' ? 'Accepted' : sub.status}</span>
        </div>
        <span className="num muted" style={{ fontSize: 13 }}>{sub.passed_count} / {sub.total_cases} tests passed</span>
      </div>

      {pending && (
        <p className="muted" style={{ fontSize: 13 }}>
          {sub.attempts && sub.attempts > 0 ? 'The judge is temporarily unavailable. Your submission is saved and will be judged automatically.' : 'Judging your solution…'}
        </p>
      )}

      {sub.results && sub.results.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {sub.results.map(r => (
            <span key={r.index} className={`case-pill ${r.verdict.toLowerCase()}`} title={`${VERDICT_TEXT[r.verdict]} · ${r.timeMs} ms${r.hidden ? ' · hidden test' : ''}`}>
              {r.verdict === 'AC' ? <Check size={12} /> : <XCircle size={12} />}
              #{r.index}{r.hidden && <Lock size={10} style={{ opacity: .7 }} />}
              <span style={{ opacity: .7 }}>{r.timeMs}ms</span>
            </span>
          ))}
        </div>
      )}

      {!pending && sub.compiler_output && sub.status !== 'Accepted' && (
        <div className="code-block" style={{ color: sub.status === 'Compile Error' || sub.status === 'Runtime Error' ? 'var(--err)' : 'var(--text)', whiteSpace: 'pre-wrap' }}>{sub.compiler_output}</div>
      )}
      {sub.status === 'Accepted' && <p className="muted" style={{ fontSize: 13 }}>All tests passed. You can keep improving — only your best submission counts.</p>}
    </div>
  );
};

const SamplesPanel: React.FC<{ run: SampleRun | null }> = ({ run }) => {
  if (!run) return <Empty icon={<Play size={24} />} title="Run your code" hint="Press Run to test against the public sample cases." />;
  if (run.compileError) return <div className="code-block" style={{ color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{run.compileError}</div>;
  if (!run.samples.length) return <p className="muted">This problem has no public samples.</p>;
  return (
    <div className="stack" style={{ gap: 12 }}>
      {run.samples.map(s => (
        <div key={s.index} className="card-flat" style={{ padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span className={`case-pill ${s.verdict.toLowerCase()}`}>{s.verdict === 'AC' ? <Check size={12} /> : <XCircle size={12} />} Sample #{s.index} · {VERDICT_TEXT[s.verdict]}</span>
            <span className="num subtle" style={{ fontSize: 12 }}>{s.timeMs} ms</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
            <div><div className="eyebrow">Input</div><div className="code-block">{s.input}</div></div>
            <div><div className="eyebrow">Expected</div><div className="code-block">{s.expected}</div></div>
            <div><div className="eyebrow">Your output</div><div className="code-block" style={{ color: s.verdict === 'AC' ? 'var(--ok)' : 'var(--err)' }}>{s.actual || '(empty)'}</div></div>
          </div>
          {s.stderr && <div className="code-block" style={{ marginTop: 8, color: 'var(--err)', whiteSpace: 'pre-wrap' }}>{s.stderr}</div>}
        </div>
      ))}
    </div>
  );
};

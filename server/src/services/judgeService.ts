import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { db, audit, uid } from '../db/database.js';
import { Realtime } from './realtime.js';
import { ScoringService } from './scoringService.js';

/**
 * Local process judge.
 *
 * NOTE: this runs submissions as ordinary child processes with a wall-clock limit, an output cap
 * and a scrubbed environment. It is NOT a security sandbox. For an event with untrusted code run
 * it on an isolated machine or swap `executeCase`/`compile` for Judge0 (same interface).
 */

export const SUPPORTED_LANGUAGES = ['python', 'cpp', 'javascript'] as const;
export type Language = typeof SUPPORTED_LANGUAGES[number];

export type Verdict = 'AC' | 'WA' | 'TLE' | 'RE';
export type SubmissionStatus =
  | 'Pending' | 'Judging' | 'Accepted' | 'Wrong Answer'
  | 'Time Limit Exceeded' | 'Compile Error' | 'Runtime Error';

export interface CaseResult {
  index: number;
  verdict: Verdict;
  timeMs: number;
  hidden: boolean;
}

export const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const COMPILE_TIMEOUT_MS = 20_000;
const MAX_JUDGE_ATTEMPTS = 40;
const JUDGE_CONCURRENCY = Math.max(1, Number(process.env.JUDGE_CONCURRENCY) || 2);

class JudgeUnavailableError extends Error {}

interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  overflow: boolean;
  timeMs: number;
}

function pythonBin() {
  return process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
}

function sandboxEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'LANG'];
  const env: NodeJS.ProcessEnv = { PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return env;
}

function killTree(pid: number | undefined) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    else process.kill(pid, 'SIGKILL');
  } catch { /* already gone */ }
}

function runProcess(cmd: string, args: string[], opts: { cwd: string; input?: string; timeoutMs: number }): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: sandboxEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e: any) {
      return reject(new JudgeUnavailableError(`Cannot start '${cmd}': ${e.message}`));
    }

    let stdout = '';
    let stderr = '';
    let size = 0;
    let timedOut = false;
    let overflow = false;
    let settled = false;

    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, opts.timeoutMs);

    const collect = (which: 'out' | 'err') => (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        if (!overflow) { overflow = true; killTree(child.pid); }
        return;
      }
      if (which === 'out') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
    };
    child.stdout.on('data', collect('out'));
    child.stderr.on('data', collect('err'));

    child.stdin.on('error', () => { /* program exited before reading all input */ });
    child.stdin.end(opts.input ?? '');

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === 'ENOENT') reject(new JudgeUnavailableError(`'${cmd}' is not installed on the judge machine.`));
      else reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, overflow, timeMs: Date.now() - started });
    });
  });
}

function normalizeOutput(s: string): string {
  const lines = s.replace(/\r\n/g, '\n').split('\n').map(l => l.trimEnd());
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

function scrub(text: string, dir: string): string {
  return text.split(dir).join('.').replace(/\\/g, '/').slice(0, 2000);
}

/* ---------------- tiny semaphore so the event loop and CPU stay healthy ---------------- */
let running = 0;
const waiters: Array<() => void> = [];
async function acquire() {
  if (running < JUDGE_CONCURRENCY) { running++; return; }
  await new Promise<void>(res => waiters.push(res));
  running++;
}
function release() {
  running--;
  waiters.shift()?.();
}

interface PreparedProgram {
  dir: string;
  run: (input: string, timeoutMs: number) => Promise<ProcResult>;
  cleanup: () => void;
}

async function prepare(language: Language, source: string, limits: { memoryMb: number }): Promise<{ program?: PreparedProgram; compileError?: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge_'));
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };

  try {
    if (language === 'python') {
      fs.writeFileSync(path.join(dir, 'solution.py'), source);
      return { program: { dir, cleanup, run: (input, t) => runProcess(pythonBin(), ['solution.py'], { cwd: dir, input, timeoutMs: t }) } };
    }
    if (language === 'javascript') {
      fs.writeFileSync(path.join(dir, 'solution.js'), source);
      const args = [`--max-old-space-size=${Math.max(64, limits.memoryMb)}`, 'solution.js'];
      return { program: { dir, cleanup, run: (input, t) => runProcess(process.execPath, args, { cwd: dir, input, timeoutMs: t }) } };
    }
    // C++17
    fs.writeFileSync(path.join(dir, 'solution.cpp'), source);
    const bin = process.platform === 'win32' ? 'solution.exe' : 'solution';
    const compile = await runProcess('g++', ['-std=c++17', '-O2', 'solution.cpp', '-o', bin], { cwd: dir, timeoutMs: COMPILE_TIMEOUT_MS });
    if (compile.timedOut) { cleanup(); return { compileError: 'Compilation timed out.' }; }
    if (compile.code !== 0) {
      const msg = scrub(compile.stderr || 'Compilation failed.', dir);
      cleanup();
      return { compileError: msg };
    }
    const exe = process.platform === 'win32' ? path.join(dir, bin) : `./${bin}`;
    return { program: { dir, cleanup, run: (input, t) => runProcess(exe, [], { cwd: dir, input, timeoutMs: t }) } };
  } catch (err) {
    cleanup();
    throw err;
  }
}

function toVerdict(res: ProcResult, expected: string): Verdict {
  if (res.timedOut) return 'TLE';
  if (res.overflow || res.code !== 0) return 'RE';
  return normalizeOutput(res.stdout) === normalizeOutput(expected) ? 'AC' : 'WA';
}

const STATUS_BY_VERDICT: Record<Exclude<Verdict, 'AC'>, SubmissionStatus> = {
  WA: 'Wrong Answer', TLE: 'Time Limit Exceeded', RE: 'Runtime Error'
};

export class JudgeService {
  private static queue: string[] = [];
  private static queued = new Set<string>();
  private static active = 0;

  /* ============================ submissions ============================ */

  static submitCode(teamId: string, roundId: number, problemId: string, sourceCode: string, language: string, windowEndsAt: number | null) {
    const lang = String(language).toLowerCase() as Language;
    if (!SUPPORTED_LANGUAGES.includes(lang)) throw new Error(`Unsupported language '${language}'.`);
    if (typeof sourceCode !== 'string' || !sourceCode.trim()) throw new Error('Source code is empty.');
    if (Buffer.byteLength(sourceCode, 'utf8') > MAX_SOURCE_BYTES) throw new Error(`Source code is too large (limit ${MAX_SOURCE_BYTES / 1024} KB).`);

    const round = db.prepare('SELECT state FROM rounds WHERE round_id = ?').get(roundId) as { state: string } | undefined;
    if (!round || round.state !== 'CODING' || (windowEndsAt !== null && Date.now() > windowEndsAt)) {
      throw new Error('The coding window is closed. Submissions are no longer accepted.');
    }

    const alloc = db.prepare('SELECT problem_id FROM allocations WHERE team_id = ? AND round_id = ?').get(teamId, roundId) as { problem_id: string } | undefined;
    if (!alloc || alloc.problem_id !== problemId) {
      throw new Error('Your team is not allocated to this problem.');
    }

    const total = (db.prepare('SELECT COUNT(*) AS c FROM problem_test_cases WHERE problem_id = ?').get(problemId) as any).c as number;
    if (!total) throw new Error('This problem has no test cases configured. Tell an administrator.');

    const submissionId = uid('sub');
    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO submissions (submission_id, team_id, round_id, problem_id, source_code, language, status, passed_count, total_cases, score, submitted_at)
      VALUES (?, ?, ?, ?, ?, ?, 'Pending', 0, ?, 0, ?)
    `).run(submissionId, teamId, roundId, problemId, sourceCode, lang, total, nowIso);
    audit(teamId, 'CODE_SUBMISSION', submissionId, { problemId, language: lang, bytes: sourceCode.length });

    this.enqueue(submissionId);
    return this.publicSubmission(submissionId)!;
  }

  static enqueue(submissionId: string) {
    if (this.queued.has(submissionId)) return;
    this.queued.add(submissionId);
    this.queue.push(submissionId);
    this.pump();
  }

  /** Called on boot so anything left Pending/Judging by a restart is judged. */
  static resumePending() {
    const rows = db.prepare("SELECT submission_id FROM submissions WHERE status IN ('Pending','Judging') ORDER BY submitted_at ASC").all() as any[];
    for (const r of rows) this.enqueue(r.submission_id);
    if (rows.length) console.log(`[Judge] Re-queued ${rows.length} unfinished submission(s).`);
  }

  private static pump() {
    while (this.active < JUDGE_CONCURRENCY && this.queue.length) {
      const id = this.queue.shift()!;
      this.queued.delete(id);
      this.active++;
      this.judge(id)
        .catch(err => console.error('[Judge] fatal', err))
        .finally(() => { this.active--; this.pump(); });
    }
  }

  private static async judge(submissionId: string) {
    const sub = db.prepare('SELECT * FROM submissions WHERE submission_id = ?').get(submissionId) as any;
    if (!sub) return;

    db.prepare("UPDATE submissions SET status = 'Judging' WHERE submission_id = ?").run(submissionId);
    this.emitStatus(submissionId);

    const problem = db.prepare('SELECT weight, time_limit_ms, memory_limit_mb FROM problems WHERE problem_id = ?').get(sub.problem_id) as any;
    const tests = db.prepare('SELECT input, expected_output, hidden FROM problem_test_cases WHERE problem_id = ? ORDER BY hidden ASC, rowid ASC')
      .all(sub.problem_id) as Array<{ input: string; expected_output: string; hidden: number }>;

    let program: PreparedProgram | undefined;
    await acquire();
    try {
      const prep = await prepare(sub.language, sub.source_code, { memoryMb: problem?.memory_limit_mb ?? 256 });
      if (prep.compileError !== undefined) {
        this.finish(submissionId, sub, { status: 'Compile Error', passed: 0, total: tests.length, output: prep.compileError, cases: [], weight: problem?.weight ?? 1 });
        return;
      }
      program = prep.program!;

      const cases: CaseResult[] = [];
      let firstFail: { verdict: Exclude<Verdict, 'AC'>; stderr: string; index: number } | null = null;
      let passed = 0;

      for (let i = 0; i < tests.length; i++) {
        const tc = tests[i];
        const res = await program.run(tc.input, problem?.time_limit_ms ?? 3000);
        const verdict = toVerdict(res, tc.expected_output);
        cases.push({ index: i + 1, verdict, timeMs: res.timeMs, hidden: Boolean(tc.hidden) });
        if (verdict === 'AC') passed++;
        else if (!firstFail) firstFail = { verdict, stderr: scrub(res.stderr, program.dir), index: i + 1 };
      }

      let status: SubmissionStatus = 'Accepted';
      let output = 'All test cases passed.';
      if (firstFail) {
        status = STATUS_BY_VERDICT[firstFail.verdict];
        output = firstFail.verdict === 'RE' && firstFail.stderr ? firstFail.stderr
          : firstFail.verdict === 'TLE' ? `Time limit exceeded on test ${firstFail.index} (limit ${problem?.time_limit_ms ?? 3000} ms).`
          : `${status} on test ${firstFail.index}.`;
      }
      this.finish(submissionId, sub, { status, passed, total: tests.length, output, cases, weight: problem?.weight ?? 1 });
    } catch (err: any) {
      if (err instanceof JudgeUnavailableError) {
        this.markUnavailable(submissionId, err.message);
      } else {
        console.error('[Judge] unexpected error', err);
        this.markUnavailable(submissionId, 'Internal judge error. Your submission is saved and will be retried.');
      }
    } finally {
      program?.cleanup();
      release();
    }
  }

  private static finish(
    submissionId: string,
    sub: any,
    r: { status: SubmissionStatus; passed: number; total: number; output: string; cases: CaseResult[]; weight: number }
  ) {
    const score = r.passed * r.weight;
    db.prepare(`
      UPDATE submissions SET status = ?, passed_count = ?, total_cases = ?, score = ?, compiler_output = ?, test_results = ?, judged_at = ?
      WHERE submission_id = ?
    `).run(r.status, r.passed, r.total, score, r.output, JSON.stringify(r.cases), new Date().toISOString(), submissionId);
    audit('JUDGE', 'JUDGE_RESULT', submissionId, { status: r.status, passed: r.passed, total: r.total, score });

    ScoringService.recalculate(sub.team_id, sub.round_id);
    this.emitStatus(submissionId);
  }

  /** Judge/runtime missing: keep the submission, show it as pending, and retry shortly. */
  private static markUnavailable(submissionId: string, reason: string) {
    const row = db.prepare('SELECT attempts FROM submissions WHERE submission_id = ?').get(submissionId) as any;
    const attempts = (row?.attempts ?? 0) + 1;
    db.prepare("UPDATE submissions SET status = 'Pending', attempts = ?, compiler_output = ? WHERE submission_id = ?")
      .run(attempts, 'The judge is temporarily unavailable. Your submission is saved and will be judged automatically.', submissionId);
    audit('JUDGE', 'JUDGE_UNAVAILABLE', submissionId, { attempts, reason });
    Realtime.emitAdmin('admin:alert', { level: 'error', message: `Judge unavailable: ${reason}`, submissionId });
    this.emitStatus(submissionId);

    if (attempts < MAX_JUDGE_ATTEMPTS) {
      setTimeout(() => this.enqueue(submissionId), 10_000).unref();
    }
  }

  private static emitStatus(submissionId: string) {
    const pub = this.publicSubmission(submissionId);
    if (!pub) return;
    Realtime.emitTeam(pub.team_id, 'submission:status', pub);
    Realtime.emitAdmin('submission:status', pub);
  }

  static rejudge(submissionId: string, actor: string) {
    const sub = db.prepare('SELECT submission_id FROM submissions WHERE submission_id = ?').get(submissionId);
    if (!sub) throw new Error('Submission not found.');
    db.prepare("UPDATE submissions SET status = 'Pending', attempts = 0 WHERE submission_id = ?").run(submissionId);
    audit(actor, 'REJUDGE', submissionId);
    this.enqueue(submissionId);
  }

  /* ============================ sample runs ============================ */

  /** "Run" button: public sample tests only (plus optional custom stdin). Never touches hidden data. */
  static async runSamples(problemId: string, sourceCode: string, language: string, customInput?: string) {
    const lang = String(language).toLowerCase() as Language;
    if (!SUPPORTED_LANGUAGES.includes(lang)) throw new Error(`Unsupported language '${language}'.`);
    if (Buffer.byteLength(sourceCode, 'utf8') > MAX_SOURCE_BYTES) throw new Error('Source code is too large.');

    const problem = db.prepare('SELECT time_limit_ms, memory_limit_mb FROM problems WHERE problem_id = ?').get(problemId) as any;
    if (!problem) throw new Error('Problem not found.');
    const samples = db.prepare('SELECT input, expected_output FROM problem_test_cases WHERE problem_id = ? AND hidden = 0 ORDER BY rowid ASC')
      .all(problemId) as Array<{ input: string; expected_output: string }>;

    await acquire();
    let program: PreparedProgram | undefined;
    try {
      const prep = await prepare(lang, sourceCode, { memoryMb: problem.memory_limit_mb });
      if (prep.compileError !== undefined) return { compileError: prep.compileError, samples: [], custom: null };
      program = prep.program!;

      const results = [];
      for (let i = 0; i < samples.length; i++) {
        const res = await program.run(samples[i].input, problem.time_limit_ms);
        results.push({
          index: i + 1,
          verdict: toVerdict(res, samples[i].expected_output),
          timeMs: res.timeMs,
          input: samples[i].input,
          expected: samples[i].expected_output,
          actual: res.stdout.slice(0, 4000),
          stderr: scrub(res.stderr, program.dir).slice(0, 1500)
        });
      }

      let custom = null as null | { stdout: string; stderr: string; timeMs: number; timedOut: boolean };
      if (typeof customInput === 'string' && customInput.length) {
        const res = await program.run(customInput.slice(0, 20_000), problem.time_limit_ms);
        custom = { stdout: res.stdout.slice(0, 4000), stderr: scrub(res.stderr, program.dir), timeMs: res.timeMs, timedOut: res.timedOut };
      }
      return { compileError: null, samples: results, custom };
    } catch (err) {
      if (err instanceof JudgeUnavailableError) throw new Error('The judge is temporarily unavailable. Try again shortly.');
      throw err;
    } finally {
      program?.cleanup();
      release();
    }
  }

  /* ============================ queries ============================ */

  /** What a participant is allowed to see: no source from others, no hidden expected output. */
  static publicSubmission(submissionId: string) {
    const s = db.prepare(`
      SELECT submission_id, team_id, round_id, problem_id, language, status, passed_count, total_cases, score,
             submitted_at, compiler_output, test_results, attempts
      FROM submissions WHERE submission_id = ?
    `).get(submissionId) as any;
    return s ? this.shape(s) : null;
  }

  private static shape(s: any) {
    let results: CaseResult[] = [];
    try { results = s.test_results ? JSON.parse(s.test_results) : []; } catch { results = []; }
    const { test_results, ...rest } = s;
    return { ...rest, results };
  }

  static getTeamSubmissions(teamId: string, roundId: number) {
    const rows = db.prepare(`
      SELECT submission_id, team_id, round_id, problem_id, language, status, passed_count, total_cases, score,
             submitted_at, compiler_output, test_results, attempts
      FROM submissions WHERE team_id = ? AND round_id = ? ORDER BY submitted_at DESC
    `).all(teamId, roundId) as any[];
    return rows.map(r => this.shape(r));
  }

  /** Status-only view for the first-year monitor: no code, no output. */
  static teamActivity(teamId: string, roundId: number) {
    const last = db.prepare(`
      SELECT status, passed_count, total_cases, score, submitted_at FROM submissions
      WHERE team_id = ? AND round_id = ? ORDER BY submitted_at DESC LIMIT 1
    `).get(teamId, roundId) as any;
    const count = (db.prepare('SELECT COUNT(*) AS c FROM submissions WHERE team_id = ? AND round_id = ?').get(teamId, roundId) as any).c as number;
    const save = db.prepare('SELECT updated_at FROM code_autosaves WHERE team_id = ? AND round_id = ? ORDER BY updated_at DESC LIMIT 1').get(teamId, roundId) as any;
    return { submissionCount: count, lastSubmission: last ?? null, lastActivityAt: save?.updated_at ?? null };
  }

  static getAllSubmissions(filter: { teamId?: string; roundId?: number } = {}, limit = 300) {
    const where: string[] = [];
    const params: any[] = [];
    if (filter.teamId) { where.push('s.team_id = ?'); params.push(filter.teamId); }
    if (filter.roundId) { where.push('s.round_id = ?'); params.push(filter.roundId); }
    return db.prepare(`
      SELECT s.submission_id, s.team_id, t.team_name, s.round_id, s.problem_id, s.language, s.status,
             s.passed_count, s.total_cases, s.score, s.submitted_at, s.attempts
      FROM submissions s JOIN teams t ON s.team_id = t.team_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY s.submitted_at DESC LIMIT ?
    `).all(...params, limit);
  }

  static getSubmissionForAdmin(submissionId: string) {
    const s = db.prepare('SELECT * FROM submissions WHERE submission_id = ?').get(submissionId) as any;
    return s ? this.shape(s) : null;
  }
}

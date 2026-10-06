import { DatabaseSync } from 'node:sqlite';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

const dbDir = process.env.DB_DIR
  ? path.resolve(process.env.DB_DIR)
  : path.resolve(__dirname, '../../../database');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, 'code_auction.db');
export const db = new DatabaseSync(dbPath);

// WAL + foreign keys for speed and reliability
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

/* ------------------------------------------------------------------ */
/* Small helpers shared across services                               */
/* ------------------------------------------------------------------ */

export function uid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function audit(actor: string, action: string, target: string, metadata?: unknown) {
  db.prepare('INSERT INTO audit_logs (log_id, actor, action, target, timestamp, metadata) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uid('log'), actor, action, target, new Date().toISOString(), metadata === undefined ? null : JSON.stringify(metadata));
}

let txDepth = 0;

/** Run `fn` inside a transaction; rolls back on throw. Nested calls join the outer transaction. */
export function transaction<T>(fn: () => T): T {
  if (txDepth > 0) return fn();
  db.exec('BEGIN IMMEDIATE;');
  txDepth++;
  try {
    const out = fn();
    db.exec('COMMIT;');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    txDepth--;
  }
}

export function getSetting<T>(key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try { return JSON.parse(row.value) as T; } catch { return fallback; }
}

export function setSetting(key: string, value: unknown) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, JSON.stringify(value));
}

function hasColumn(table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some(c => c.name === column);
}

function addColumn(table: string, column: string, definition: string) {
  if (!hasColumn(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

/* ------------------------------------------------------------------ */
/* Schema                                                             */
/* ------------------------------------------------------------------ */

export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      team_id TEXT PRIMARY KEY,
      team_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      aptitude_score REAL NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS rounds (
      round_id INTEGER PRIMARY KEY,
      round_number INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'WAITING',
      start_time DATETIME,
      end_time DATETIME,
      priority_duration_seconds INTEGER NOT NULL DEFAULT 120,
      coding_duration_seconds INTEGER NOT NULL DEFAULT 600,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS problems (
      problem_id TEXT PRIMARY KEY,
      round_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      difficulty TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      capacity INTEGER NOT NULL DEFAULT 0,
      remaining_capacity INTEGER NOT NULL DEFAULT 0,
      statement TEXT NOT NULL,
      constraints TEXT NOT NULL,
      sample_input TEXT NOT NULL,
      sample_output TEXT NOT NULL,
      FOREIGN KEY (round_id) REFERENCES rounds(round_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS problem_test_cases (
      test_case_id TEXT PRIMARY KEY,
      problem_id TEXT NOT NULL,
      input TEXT NOT NULL,
      expected_output TEXT NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (problem_id) REFERENCES problems(problem_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS priorities (
      priority_id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      round_id INTEGER NOT NULL,
      rank1 TEXT NOT NULL,
      rank2 TEXT NOT NULL,
      rank3 TEXT NOT NULL,
      rank4 TEXT NOT NULL,
      rank5 TEXT NOT NULL,
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      sequence_no INTEGER NOT NULL,
      FOREIGN KEY (team_id) REFERENCES teams(team_id) ON DELETE CASCADE,
      FOREIGN KEY (round_id) REFERENCES rounds(round_id) ON DELETE CASCADE,
      UNIQUE(team_id, round_id)
    );

    CREATE TABLE IF NOT EXISTS allocations (
      allocation_id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      round_id INTEGER NOT NULL,
      problem_id TEXT NOT NULL,
      priority_rank INTEGER NOT NULL,
      allocated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      is_override INTEGER DEFAULT 0,
      FOREIGN KEY (team_id) REFERENCES teams(team_id) ON DELETE CASCADE,
      FOREIGN KEY (round_id) REFERENCES rounds(round_id) ON DELETE CASCADE,
      FOREIGN KEY (problem_id) REFERENCES problems(problem_id) ON DELETE CASCADE,
      UNIQUE(team_id, round_id)
    );

    CREATE TABLE IF NOT EXISTS submissions (
      submission_id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      round_id INTEGER NOT NULL,
      problem_id TEXT NOT NULL,
      source_code TEXT NOT NULL,
      language TEXT NOT NULL,
      status TEXT NOT NULL,
      passed_count INTEGER NOT NULL DEFAULT 0,
      total_cases INTEGER NOT NULL DEFAULT 0,
      score REAL NOT NULL DEFAULT 0,
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      compiler_output TEXT,
      FOREIGN KEY (team_id) REFERENCES teams(team_id) ON DELETE CASCADE,
      FOREIGN KEY (round_id) REFERENCES rounds(round_id) ON DELETE CASCADE,
      FOREIGN KEY (problem_id) REFERENCES problems(problem_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
      ip_address TEXT
    );

    CREATE TABLE IF NOT EXISTS login_requests (
      request_id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      role TEXT NOT NULL,
      requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      status TEXT NOT NULL DEFAULT 'PENDING',
      session_id TEXT
    );

    CREATE TABLE IF NOT EXISTS temporary_credentials (
      credential_id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      role TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      issued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      used_at DATETIME,
      revoked_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS scores (
      score_id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      round_id INTEGER NOT NULL,
      coding_score REAL NOT NULL DEFAULT 0,
      aptitude_score REAL NOT NULL DEFAULT 0,
      total_score REAL NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (team_id) REFERENCES teams(team_id) ON DELETE CASCADE,
      UNIQUE(team_id, round_id)
    );

    CREATE TABLE IF NOT EXISTS violations (
      violation_id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      role TEXT NOT NULL,
      type TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      log_id TEXT PRIMARY KEY,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS code_autosaves (
      team_id TEXT NOT NULL,
      round_id INTEGER NOT NULL,
      problem_id TEXT NOT NULL,
      source_code TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'python',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (team_id, round_id, problem_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS score_adjustments (
      adjustment_id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      delta REAL NOT NULL,
      reason TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (team_id) REFERENCES teams(team_id) ON DELETE CASCADE
    );
  `);

  /* ---- additive migrations (safe on an existing database) ---- */
  addColumn('teams', 'locked', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('teams', 'lock_reason', 'TEXT');

  addColumn('rounds', 'phase_ends_at', 'INTEGER');
  addColumn('rounds', 'paused_remaining', 'INTEGER');

  addColumn('problems', 'status', "TEXT NOT NULL DEFAULT 'PUBLISHED'");
  addColumn('problems', 'time_limit_ms', 'INTEGER NOT NULL DEFAULT 3000');
  addColumn('problems', 'memory_limit_mb', 'INTEGER NOT NULL DEFAULT 256');

  addColumn('submissions', 'test_results', 'TEXT');
  addColumn('submissions', 'judged_at', 'TEXT');
  addColumn('submissions', 'attempts', 'INTEGER NOT NULL DEFAULT 0');

  addColumn('sessions', 'rules_ack_at', 'TEXT');
  addColumn('sessions', 'last_heartbeat', 'TEXT');
  addColumn('sessions', 'fullscreen', 'INTEGER');
  addColumn('sessions', 'focused', 'INTEGER');

  addColumn('violations', 'severity', "TEXT NOT NULL DEFAULT 'LOW'");
  addColumn('violations', 'reviewed', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('violations', 'review_note', 'TEXT');
  addColumn('violations', 'session_id', 'TEXT');
  addColumn('violations', 'round_id', 'INTEGER');

  addColumn('login_requests', 'session_id', 'TEXT');
  addColumn('login_requests', 'credential_id', 'TEXT');

  addColumn('scores', 'raw_passed', 'INTEGER NOT NULL DEFAULT 0');

  // Older databases stored the plaintext code. Wipe it and drop the column when possible.
  if (hasColumn('temporary_credentials', 'plaintext_code')) {
    db.exec("UPDATE temporary_credentials SET plaintext_code = 'REDACTED';");
    try {
      db.exec('ALTER TABLE temporary_credentials DROP COLUMN plaintext_code;');
    } catch {
      // keep column (it's redacted); inserts below handle the NOT NULL case
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_team ON sessions(team_id, role, expires_at);
    CREATE INDEX IF NOT EXISTS idx_submissions_team ON submissions(team_id, round_id);
    CREATE INDEX IF NOT EXISTS idx_violations_team ON violations(team_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(timestamp);
  `);

  seedDefaultData();
}

export function credentialsHasLegacyPlaintext(): boolean {
  return hasColumn('temporary_credentials', 'plaintext_code');
}

/* ------------------------------------------------------------------ */
/* Seed data                                                          */
/* ------------------------------------------------------------------ */

function seedDefaultData() {
  const countRow = db.prepare('SELECT COUNT(*) as cnt FROM teams').get() as { cnt: number };
  if (countRow.cnt > 0) return;

  console.log('Seeding initial database data...');

  const teamNames = [
    'Byte Busters', 'Algo Aces', 'Binary Bosses', 'Code Crusaders', 'Dynamic Programmers',
    'Logic Legends', 'Null Pointers', 'Stack Overflow', 'Cyber Knights', 'Syntax Samurai',
    'Bit Ninjas', 'Matrix Masters', 'Quantum Coders', 'Turbo Turtles', 'Dev Titans',
    'Infinite Loops', 'Hash Harvester', 'Recursion Rebels', 'Bug Hunters', 'Terminal Velocity',
    'P-NP Solvers', 'Graph Gurus', 'Data Mavericks', 'Cloud Commanders', 'Shadow Coders',
    'Vector Wizards', 'Apex Engineers', 'Pixel Pioneers', 'Echo Hackers', 'Neural Netters',
    'Zenith Hackers', 'Omni Programmers'
  ];

  const insertTeam = db.prepare('INSERT INTO teams (team_id, team_name, aptitude_score) VALUES (?, ?, ?)');
  teamNames.forEach((name, idx) => {
    const teamId = `T${String(idx + 1).padStart(2, '0')}`;
    insertTeam.run(teamId, name, Math.floor(Math.random() * 20) + 10);
  });

  const insertRound = db.prepare('INSERT INTO rounds (round_id, round_number, state, priority_duration_seconds, coding_duration_seconds) VALUES (?, ?, ?, ?, ?)');
  insertRound.run(1, 1, 'WAITING', 180, 600);   // 3 min priority, 10 min coding
  insertRound.run(2, 2, 'WAITING', 180, 1800);  // 3 min priority, 30 min coding

  const insertProblem = db.prepare(`
    INSERT INTO problems (problem_id, round_id, title, difficulty, weight, capacity, remaining_capacity, statement, constraints, sample_input, sample_output, status)
    VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 'PUBLISHED')
  `);
  const insertTC = db.prepare('INSERT INTO problem_test_cases (test_case_id, problem_id, input, expected_output, hidden) VALUES (?, ?, ?, ?, ?)');

  const r1 = [
    ['R1_P1', 'Two Sum Problem', 'Easy', 1.0,
      'Given an array of integers `nums` and an integer `target`, print the indices of the two numbers such that they add up to `target`.\nInput: line 1 has space-separated numbers, line 2 has the target.',
      '2 <= nums.length <= 10^4\n-10^9 <= nums[i] <= 10^9', '2 7 11 15\n9', '0 1'],
    ['R1_P2', 'Palindrome Number Check', 'Easy', 1.0,
      'Given an integer `x`, print `true` if `x` is a palindrome, and `false` otherwise.',
      '-2^31 <= x <= 2^31 - 1', '121', 'true'],
    ['R1_P3', 'Reverse Words in a String', 'Medium', 2.0,
      'Given an input string `s`, reverse the order of the words. A word is a sequence of non-space characters.',
      '1 <= s.length <= 10^4', 'the sky is blue', 'blue is sky the'],
    ['R1_P4', 'Longest Substring Without Repeating Characters', 'Medium', 2.0,
      'Given a string `s`, print the length of the longest substring without repeating characters.',
      '0 <= s.length <= 5 * 10^4', 'abcabcbb', '3'],
    ['R1_P5', 'Median of Two Sorted Arrays', 'Hard', 3.0,
      'Given two sorted arrays `nums1` and `nums2`, print the median of the two sorted arrays.\nLine 1: space separated nums1\nLine 2: space separated nums2',
      'nums1.length == m, nums2.length == n', '1 3\n2', '2.0']
  ];
  r1.forEach(p => insertProblem.run(p[0] as string, 1, p[1] as string, p[2] as string, p[3] as number, p[4] as string, p[5] as string, p[6] as string, p[7] as string));

  insertTC.run('tc_r1p1_1', 'R1_P1', '2 7 11 15\n9', '0 1', 0);
  insertTC.run('tc_r1p1_2', 'R1_P1', '3 2 4\n6', '1 2', 1);
  insertTC.run('tc_r1p1_3', 'R1_P1', '3 3\n6', '0 1', 1);
  insertTC.run('tc_r1p2_1', 'R1_P2', '121', 'true', 0);
  insertTC.run('tc_r1p2_2', 'R1_P2', '-121', 'false', 1);
  insertTC.run('tc_r1p2_3', 'R1_P2', '10', 'false', 1);
  insertTC.run('tc_r1p2_4', 'R1_P2', '12321', 'true', 1);
  insertTC.run('tc_r1p3_1', 'R1_P3', 'the sky is blue', 'blue is sky the', 0);
  insertTC.run('tc_r1p3_2', 'R1_P3', 'hello world', 'world hello', 1);
  insertTC.run('tc_r1p3_3', 'R1_P3', 'a good example', 'example good a', 1);
  insertTC.run('tc_r1p4_1', 'R1_P4', 'abcabcbb', '3', 0);
  insertTC.run('tc_r1p4_2', 'R1_P4', 'bbbbb', '1', 1);
  insertTC.run('tc_r1p4_3', 'R1_P4', 'pwwkew', '3', 1);
  insertTC.run('tc_r1p5_1', 'R1_P5', '1 3\n2', '2.0', 0);
  insertTC.run('tc_r1p5_2', 'R1_P5', '1 2\n3 4', '2.5', 1);

  const r2 = [
    ['R2_P1', 'Valid Parentheses Matching', 'Easy', 1.5,
      'Given a string `s` containing just `(`, `)`, `{`, `}`, `[` and `]`, determine if the input string is valid. Print `true` or `false`.',
      '1 <= s.length <= 10^4', '()[]{}', 'true'],
    ['R2_P2', 'Container With Most Water', 'Medium', 2.0,
      'Given `n` non-negative integers representing heights where each point is `(i, height[i])`, find two lines that together with the x-axis form a container holding the most water. Print the max area.',
      'n == height.length, 2 <= n <= 10^5', '1 8 6 2 5 4 8 3 7', '49'],
    ['R2_P3', '3Sum Zero Triplets', 'Medium', 2.5,
      'Given an integer array `nums`, print the count of unique triplets `[nums[i], nums[j], nums[k]]` such that their sum is 0.',
      '3 <= nums.length <= 3000', '-1 0 1 2 -1 -4', '2'],
    ['R2_P4', 'Merge k Sorted Lists Count', 'Hard', 3.5,
      'You are given `k` sorted lists, one per line. Print the total element count of the sorted merged result.',
      'k == lists.length', '1 4 5\n1 3 4\n2 6', '8'],
    ['R2_P5', 'Trapping Rain Water Total', 'Hard', 4.0,
      'Given `n` non-negative integers representing an elevation map where each bar has width 1, print how much water it can trap after raining.',
      'n == height.length', '0 1 0 2 1 0 1 3 2 1 2 1', '6']
  ];
  r2.forEach(p => insertProblem.run(p[0] as string, 2, p[1] as string, p[2] as string, p[3] as number, p[4] as string, p[5] as string, p[6] as string, p[7] as string));

  insertTC.run('tc_r2p1_1', 'R2_P1', '()[]{}', 'true', 0);
  insertTC.run('tc_r2p1_2', 'R2_P1', '(]', 'false', 1);
  insertTC.run('tc_r2p1_3', 'R2_P1', '([{}])', 'true', 1);
  insertTC.run('tc_r2p2_1', 'R2_P2', '1 8 6 2 5 4 8 3 7', '49', 0);
  insertTC.run('tc_r2p2_2', 'R2_P2', '1 1', '1', 1);
  insertTC.run('tc_r2p3_1', 'R2_P3', '-1 0 1 2 -1 -4', '2', 0);
  insertTC.run('tc_r2p3_2', 'R2_P3', '0 1 1', '0', 1);
  insertTC.run('tc_r2p4_1', 'R2_P4', '1 4 5\n1 3 4\n2 6', '8', 0);
  insertTC.run('tc_r2p4_2', 'R2_P4', '1\n2\n3', '3', 1);
  insertTC.run('tc_r2p5_1', 'R2_P5', '0 1 0 2 1 0 1 3 2 1 2 1', '6', 0);
  insertTC.run('tc_r2p5_2', 'R2_P5', '4 2 0 3 2 5', '9', 1);

  console.log('Database seeded successfully!');
}

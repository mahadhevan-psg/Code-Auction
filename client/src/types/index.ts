export type UserRole = 'FIRST_YEAR' | 'SENIOR' | 'ADMIN';
export type ParticipantRole = 'FIRST_YEAR' | 'SENIOR';

export interface UserSession {
  sessionId: string;
  teamId: string;
  role: UserRole;
  teamName?: string | null;
  rulesAcked?: boolean;
  locked?: boolean;
  lockReason?: string | null;
}

export type EventStage =
  | 'WAITING' | 'PRIORITY_SELECTION' | 'ALLOCATION' | 'CODING'
  | 'ROUND_ENDED' | 'SCOREBOARD' | 'FINAL_LEADERBOARD';

export interface EventState {
  roundId: number;
  roundNumber: number;
  totalRounds: number;
  state: EventStage;
  remainingSeconds: number;
  paused: boolean;
  priorityDuration: number;
  codingDuration: number;
  phaseEndsAt: number | null;
  serverNow: number;
  allocationError: string | null;
}

export type Difficulty = 'Easy' | 'Medium' | 'Hard';

export interface Problem {
  problem_id: string;
  round_id: number;
  title: string;
  difficulty: Difficulty;
  weight: number;
  statement: string;
  constraints: string;
  sample_input: string;
  sample_output: string;
  time_limit_ms?: number;
  memory_limit_mb?: number;
}

export interface AdminProblem extends Problem {
  status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  capacity: number;
  test_case_count: number;
  allocated_count: number;
}

export interface TestCase {
  test_case_id: string;
  problem_id: string;
  input: string;
  expected_output: string;
  hidden: number;
}

export interface TeamAllocation extends Problem {
  allocation_id: string;
  team_id: string;
  priority_rank: number;
  allocated_at: string;
  is_override?: number;
  hidden?: boolean;
}

export type SubmissionStatus =
  | 'Pending' | 'Judging' | 'Accepted' | 'Wrong Answer'
  | 'Time Limit Exceeded' | 'Compile Error' | 'Runtime Error';

export interface CaseResult {
  index: number;
  verdict: 'AC' | 'WA' | 'TLE' | 'RE';
  timeMs: number;
  hidden: boolean;
}

export interface Submission {
  submission_id: string;
  team_id: string;
  team_name?: string;
  round_id: number;
  problem_id: string;
  language: string;
  status: SubmissionStatus;
  passed_count: number;
  total_cases: number;
  score: number;
  submitted_at: string;
  compiler_output?: string | null;
  results?: CaseResult[];
  attempts?: number;
  source_code?: string;
}

export interface SampleRun {
  compileError: string | null;
  samples: Array<{
    index: number; verdict: 'AC' | 'WA' | 'TLE' | 'RE'; timeMs: number;
    input: string; expected: string; actual: string; stderr: string;
  }>;
  custom: { stdout: string; stderr: string; timeMs: number; timedOut: boolean } | null;
}

export interface LoginRequest {
  request_id: string;
  team_id: string;
  team_name?: string;
  role: ParticipantRole;
  requested_at: string;
  status: 'PENDING' | 'ISSUED' | 'APPROVED' | 'USED' | 'EXPIRED' | 'REJECTED';
  expires_at?: string | null;
  session_id?: string | null;
  active_role_sessions?: number;
  active_team_sessions?: number;
}

export interface IssuedCredential {
  requestId: string;
  credentialId: string;
  teamId: string;
  role: ParticipantRole;
  password: string;
  expiresAt: string;
}

export interface CredentialRecord {
  credential_id: string;
  team_id: string;
  team_name?: string;
  role: ParticipantRole;
  issued_at: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  status: 'ISSUED' | 'USED' | 'EXPIRED' | 'REVOKED';
}

export interface ActiveSession {
  session_id: string;
  team_id: string;
  team_name: string;
  role: ParticipantRole;
  created_at: string;
  last_seen: string;
  ip_address: string;
  online: boolean;
  rules_ack_at: string | null;
  last_heartbeat: string | null;
  fullscreen: number | null;
  focused: number | null;
}

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH';

export interface Violation {
  violation_id: string;
  team_id: string;
  team_name?: string;
  role: ParticipantRole;
  type: string;
  label: string;
  severity: Severity;
  timestamp: string;
  metadata?: string;
  reviewed: number;
  review_note?: string | null;
}

export interface ViolationSummary {
  team_id: string;
  team_name: string;
  locked: number;
  lock_reason: string | null;
  total: number;
  high: number;
  medium: number;
  low: number;
  open_count: number;
  last_at: string | null;
}

export interface ProctorPolicy {
  requireFullscreen: boolean;
  blockClipboard: boolean;
  blockContextMenu: boolean;
  blockSelection: boolean;
  blockShortcuts: boolean;
  detectDevtools: boolean;
  requireAck: boolean;
  allowRun: boolean;
  warnAfter: number;
  autoLockThreshold: number;
  autoLogoutOnTabSwitch: boolean;
  autoLogoutOnBlur: boolean;
  idleTimeoutSeconds: number;
}

export interface EventConfig {
  maxSessionsFirstYear: number;
  maxSessionsSenior: number;
  passwordTtlMinutes: number;
  eventPin: string;
  submitCooldownSeconds: number;
}

export interface LeaderboardEntry {
  rank: number;
  teamId: string;
  teamName: string;
  round1Score: number;
  round2Score: number;
  aptitudeScore: number;
  adjustment: number;
  totalScore: number;
}

export interface SimilarityMatch {
  problemId: string;
  roundId: number;
  team1: string;
  team2: string;
  submission1: string;
  submission2: string;
  similarityPercentage: number;
  tokens1: number;
  tokens2: number;
}

export interface TeamStatus {
  seniorStatus: 'WAITING' | 'NOT_STARTED' | 'CODING' | 'JUDGING' | 'SUBMITTED' | 'OFFLINE' | 'FINISHED';
  seniorOnline: boolean;
  submissionCount: number;
  lastSubmission: { status: SubmissionStatus; passed: number; total: number; score: number; at: string } | null;
}

export interface TeamScore {
  teamId: string;
  round1Score: number;
  round2Score: number;
  codingScore: number;
  aptitudeScore: number;
  totalScore: number;
}

export interface AdminOverview {
  state: EventState;
  teams: { total: number; active: number; locked: number; online: number };
  sessions: { active: number; online: number };
  pendingRequests: number;
  priority: { submitted: number; total: number };
  allocation: { allocated: number; summary: Array<{ problem_id: string; title: string; difficulty: Difficulty; capacity: number; assigned: number }> };
  submissions: { total: number; pending: number; accepted: number };
  violations: { open: number; high: number };
}

export interface AdminTeam {
  team_id: string;
  team_name: string;
  status: 'ACTIVE' | 'WITHDRAWN';
  aptitude_score: number;
  locked: number;
  lock_reason: string | null;
  firstYearOnline: number;
  seniorOnline: number;
  notFullscreen: boolean;
  lastHeartbeat: string | null;
  prioritySeq: number | null;
  problemId: string | null;
  problemTitle: string | null;
  priorityRank: number | null;
  submissionCount: number;
  lastSubmission: { status: SubmissionStatus; passed: number; total: number; at: string } | null;
  openFlags: number;
  totalScore: number;
  rank: number | null;
}

export interface AllocationRow {
  team_id: string;
  team_name: string;
  sequence_no: number | null;
  submitted_at: string | null;
  rank1: string | null; rank2: string | null; rank3: string | null; rank4: string | null; rank5: string | null;
  problem_id: string | null;
  priority_rank: number | null;
  is_override: number | null;
  title: string | null;
}

export interface AuditLog {
  log_id: string;
  actor: string;
  action: string;
  target: string;
  timestamp: string;
  metadata: string | null;
}

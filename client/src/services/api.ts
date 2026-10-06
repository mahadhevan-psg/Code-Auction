import type {
  Problem, TeamAllocation, Submission, SampleRun, LoginRequest, CredentialRecord, ActiveSession,
  Violation, ViolationSummary, LeaderboardEntry, SimilarityMatch, ProctorPolicy, EventConfig, EventState,
  TeamStatus, TeamScore, AdminOverview, AdminTeam, AllocationRow, AdminProblem, TestCase, AuditLog,
  UserSession, ParticipantRole
} from '../types';

const API_BASE = '/api';

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function getSessionId(): string | null {
  try { return localStorage.getItem('sessionId'); } catch { return null; }
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const sessionId = getSessionId();
  const headers: Record<string, string> = { ...(options.headers as Record<string, string> || {}) };
  if (options.body) headers['Content-Type'] = 'application/json';
  if (sessionId) headers['x-session-id'] = sessionId;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers, credentials: 'include' });
  } catch {
    throw new ApiError('Cannot reach the server. Check your connection.', 0, 'NETWORK');
  }

  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON (e.g. CSV) */ }

  if (!res.ok) {
    if (res.status === 401 && sessionId && !endpoint.startsWith('/auth/login')) {
      window.dispatchEvent(new CustomEvent('auth:expired'));
    }
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data?.code);
  }
  return data as T;
}

const post = <T>(url: string, body?: unknown) =>
  request<T>(url, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  /* ---------- auth ---------- */
  getTeams: () => request<{ teams: Array<{ team_id: string; team_name: string }>; pinRequired: boolean }>('/auth/teams'),
  requestPassword: (teamId: string, role: ParticipantRole, pin?: string) =>
    post<{ request: { status: string; requestId: string; teamId: string; role: string; expiresAt: string | null } }>('/auth/request-password', { teamId, role, pin }),
  requestStatus: (requestId: string) =>
    request<{ status: 'NONE' | 'PENDING' | 'ISSUED' | 'APPROVED' | 'USED' | 'EXPIRED' | 'REJECTED'; requestId?: string; teamId?: string; role?: ParticipantRole; sessionId?: string; expiresAt?: string | null }>(`/auth/request-status?requestId=${encodeURIComponent(requestId)}`),
  login: (teamId: string, role: ParticipantRole, password: string) =>
    post<{ sessionId: string; teamId: string; role: ParticipantRole }>('/auth/login', { teamId, role, password }),
  loginAdmin: (password: string) =>
    post<{ sessionId: string; teamId: string; role: 'ADMIN' }>('/auth/login', { role: 'ADMIN', password }),
  logout: () => post<{ message: string }>('/auth/logout'),
  getMe: () => request<{ user: UserSession }>('/auth/me'),
  ackRules: () => post<{ ok: boolean }>('/auth/ack-rules'),

  /* ---------- rounds ---------- */
  getCurrentState: () => request<EventState>('/rounds/current'),
  getProblems: (roundId: number) => request<Problem[]>(`/rounds/${roundId}/problems`),
  submitPriorities: (roundId: number, rankings: string[]) => post<{ message: string; result: { sequenceNo: number; submittedAt: string } }>(`/rounds/${roundId}/priority`, { rankings }),
  getMyPriorities: (roundId: number) => request<{ rankings: string[]; sequenceNo: number; submittedAt: string } | null>(`/rounds/${roundId}/priority`),
  getAssignment: (roundId: number) => request<TeamAllocation | null>(`/rounds/${roundId}/assignment`),
  getTeamStatus: (roundId: number) => request<TeamStatus>(`/rounds/${roundId}/team-status`),
  getMyScore: () => request<TeamScore>('/rounds/my-score'),
  getPublicLeaderboard: () => request<LeaderboardEntry[]>('/rounds/leaderboard'),

  /* ---------- code ---------- */
  autosaveCode: (roundId: number, problemId: string, sourceCode: string, language: string) =>
    post<{ savedAt: string }>('/code/autosave', { roundId, problemId, sourceCode, language }),
  getAutosavedCode: (roundId: number, problemId: string) =>
    request<{ source_code: string; language: string; updated_at: string } | null>(`/code/autosave?roundId=${roundId}&problemId=${encodeURIComponent(problemId)}`),
  runSamples: (roundId: number, problemId: string, sourceCode: string, language: string, customInput?: string) =>
    post<SampleRun>('/code/run', { roundId, problemId, sourceCode, language, customInput }),
  submitCode: (roundId: number, problemId: string, sourceCode: string, language: string) =>
    post<Submission>('/submissions', { roundId, problemId, sourceCode, language }),
  getMySubmissions: (roundId: number) => request<Submission[]>(`/submissions/my?roundId=${roundId}`),

  /* ---------- proctoring ---------- */
  getPolicy: () => request<{ policy: ProctorPolicy; counts: { total: number; serious: number }; locked: boolean; lockReason: string | null; labels: Record<string, string> }>('/telemetry/policy'),
  reportViolation: (type: string, metadata: Record<string, unknown> = {}) =>
    post<{ ok: boolean; counts: { total: number; serious: number } }>('/telemetry/violation', { type, metadata }),

  /* ---------- admin ---------- */
  adminOverview: () => request<AdminOverview>('/admin/overview'),
  adminEvent: (action: string, body?: Record<string, unknown>) => post<{ state: EventState }>(`/admin/event/${action}`, body ?? {}),

  adminTeams: () => request<AdminTeam[]>('/admin/teams'),
  adminCreateTeam: (teamId: string, teamName: string) => post<{ message: string }>('/admin/teams', { teamId, teamName }),
  adminImportTeams: (csv: string) => post<{ created: number; skipped: string[] }>('/admin/teams/import', { csv }),
  adminUpdateTeam: (teamId: string, patch: { teamName?: string; status?: string }) =>
    request<{ message: string }>(`/admin/teams/${teamId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  adminLockTeam: (teamId: string, locked: boolean, reason?: string) => post<{ message: string }>(`/admin/teams/${teamId}/lock`, { locked, reason }),

  adminLoginRequests: () => request<LoginRequest[]>('/admin/login-requests'),
  adminApproveAccess: (requestId: string) => post<{ requestId: string; sessionId: string; teamId: string; role: ParticipantRole }>('/admin/approve-request', { requestId }),
  adminIssuePassword: (requestId: string) => post<{ requestId: string; sessionId: string; teamId: string; role: ParticipantRole }>('/admin/approve-request', { requestId }),
  adminRejectRequest: (requestId: string) => post<{ message: string }>('/admin/reject-request', { requestId }),
  adminCredentialHistory: () => request<CredentialRecord[]>('/admin/credential-history'),
  adminSessions: () => request<ActiveSession[]>('/admin/sessions'),
  adminRevokeSession: (sessionId: string) => post<{ message: string }>(`/admin/sessions/${sessionId}/revoke`),

  adminAllocations: (roundId: number) =>
    request<{ rows: AllocationRow[]; summary: AdminOverview['allocation']['summary'] }>(`/admin/rounds/${roundId}/allocations`),
  adminOverride: (roundId: number, teamId: string, newProblemId: string, reason: string) =>
    post<{ message: string }>(`/admin/rounds/${roundId}/override-allocation`, { teamId, newProblemId, reason }),

  adminProblems: () => request<AdminProblem[]>('/admin/problems'),
  adminTestCases: (problemId: string) => request<TestCase[]>(`/admin/problems/${problemId}/test-cases`),
  adminCreateProblem: (p: Partial<AdminProblem>) => post<{ problem_id: string }>('/admin/problems', p),
  adminUpdateProblem: (id: string, p: Record<string, unknown>) => request<{ message: string }>(`/admin/problems/${id}`, { method: 'PUT', body: JSON.stringify(p) }),
  adminValidateProblem: (id: string) => request<{ issues: string[] }>(`/admin/problems/${id}/validate`),
  adminPublishProblem: (id: string) => post<{ message: string }>(`/admin/problems/${id}/publish`),
  adminRetireProblem: (id: string, body?: Record<string, unknown>) => post<{ message: string }>(`/admin/problems/${id}/retire`, body ?? {}),
  adminDeleteProblem: (id: string) => request<{ message: string }>(`/admin/problems/${id}`, { method: 'DELETE' }),
  adminAddTestCase: (problemId: string, tc: Record<string, unknown>) => post<{ tcId: string }>(`/admin/problems/${problemId}/test-cases`, tc),
  adminUpdateTestCase: (tcId: string, tc: Record<string, unknown>) => request<{ message: string }>(`/admin/test-cases/${tcId}`, { method: 'PUT', body: JSON.stringify(tc) }),
  adminDeleteTestCase: (tcId: string, body?: Record<string, unknown>) =>
    request<{ message: string }>(`/admin/test-cases/${tcId}`, { method: 'DELETE', body: JSON.stringify(body ?? {}) }),

  adminSubmissions: (params: { teamId?: string; roundId?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.teamId) q.set('teamId', params.teamId);
    if (params.roundId) q.set('roundId', String(params.roundId));
    return request<Submission[]>(`/admin/submissions?${q}`);
  },
  adminSubmission: (id: string) => request<Submission>(`/admin/submissions/${id}`),
  adminRejudge: (id: string) => post<{ message: string }>(`/admin/submissions/${id}/rejudge`),

  adminViolations: (params: { teamId?: string; severity?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.teamId) q.set('teamId', params.teamId);
    if (params.severity) q.set('severity', params.severity);
    return request<Violation[]>(`/admin/violations?${q}`);
  },
  adminViolationSummary: () => request<ViolationSummary[]>('/admin/violations/summary'),
  adminReviewViolation: (id: string, reviewed: boolean, note?: string) => post<{ message: string }>(`/admin/violations/${id}/review`, { reviewed, note }),
  adminGetPolicy: () => request<{ policy: ProctorPolicy; config: EventConfig }>('/admin/policy'),
  adminSetPolicy: (policy: Partial<ProctorPolicy>, config?: Partial<EventConfig>) =>
    request<{ policy: ProctorPolicy; config: EventConfig }>('/admin/policy', { method: 'PUT', body: JSON.stringify({ policy, config }) }),
  adminSimilarity: (threshold: number) => request<SimilarityMatch[]>(`/admin/similarity-check?threshold=${threshold}`),

  adminLeaderboard: () => request<LeaderboardEntry[]>('/admin/leaderboard'),
  adminAdjustments: () => request<Array<{ adjustment_id: string; team_id: string; team_name: string; delta: number; reason: string; actor: string; created_at: string }>>('/admin/scores/adjustments'),
  adminAdjustScore: (teamId: string, delta: number, reason: string) => post<{ message: string }>('/admin/scores/adjust', { teamId, delta, reason }),
  adminUpdateAptitude: (teamId: string, aptitudeScore: number) => post<{ message: string }>('/admin/scores/update-aptitude', { teamId, aptitudeScore }),

  adminAuditLogs: (q = '', limit = 200) => request<AuditLog[]>(`/admin/audit-logs?limit=${limit}&q=${encodeURIComponent(q)}`),

  /** Downloads a CSV export through an authenticated fetch. */
  adminExport: async (kind: string) => {
    const res = await fetch(`${API_BASE}/admin/export/${kind}`, { headers: { 'x-session-id': getSessionId() || '' }, credentials: 'include' });
    if (!res.ok) throw new ApiError('Export failed.', res.status);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${kind}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
};

import { db } from '../db/database.js';

const KEYWORDS = new Set((
  // C / C++
  'auto break case char class const continue default do double else enum extern float for goto if inline int long namespace new operator private protected public return short signed sizeof static struct switch template this throw try typedef union unsigned using virtual void volatile while bool true false nullptr cin cout endl vector string map set unordered_map unordered_set pair sort min max ' +
  // Python
  'and as assert async await def del elif except finally from global import in is lambda nonlocal not or pass raise with yield None True False print input range len list dict tuple self ' +
  // JavaScript
  'function let var null undefined typeof instanceof of console log require readFileSync'
).split(/\s+/));

/** Strip comments, collapse strings/numbers and rename identifiers so trivial edits do not hide copying. */
export function normalizeTokens(code: string, language: string): string[] {
  let src = code;
  src = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  src = src.replace(/\/\/[^\n]*/g, ' ');
  if (language === 'python') src = src.replace(/#[^\n]*/g, ' ');
  else if (language === 'cpp') src = src.replace(/^\s*#[^\n]*/gm, ' ');
  src = src.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, ' STR ');

  const raw = src.match(/[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[^\sA-Za-z0-9_]/g) || [];
  return raw.map(t => {
    if (/^\d/.test(t)) return 'NUM';
    if (/^[A-Za-z_]/.test(t)) return t === 'STR' ? 'STR' : KEYWORDS.has(t) ? t : 'ID';
    return t;
  });
}

function shingles(tokens: string[], k: number): Set<string> {
  const out = new Set<string>();
  if (tokens.length < k) { out.add(tokens.join(' ')); return out; }
  for (let i = 0; i <= tokens.length - k; i++) out.add(tokens.slice(i, i + k).join(' '));
  return out;
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

export class SimilarityService {
  /**
   * Compares each team's best submission per problem. Teams solve different problems within a round,
   * so overlap is usually between the (few) teams that share an allocation — which is exactly where
   * copying would happen.
   */
  static analyze(threshold = 50): SimilarityMatch[] {
    const rows = db.prepare(`
      SELECT s.submission_id, s.team_id, s.round_id, s.problem_id, s.source_code, s.language, s.score, s.submitted_at
      FROM submissions s
      WHERE s.status NOT IN ('Pending','Judging','Compile Error')
      ORDER BY s.score DESC, s.submitted_at DESC
    `).all() as any[];

    // best per (team, problem)
    const best = new Map<string, any>();
    for (const r of rows) {
      const key = `${r.team_id}|${r.problem_id}`;
      if (!best.has(key)) best.set(key, r);
    }

    const byProblem = new Map<string, any[]>();
    for (const r of best.values()) {
      const list = byProblem.get(r.problem_id) ?? [];
      list.push({ ...r, tokens: normalizeTokens(r.source_code, r.language) });
      byProblem.set(r.problem_id, list);
    }

    const matches: SimilarityMatch[] = [];
    for (const [problemId, list] of byProblem) {
      const prepared = list
        .filter(x => x.tokens.length >= 15)
        .map(x => ({ ...x, set: shingles(x.tokens, 5) }));

      for (let i = 0; i < prepared.length; i++) {
        for (let j = i + 1; j < prepared.length; j++) {
          const a = prepared[i], b = prepared[j];
          let inter = 0;
          for (const g of a.set) if (b.set.has(g)) inter++;
          const union = a.set.size + b.set.size - inter;
          const jaccard = union === 0 ? 0 : inter / union;
          if (jaccard * 100 >= threshold) {
            matches.push({
              problemId,
              roundId: a.round_id,
              team1: a.team_id, team2: b.team_id,
              submission1: a.submission_id, submission2: b.submission_id,
              similarityPercentage: Math.round(jaccard * 1000) / 10,
              tokens1: a.tokens.length, tokens2: b.tokens.length
            });
          }
        }
      }
    }
    return matches.sort((x, y) => y.similarityPercentage - x.similarityPercentage);
  }
}

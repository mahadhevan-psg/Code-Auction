# Algorithm Auction / Code Clash

A proctored, two-round team coding contest. First-years rank five problems; the server allocates them
first-come-first-served within fair buckets; seniors solve the allocated problem in a browser IDE judged
against hidden tests. The browser is only a presentation layer — **the server owns event state, timers,
permissions, allocation, judging and scoring.**

```
client/   React + TypeScript + Vite, Monaco editor (bundled, works offline)
server/   Node 22+ · Express · Socket.IO · SQLite (node:sqlite)
database/ SQLite file (created and seeded on first run)
```

## Run it

Requires **Node 22 or newer** (uses the built-in `node:sqlite`). For judging you also need `python`
(Python 3), `g++` (C++17) and/or `node` on the machine that runs the server.

```bash
# 1. configure (do this before a real event)
cp server/.env.example server/.env        # then set ADMIN_PASSWORD

# 2a. development (hot reload) — two terminals
cd server && npm install && npm run dev   # API + sockets on :4000
cd client && npm install && npm run dev   # UI on :5173 (proxies /api and /socket.io)

# 2b. production / lab machine — one port
cd client && npm install && npm run build
cd ../server && npm install && npm run build && npm start   # everything on :4000
```

Open `http://<server>:4000`. Admin login uses `ADMIN_PASSWORD`
(if unset the server falls back to the insecure default `admin123` and prints a warning).

## Running an event

1. **Before:** Teams tab → add/import teams. Problems tab → each round needs exactly **5 published
   problems**, each with ≥1 test case and ≥1 public sample. Check Settings (session limits, password
   lifetime, optional event PIN) and Proctoring → Policy.
2. **Lobby:** participants pick team + role and *Request temporary password*. Requests appear live in
   **Password manager**; click **Issue password** and read the `XXXX-XXXX` code to them. It is single-use,
   expires (default 8 min), and only a bcrypt hash is stored.
3. **Overview** drives the whole round with one primary button:
   *Open priority selection → (timer ends / Close & allocate) → Start coding → (timer ends / End coding) →
   Publish scoreboard → Start round 2 … → Publish final leaderboard.* Pause, ±time and re-run allocation
   are right there. Timers are absolute server timestamps, so reloads/reconnects/client clocks don't matter.
4. **Allocation:** teams are processed in priority-submission order; capacities are `floor(T/5)` with the
   remainder given to the first problems (32 teams → 7,7,6,6,6). Teams that never submit are allocated last
   in default order. Unallocated teams are flagged for **Override** (reason required, audited).
5. **After:** Scores (adjustments need a reason), Proctoring → Code similarity, Audit & export (CSV).

`Settings → Reset round` wipes one round's data for dress rehearsals.

## Proctoring (exam restrictions)

Participants must accept the rules after login (enforced by the API: no ranking/submitting until accepted).
During *secure phases* (first-years: priorities, allocation, coding · seniors: allocation, coding):

| Control | Behaviour |
|---|---|
| Fullscreen | Contest is **hidden** until fullscreen is restored; every exit is logged |
| Tab / window | Tab switch, minimise and focus loss are logged with timestamps |
| Clipboard | Copy/paste only inside the editor, and only text copied *from* the editor (or a sample). Outside text is blocked and flagged HIGH |
| Editor | Right-click, drag-and-drop and large non-paste insertions are blocked/flagged |
| Shortcuts | F12, Ctrl+Shift+I/J/C, Ctrl+U/S/P blocked; PrintScreen logged; devtools heuristic |
| Environment | Second monitor, second tab on one session, mid-round reload flagged |
| Text selection | Disabled outside the editor and inputs |
| Heartbeat | Fullscreen/focus state every 10 s → admin Teams view |

Everything is a **flag for human review**, never an automatic verdict: admins can review/clear flags with a
note, lock/unlock a team (locked teams cannot submit), or opt into auto-lock after N serious flags
(off by default). All toggles live in **Proctoring → Policy** and apply to connected participants instantly.

> No browser-based proctoring can stop a second device. Use organiser-controlled machines, restrict
> outbound network access at the venue, and treat flags as evidence. Fullscreen/clipboard rules are
> enforced client-side (the API additionally enforces rules-acceptance, lock state, windows and ownership).

## Judging

Submissions are saved first, then judged asynchronously (queue, `JUDGE_CONCURRENCY` workers) so the server
stays responsive. Each test gets a verdict (AC/WA/TLE/RE) and a time; participants see verdicts but **never
hidden inputs or expected outputs**. If a compiler/interpreter is missing the submission stays *Pending*
and is retried automatically (admins can *Rejudge*). **Run** executes public samples only.

Score = passed tests × problem weight (raw count and weighted score stored separately); a team's round score
is its best judged submission. Total = Round 1 + Round 2 + aptitude + audited adjustments.

> The built-in judge runs code as ordinary child processes with time/output limits and a scrubbed
> environment. It is **not a security sandbox**. For untrusted participants run the server on a dedicated
> machine/VM, or replace `JudgeService` internals with Judge0 (same interface).

## Realtime events

`round:state`, `round:timer`, `priority:opened`, `priority:closed`, `allocation:complete` (team room),
`coding:started`, `round:ended`, `submission:status` (team room), `score:update`, `leaderboard:changed`,
`proctor:lock`, `proctor:policy`, `session:revoked`; admin room: `admin:alert`, `admin:login_request`,
`violation:new`, `priority:submitted`, `admin:session_change`.

## Security notes

- Real server-side sessions; admin sessions are stored like any other (the old forgeable `admin_session_*`
  id is gone). Rate limits on password requests and logins. Request bodies are size-limited.
- Hidden tests are server-side only. Statements are withheld until the coding timer starts, and capacity is
  never sent to participants. Seniors cannot read problems during priority selection.
- `server/.env` holds `ADMIN_PASSWORD`; never commit it.

## Tests

`server` has no test runner configured; the repository was verified with scripted end-to-end checks (login
lifecycle, session limits, 32-team allocation under concurrency, judge verdicts/leak checks, proctoring,
realtime rooms, migration of an existing database). To rebuild the database from scratch delete
`database/code_auction.db*`.

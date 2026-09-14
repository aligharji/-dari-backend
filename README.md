# دفتر backend — join-code auth + event logging

A real, running implementation of `auth-flow.md` and `event-schema.md`. No
mock data — every endpoint below was exercised end-to-end in `test/flow-test.js`
against this exact code.

## Run it

```
npm install
node server.js        # listens on :4000 (set PORT to change)
node test/flow-test.js  # runs the full flow against a live server and prints every response
```

Storage is a flat `data.json` file (see `lib/db.js` for why — this was a
deliberate stand-in for a real database, not an oversight). Delete it to
reset to a clean state.

**Production note:** set the `DATA_DIR` environment variable to point at a
mounted persistent volume (e.g. `/data` on Northflank) before deploying —
without it, `data.json` lives in the container's normal filesystem and gets
wiped on every restart or redeploy. Locally, leave `DATA_DIR` unset; it
defaults to the project folder and needs no setup.

## Endpoints

| Method | Path | Who calls it |
|---|---|---|
| `POST /api/classrooms` | Teacher — create a classroom, get a join code |
| `POST /api/classrooms/:id/rotate-code` | Teacher — invalidate the old code, issue a new one |
| `GET /api/classrooms/:id/pending` | Teacher — see learners awaiting approval |
| `POST /api/enrollments/:id/approve` | Teacher — activate a pending enrollment (not the learner directly — one learner can have several) |
| `POST /api/classrooms/recover` | Exchange a saved `recoveryCode` for a fresh `teacherToken` — rotates both, old token dies immediately |
| `POST /api/join` | Learner — join with a classroom code + nickname + PIN. If called with an existing learner session token instead, attaches a new enrollment to that learner in a second classroom (rate-limited) |
| `POST /api/session/resume` | Learner — reconnect with a stored session token |
| `POST /api/learners/:id/parent-link` | Generate a single-use, 7-day parent invite code |
| `POST /api/parent/join` | Parent — redeem a link code (rate-limited, single-use) |
| `POST /api/parent/session/resume` | Parent — reconnect with a stored session token |
| `POST /api/events` | Log one `interaction_event` or `lesson_summary` |
| `GET /api/learners/:id/mastery?tagField=grammarPoint\|vocabDomain&tagId=...` | Compute the rolling mastery percentage for one tag |
| `POST /api/feedback` | Proxy `{system, message}` to Groq, returns `{text}`. Rate-limited (30/10min) since these calls cost real money. Requires `GROQ_API_KEY`. |

## What's real vs. what's still a stand-in

**Real and tested:**
- The approval gate (a guessed/overheard join code doesn't grant access on its own)
- PIN-protected returning-learner resolution (new device, same identity, no duplicate record)
- Single-use, expiring parent link codes
- Rate limiting on both code-guessing endpoints
- Mastery rollup computed from the raw event log, not stored redundantly
- **Retention sweep**: `open_writing` and `open_speaking` responses are
  cleared (`responseValue` set to `null`, rest of the record kept intact)
  once `responseRetentionExpiresAt` passes. Runs once at server startup
  (catches anything that expired while the process was down) and hourly
  after that. Tested directly against expired/future/already-swept/
  unrelated records — see `lib/retentionSweep.js`.
- **Teacher-endpoint authorization**: `POST /api/classrooms` returns a
  `teacherToken` exactly once, at creation. Every other teacher-only route
  (`rotate-code`, `pending`, `approve`, `parent-link`) requires it as
  `Authorization: Bearer <token>` and rejects requests with a missing or
  wrong token (`401 unauthorized_teacher`). Only the token's hash is
  stored server-side.
- **Token recovery**: alongside `teacherToken`, classroom creation also
  returns a `recoveryCode` — a second one-time secret meant to be saved
  *outside* the app (paper, password manager). If `teacherToken` is ever
  lost, `POST /api/classrooms/recover` exchanges the recovery code for a
  fresh token — and issues a fresh recovery code too, since the old one is
  now spent. Verified directly: after recovery, the old token immediately
  returns `401`, the new token works, and reusing the same recovery code
  a second time fails. Still no email, no password, no accounts — same
  self-custody-code pattern as everything else in this system, just with
  a real way back in when a secret is lost.
- **Learner-data authorization**: `GET /api/learners/:id/mastery` and
  `GET /api/learners/:id/summary` now require `Authorization: Bearer
  <token>` from one of exactly three legitimate viewers — the learner's
  own session token, a linked parent's session token, or the classroom's
  teacher token. A valid token for the *wrong* classroom or a different
  learner is correctly rejected (`401`), not just "any token accepted" —
  verified directly: a teacher token from an unrelated classroom cannot
  read a learner it doesn't own.
- **Multi-classroom support**: `classroomId` moved off the `learner`
  record entirely, into a separate `enrollments` collection
  (`{ enrollmentId, learnerId, classroomId, status }`). One person can now
  hold independent memberships — each with its own pending/active status
  — across multiple classrooms and teachers at once. If a request carries
  a valid existing learner session, `POST /api/join` attaches a *new*
  enrollment to that same `learnerId` instead of creating a disconnected
  duplicate identity; without one, it falls back to the original
  nickname+PIN flow, scoped per-classroom exactly as before (no
  cross-classroom identity merging by nickname guess). Approval is now a
  per-**enrollment** action (`POST /api/enrollments/:id/approve`), since a
  learner can be pending in one classroom and already active in another
  simultaneously. Verified end-to-end: same learner, two unrelated
  classrooms, independent approval in each, neither affecting the other's
  status.

**Deliberate stand-ins, not bugs:**
- `lib/db.js` is a JSON file, not Postgres/SQLite — swap the five functions it
  exports for real DB calls; nothing in `server.js` should need to change.

# دفتر backend — join-code auth + event logging

A real, running implementation of `auth-flow.md` and `event-schema.md`. No
mock data — every endpoint below was exercised end-to-end in `test/flow-test.js`
against this exact code. Eevefjklkfalk;nlke lkjfaenlkn;lkwnfklngiow

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
| `POST /api/learners/:id/approve` | Teacher — activate a pending learner, issue their session token |
| `POST /api/join` | Learner — join with a classroom code + nickname + PIN (rate-limited) |
| `POST /api/session/resume` | Learner — reconnect with a stored session token |
| `POST /api/learners/:id/parent-link` | Generate a single-use, 7-day parent invite code |
| `POST /api/parent/join` | Parent — redeem a link code (rate-limited, single-use) |
| `POST /api/parent/session/resume` | Parent — reconnect with a stored session token |
| `POST /api/events` | Log one `interaction_event` or `lesson_summary` |
| `GET /api/learners/:id/mastery?tagField=grammarPoint\|vocabDomain&tagId=...` | Compute the rolling mastery percentage for one tag |

## What's real vs. what's still a stand-in

**Real and tested:**
- The approval gate (a guessed/overheard join code doesn't grant access on its own)
- PIN-protected returning-learner resolution (new device, same identity, no duplicate record)
- Single-use, expiring parent link codes
- Rate limiting on both code-guessing endpoints
- Mastery rollup computed from the raw event log, not stored redundantly

**Deliberate stand-ins, not bugs:**
- `lib/db.js` is a JSON file, not Postgres/SQLite — swap the five functions it
  exports for real DB calls; nothing in `server.js` should need to change.
- The `open_writing` 48-hour retention flag is set on write
  (`responseRetentionExpiresAt`), but nothing actually sweeps and deletes
  expired responses yet — that's a scheduled job this prototype doesn't have.
- No auth on the teacher-only endpoints yet (`POST /api/classrooms`, the
  approve/rotate/parent-link routes) — in production these need to verify
  the caller is actually that classroom's teacher, not just accept any
  `teacherId` the client sends.

# دفتر backend — join-code auth + event logging

A real, running implementation of `auth-flow.md` and `event-schema.md`. No
mock data — every endpoint below was exercised end-to-end in `test/flow-test.js`
against this exact code.

## Run it

```
npm install
node server.js        # listens on :4000 (set PORT to change)
node test/flow-test.js  # runs the full flow against a live server and prints every response
node test/account-flow-test.js  # same, for the email-account system specifically
```

Storage is a flat `data.json` file (see `lib/db.js` for why — this was a
deliberate stand-in for a real database, not an oversight). Delete it to
reset to a clean state.

**Production note:** set the `DATA_DIR` environment variable to point at a
mounted persistent volume (e.g. `/data` on Northflank) before deploying —
without it, `data.json` lives in the container's normal filesystem and gets
wiped on every restart or redeploy. Locally, leave `DATA_DIR` unset; it
defaults to the project folder and needs no setup.

**Environment variables:**

| Variable | Required for | Notes |
|---|---|---|
| `DATA_DIR` | Persistent storage in production | Unset = local project folder |
| `GROQ_API_KEY` | `/api/feedback` | Missing = `503 feedback_not_configured`, not a crash |
| `WIX_API_KEY` | `/api/auth/request-magic-link` | A Wix API key with the `shoutout.manage` permission scope on the site. Missing = email isn't sent, but the request still succeeds and the token is logged server-side for manual testing |
| `WIX_SITE_ID` | Same as above | The Wix site's ID (sent as the `wix-site-id` header) |
| `WIX_SENDER_EMAIL` | Real teacher accounts | See the ⚠️ below — must already be verified via Wix's Sender Emails API |
| `FRONTEND_URL` | Clickable magic links | Without it, the email still sends but only contains the raw code, not a clickable link |

**⚠️ `WIX_SENDER_EMAIL` — read before relying on teacher accounts.**
Tested directly against the real `aligharji.co.uk` Wix site before this was
wired in: an **unverified** sender gets a hard `428 UNVERIFIED_SENDER_EMAIL`
rejection — nothing sends, to anyone, no silent partial-functionality
fallback (this is stricter but more honest than Resend's old behavior,
where an unverified sender would silently succeed but only deliver to the
account owner). Once `WIX_SENDER_EMAIL` is a verified sender (Wix's
Sender Emails API — create, send a verification code, verify with the
code received in that inbox), sending to an arbitrary external recipient
works cleanly — confirmed with a real transactional email, accepted and
delivered, not just a `200 OK` on the request.

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
| `POST /api/auth/request-magic-link` | Teacher account — email a one-time sign-in link via Wix's Email Transmissions API (rate-limited). Requires `WIX_API_KEY`/`WIX_SITE_ID`/`WIX_SENDER_EMAIL`; degrades gracefully if unset (logs the token server-side, doesn't crash). |
| `POST /api/auth/verify` | Exchange a magic-link token for a `teacherSessionToken`. Single-use, 15-minute expiry. |
| `GET /api/teachers/me/classrooms` | List every classroom linked to the signed-in teacher account, across devices. |

## What's real vs. what's still a stand-in

**Real and tested:**
- The approval gate (a guessed/overheard join code doesn't grant access on its own)
- PIN-protected returning-learner resolution (new device, same identity, no duplicate record)
- Single-use, expiring parent link codes
- Rate limiting on both code-guessing endpoints — and `app.set("trust
  proxy", 1)`, without which express-rate-limit can't safely tell clients
  apart behind Northflank's reverse proxy. Found by reproducing the
  deployed environment locally (a spoofed `X-Forwarded-For` header via
  curl) rather than assuming it worked because it passed tests run
  directly against localhost, which never goes through a proxy. Verified
  concretely: one simulated client correctly gets rate-limited at
  request 21, while a second, different simulated client is completely
  unaffected — proving per-client buckets, not one shared global one.
- **Teacher accounts via email magic link**: real identity, separate from
  every self-custody-code credential elsewhere in this system. Verified
  end-to-end: request → single-use, 15-minute-expiry token → verify →
  session. A classroom created while signed in becomes accessible by
  *either* its own `teacherToken` *or* the account session — both
  credentials tested working side by side on the same classroom. Cross-
  tenant isolation verified directly with two genuinely different teacher
  accounts: teacher B correctly gets `401` on teacher A's classroom, and
  that classroom correctly never appears in B's
  `/api/teachers/me/classrooms` list. Anonymous (no-account) classroom
  creation — the original flow — verified still working completely
  unchanged, `ownerTeacherId: null`. **Client-side is now wired too**
  (`dari-app-landing.html`): sign-in form, a "check your email" screen
  covering both delivery paths the email actually contains (clickable
  link via `?magicToken=`, or manual code entry), and the Teacher
  classroom list merges account-fetched classrooms with locally-stored
  ones — tested via static analysis (every `go({screen})` target has a
  matching dispatch branch, no orphaned function definitions from editing
  mistakes) since a live browser click-through wasn't possible from here.
  The one real limitation is still external, not architectural: see the
  `WIX_SENDER_EMAIL` warning above — email delivery itself is now proven
  end-to-end against the real `aligharji.co.uk` site, using the *actual*
  production magic-link HTML content (not generic test copy — that
  distinction mattered: a first test with placeholder text was silently
  `REJECTED` for `BLACKLISTED_TEXT` despite an initial `ACCEPTED` response,
  which would have looked identical to success without checking
  `GetEmailTransmission` afterward). The real content was confirmed
  **actually received in a real inbox**, not just accepted by the API.
  What's still needed: `WIX_API_KEY`/`WIX_SITE_ID` generated from the Wix
  dashboard and set as environment variables — the live tests above used
  Claude's own connected Wix session, not a standalone credential the
  deployed server can reuse autonomously.
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

- **Real bugs found and fixed via production logs, not assumption:**
- **Schema migration gap** (`lib/db.js`): `load()` used to return whatever
  was literally on disk. A `data.json` written before the `teachers`/
  `magicLinks`/`teacherSessions` collections existed had no such keys —
  the first real request to touch `db.find("teachers", ...)` crashed with
  `Cannot read properties of undefined (reading 'find')`. This surfaced as
  a genuine `500` on the live deployed backend, root-caused from the
  actual Northflank stderr log (not guessed), then reproduced locally by
  writing an old-shaped file and confirming the same crash before fixing
  it. Fix: `load()` now merges onto `emptyState()`'s defaults, so any
  collection added to the schema later gets backfilled into old files
  automatically — existing data is never overwritten, only genuinely
  missing keys get a default `[]`. Verified the fix persists correctly:
  after one request, the previously-missing collections are written back
  to the file, not just patched in memory for that call.
- **Broken link when `FRONTEND_URL` is unset**: the magic-link email used
  to unconditionally wrap `magicLinkUrl` in `<a href="...">`, even when
  `FRONTEND_URL` wasn't configured — meaning the `<a>` tag's `href` was
  literally the placeholder text `"(no FRONTEND_URL configured — use the
  raw code below)"`, a clickable link to nowhere. Found by an actual user
  clicking it and hitting a generic browser error. Fixed: the email now
  only renders a real `<a>` tag when there's a genuine URL to link to;
  otherwise it shows only the manual-entry code, with no clickable
  element at all. Verified by isolating and running the template logic
  directly with `FRONTEND_URL` unset — confirmed no `<a href>` appears
  anywhere in the resulting HTML.

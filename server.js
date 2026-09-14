const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const db = require("./lib/db");
const codes = require("./lib/codes");
const { sweepExpiredResponses } = require("./lib/retentionSweep");

const app = express();
// Allowing all origins here is deliberate, not an oversight: this API has no
// origin-based trust model at all — every sensitive action is already gated
// by a join code, PIN, or session token, not by which website is calling it.
// A browser-hosted HTML app on GitHub Pages, a mobile app, or a curl command
// from a terminal are all equally "outside browsers" from this server's
// point of view, so restricting origin would add friction without adding
// real security.
app.use(cors());
app.use(express.json());

// --- rate limiting on the two endpoints that accept a guessable code -------
// This was an explicitly open item in auth-flow.md §6 ("needs to live at the
// API layer, not designed in this document") — closing it here since it's
// cheap and directly protects the join-code brute-force surface.
const codeGuessLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 20,                   // 20 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_attempts", message: "Try again later." },
});

// =========================================================================
// TEACHER: create + manage a classroom
// =========================================================================

app.post("/api/classrooms", (req, res) => {
  const { teacherId, name } = req.body;
  if (!teacherId || !name) return res.status(400).json({ error: "teacherId and name required" });

  // teacherId is now just a display label the client sends, not a security
  // credential — actual authorization for every subsequent teacher action
  // on this classroom is the teacherToken below, which is shown exactly
  // once here and must be stored by the client (same pattern as
  // sessionToken for learners/parents). We store only its hash, so even a
  // dump of data.json can't be used to impersonate a teacher.
  const teacherToken = codes.sessionToken();
  const classroom = {
    classroomId: crypto.randomUUID(),
    teacherId,
    name,
    joinCode: codes.classroomJoinCode(),
    joinCodeCreatedAt: new Date().toISOString(),
    teacherTokenHash: codes.hashSecret(teacherToken),
  };
  db.insert("classrooms", classroom);
  const { teacherTokenHash, ...safeClassroom } = classroom;
  res.status(201).json({ ...safeClassroom, teacherToken });
});

// -- teacher-auth middleware ------------------------------------------------
// Learner identity (learners collection) is now separate from classroom
// membership (enrollments collection) — a person can hold multiple
// enrollments across different classrooms/teachers, so "which classroom
// does this request act on" has to resolve through an enrollment lookup
// wherever the route is scoped by learnerId rather than classroomId
// directly.
function extractToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

function requireTeacherAuthByClassroomId(req, res, next) {
  const classroom = db.find("classrooms", (c) => c.classroomId === req.params.id);
  if (!classroom) return res.status(404).json({ error: "classroom_not_found" });
  const token = extractToken(req);
  if (!token || codes.hashSecret(token) !== classroom.teacherTokenHash) {
    return res.status(401).json({ error: "unauthorized_teacher" });
  }
  req.classroom = classroom;
  next();
}

// Used for the /api/enrollments/:id/approve route — :id is an enrollmentId,
// not a learnerId or classroomId, since approval is now a per-enrollment
// action (a learner could be pending in one classroom and already active
// in another at the same time).
function requireTeacherAuthByEnrollmentId(req, res, next) {
  const enrollment = db.find("enrollments", (e) => e.enrollmentId === req.params.id);
  if (!enrollment) return res.status(404).json({ error: "enrollment_not_found" });
  const classroom = db.find("classrooms", (c) => c.classroomId === enrollment.classroomId);
  if (!classroom) return res.status(404).json({ error: "classroom_not_found" });
  const token = extractToken(req);
  if (!token || codes.hashSecret(token) !== classroom.teacherTokenHash) {
    return res.status(401).json({ error: "unauthorized_teacher" });
  }
  const learner = db.find("learners", (l) => l.learnerId === enrollment.learnerId);
  req.enrollment = enrollment;
  req.classroom = classroom;
  req.learner = learner;
  next();
}

// Used for /api/learners/:id/parent-link — a learner may have enrollments
// across several classrooms with different teachers, so this accepts a
// token from ANY teacher who shares an enrollment relationship with this
// learner, not just one fixed classroom.
function requireTeacherAuthByLearnerId(req, res, next) {
  const learner = db.find("learners", (l) => l.learnerId === req.params.id);
  if (!learner) return res.status(404).json({ error: "learner_not_found" });
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: "unauthorized_teacher" });

  const learnerClassroomIds = db.filter("enrollments", (e) => e.learnerId === learner.learnerId).map((e) => e.classroomId);
  const matchingClassroom = learnerClassroomIds
    .map((cid) => db.find("classrooms", (c) => c.classroomId === cid))
    .find((c) => c && codes.hashSecret(token) === c.teacherTokenHash);

  if (!matchingClassroom) return res.status(401).json({ error: "unauthorized_teacher" });
  req.classroom = matchingClassroom;
  req.learner = learner;
  next();
}

// Three legitimate viewers for a learner's progress data: the learner
// themselves, a parent linked to them, or any teacher sharing an
// enrollment with them (same "any of their classrooms' teachers" logic as
// requireTeacherAuthByLearnerId above). Session tokens (learner/parent)
// are compared directly since they're already high-entropy bearer tokens;
// only the teacher token is hash-compared, matching how it's stored.
function requireLearnerDataAccess(req, res, next) {
  const learner = db.find("learners", (l) => l.learnerId === req.params.id);
  if (!learner) return res.status(404).json({ error: "learner_not_found" });

  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: "unauthorized" });

  const asLearner = db.find("sessions", (s) => s.token === token && s.learnerId === learner.learnerId);
  if (asLearner) { req.learner = learner; return next(); }

  const asParent = db.find("parentSessions", (s) => s.token === token && s.learnerId === learner.learnerId);
  if (asParent) { req.learner = learner; return next(); }

  const learnerClassroomIds = db.filter("enrollments", (e) => e.learnerId === learner.learnerId).map((e) => e.classroomId);
  const asTeacher = learnerClassroomIds
    .map((cid) => db.find("classrooms", (c) => c.classroomId === cid))
    .some((c) => c && codes.hashSecret(token) === c.teacherTokenHash);
  if (asTeacher) { req.learner = learner; return next(); }

  return res.status(401).json({ error: "unauthorized" });
}

app.post("/api/classrooms/:id/rotate-code", requireTeacherAuthByClassroomId, (req, res) => {
  const classroom = db.update(
    "classrooms",
    (c) => c.classroomId === req.params.id,
    { joinCode: codes.classroomJoinCode(), joinCodeCreatedAt: new Date().toISOString() }
  );
  // per auth-flow.md §6: rotation only affects *new* joins — existing
  // learner records and their sessions are untouched by this call.
  const { teacherTokenHash, ...safe } = classroom;
  res.json(safe);
});

app.get("/api/classrooms/:id/pending", requireTeacherAuthByClassroomId, (req, res) => {
  const pendingEnrollments = db.filter(
    "enrollments",
    (e) => e.classroomId === req.params.id && e.status === "pending"
  );
  const result = pendingEnrollments.map((e) => {
    const learner = db.find("learners", (l) => l.learnerId === e.learnerId);
    return {
      enrollmentId: e.enrollmentId,
      learnerId: e.learnerId,
      displayNickname: learner ? learner.displayNickname : "(unknown)",
      createdAt: e.createdAt,
    };
  });
  res.json(result);
});

app.post("/api/enrollments/:id/approve", requireTeacherAuthByEnrollmentId, (req, res) => {
  db.update("enrollments", (e) => e.enrollmentId === req.params.id, { status: "active" });
  const learner = req.learner;
  const session = { token: codes.sessionToken(), learnerId: learner.learnerId, createdAt: new Date().toISOString() };
  db.insert("sessions", session);
  res.json({
    learner: safeLearner(learner),
    classroomId: req.classroom.classroomId,
    sessionToken: session.token,
  });
});

// =========================================================================
// LEARNER: join a classroom, resume a session
// =========================================================================

app.post("/api/join", codeGuessLimiter, (req, res) => {
  const { joinCode, nickname, pin } = req.body;
  if (!joinCode || !nickname || !pin) {
    return res.status(400).json({ error: "joinCode, nickname, and pin are required" });
  }
  if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: "pin must be 4 digits" });

  const classroom = db.find("classrooms", (c) => c.joinCode === joinCode.toUpperCase());
  if (!classroom) return res.status(404).json({ error: "invalid_join_code" });

  // If the request carries a valid existing learner session, this is a
  // RETURNING learner joining an ADDITIONAL classroom — attach a new
  // enrollment to their existing learnerId instead of creating a second,
  // disconnected identity. Each classroom still requires its own separate
  // approval; joining classroom B does not inherit approval from A.
  const presentedToken = extractToken(req);
  if (presentedToken) {
    const existingSession = db.find("sessions", (s) => s.token === presentedToken);
    if (existingSession) {
      const learner = db.find("learners", (l) => l.learnerId === existingSession.learnerId);
      const already = db.find("enrollments", (e) => e.learnerId === learner.learnerId && e.classroomId === classroom.classroomId);
      if (already) {
        return res.status(already.status === "pending" ? 202 : 200).json({
          status: already.status,
          learner: safeLearner(learner),
          classroomId: classroom.classroomId,
          message: already.status === "pending" ? "Still waiting for teacher approval." : undefined,
        });
      }
      const enrollment = {
        enrollmentId: crypto.randomUUID(),
        learnerId: learner.learnerId,
        classroomId: classroom.classroomId,
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      db.insert("enrollments", enrollment);
      return res.status(202).json({ status: "pending", learnerId: learner.learnerId, message: "Waiting for your teacher to approve you." });
    }
  }

  // No existing session presented — proceed with the original nickname+PIN
  // flow, scoped to THIS classroom via the enrollments join (same security
  // property as before: a nickname collision in an unrelated classroom
  // can't resolve to someone else's identity here).
  const enrollmentsInClass = db.filter("enrollments", (e) => e.classroomId === classroom.classroomId);
  const existingLearnerId = enrollmentsInClass
    .map((e) => ({ e, learner: db.find("learners", (l) => l.learnerId === e.learnerId) }))
    .find(({ learner }) => learner && learner.displayNickname === nickname);

  if (existingLearnerId) {
    const { e: enrollment, learner } = existingLearnerId;
    if (learner.pinHash !== codes.hashSecret(pin)) {
      return res.status(409).json({ error: "nickname_taken", message: "That name is already in use in this class — try another, or check your PIN." });
    }
    if (enrollment.status === "pending") {
      return res.status(202).json({ status: "pending", message: "Still waiting for teacher approval." });
    }
    const session = { token: codes.sessionToken(), learnerId: learner.learnerId, createdAt: new Date().toISOString() };
    db.insert("sessions", session);
    return res.json({ status: "active", learner: safeLearner(learner), classroomId: classroom.classroomId, sessionToken: session.token });
  }

  const learner = {
    learnerId: crypto.randomUUID(),
    displayNickname: nickname,
    pinHash: codes.hashSecret(pin),
    createdAt: new Date().toISOString(),
  };
  db.insert("learners", learner);
  const enrollment = {
    enrollmentId: crypto.randomUUID(),
    learnerId: learner.learnerId,
    classroomId: classroom.classroomId,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  db.insert("enrollments", enrollment);
  res.status(202).json({ status: "pending", learnerId: learner.learnerId, message: "Waiting for your teacher to approve you." });
});

app.post("/api/session/resume", (req, res) => {
  const { token } = req.body;
  const session = db.find("sessions", (s) => s.token === token);
  if (!session) return res.status(401).json({ error: "invalid_session" });
  const learner = db.find("learners", (l) => l.learnerId === session.learnerId);

  // Returns every classroom this learner belongs to, each with its own
  // status — the client needs this to know which dashboard(s) to show,
  // and to correctly attribute future events to the right classroom.
  const enrollments = db.filter("enrollments", (e) => e.learnerId === learner.learnerId).map((e) => {
    const classroom = db.find("classrooms", (c) => c.classroomId === e.classroomId);
    return { classroomId: e.classroomId, className: classroom ? classroom.name : null, status: e.status };
  });

  res.json({ learner: safeLearner(learner), enrollments });
});

// =========================================================================
// PARENT: link to a specific learner, resume a session
// =========================================================================

app.post("/api/learners/:id/parent-link", requireTeacherAuthByLearnerId, (req, res) => {
  const learner = req.learner;

  const link = {
    linkId: crypto.randomUUID(),
    learnerId: learner.learnerId,
    linkCode: codes.parentLinkCode(),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    usedAt: null,
  };
  db.insert("parentLinks", link);
  res.status(201).json({ linkCode: link.linkCode, expiresAt: link.expiresAt });
});

app.post("/api/parent/join", codeGuessLimiter, (req, res) => {
  const { linkCode } = req.body;
  if (!linkCode) return res.status(400).json({ error: "linkCode required" });

  const link = db.find("parentLinks", (l) => l.linkCode === linkCode.toUpperCase());
  if (!link) return res.status(404).json({ error: "invalid_link_code" });
  if (link.usedAt) return res.status(410).json({ error: "code_already_used" });
  if (new Date(link.expiresAt) < new Date()) return res.status(410).json({ error: "code_expired" });

  db.update("parentLinks", (l) => l.linkId === link.linkId, { usedAt: new Date().toISOString() });

  const session = { token: codes.sessionToken(), learnerId: link.learnerId, createdAt: new Date().toISOString() };
  db.insert("parentSessions", session);
  const learner = db.find("learners", (l) => l.learnerId === link.learnerId);
  res.json({ learner: safeLearner(learner), sessionToken: session.token });
});

app.post("/api/parent/session/resume", (req, res) => {
  const { token } = req.body;
  const session = db.find("parentSessions", (s) => s.token === token);
  if (!session) return res.status(401).json({ error: "invalid_session" });
  const learner = db.find("learners", (l) => l.learnerId === session.learnerId);
  res.json({ learner: safeLearner(learner) });
});

// =========================================================================
// EVENTS: interaction_event / lesson_summary, per event-schema.md
// =========================================================================

app.post("/api/events", (req, res) => {
  const event = req.body;
  if (!event.learnerId || !event.eventType) {
    return res.status(400).json({ error: "learnerId and eventType are required" });
  }
  // open_writing responses get a short, explicit TTL rather than living
  // forever in the same table as a tapped multiple-choice answer —
  // event-schema.md §4. The raw text is dropped by a separate sweep job in
  // production; here we just tag it so that job has something to find.
  const record = {
    eventId: crypto.randomUUID(),
    serverTimestamp: new Date().toISOString(),
    ...event,
  };
  // Any free-form response type gets the same short retention treatment —
  // open_speaking (added with the Listening/Speaking track) is exactly as
  // personal as open_writing and was missing this check until now.
  const FREE_FORM_TYPES = ["open_writing", "open_speaking"];
  if (FREE_FORM_TYPES.includes(event.stepType) && event.responseValue) {
    record.responseRetentionExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  }
  db.insert("events", record);
  res.status(201).json({ eventId: record.eventId });
});

// mastery rollup — same query shape as the SQL in event-schema.md §3,
// expressed against the flat-file store.
app.get("/api/learners/:id/mastery", requireLearnerDataAccess, (req, res) => {
  const { tagField, tagId } = req.query; // tagField: "grammarPoint" | "vocabDomain"
  if (!["grammarPoint", "vocabDomain"].includes(tagField)) {
    return res.status(400).json({ error: "tagField must be grammarPoint or vocabDomain" });
  }
  const all = db.filter(
    "events",
    (e) => e.learnerId === req.params.id && e[tagField] === tagId && e.correct !== null && e.correct !== undefined
  );
  const recent = all.sort((a, b) => new Date(b.serverTimestamp) - new Date(a.serverTimestamp)).slice(0, 20);
  const pct = recent.length ? Math.round((recent.filter((e) => e.correct).length / recent.length) * 100) : null;
  res.json({ tagField, tagId, sampleSize: recent.length, pct });
});

// Powers the Parent dashboard's summary card. Deliberately doesn't include
// time-on-task ("weekly minutes") — nothing in the event schema actually
// measures real duration yet (lesson_summary's totalDurationMs is sent as
// null by the client today), so reporting a number there would mean
// fabricating it client-side, exactly the thing this whole rewiring pass
// was about stopping. unitsCompleted and streakDays are both derived
// directly from real event timestamps.
app.get("/api/learners/:id/summary", requireLearnerDataAccess, (req, res) => {
  const learnerEvents = db.filter("events", (e) => e.learnerId === req.params.id);
  const summaries = learnerEvents.filter((e) => e.eventType === "lesson_summary");

  const activityDates = [...new Set(
    learnerEvents.map((e) => new Date(e.serverTimestamp).toISOString().slice(0, 10))
  )].sort().reverse(); // most recent date first

  let streakDays = 0;
  if (activityDates.length) {
    let cursor = new Date();
    for (const dateStr of activityDates) {
      const cursorStr = cursor.toISOString().slice(0, 10);
      if (dateStr !== cursorStr) break; // gap in activity (or most recent day wasn't today) — streak ends here
      streakDays++;
      cursor.setDate(cursor.getDate() - 1);
    }
  }

  const lastActiveAt = learnerEvents.length
    ? learnerEvents.sort((a, b) => new Date(b.serverTimestamp) - new Date(a.serverTimestamp))[0].serverTimestamp
    : null;

  res.json({
    unitsCompleted: summaries.length,
    streakDays,
    lastActiveAt,
  });
});

function safeLearner(learner) {
  if (!learner) return null;
  const { pinHash, ...safe } = learner;
  return safe;
}

// =========================================================================
// FEEDBACK: server-side proxy to Groq, so this works everywhere — not just
// inside claude.ai, which is the only place a direct browser call to
// api.anthropic.com gets an auto-injected key. GROQ_API_KEY must be set as
// an environment variable (same pattern as DATA_DIR) — never sent to the
// client, never logged.
//
// Deliberately generic: this endpoint doesn't know or care about any
// particular unit's feedback JSON shape (strength/fix/upgrade, etc.) — it
// just forwards {system, message} to the model and hands back the raw
// text. Parsing that text into a specific shape stays a client concern,
// same as it already was when calling Anthropic directly. That keeps this
// endpoint reusable as more units/tracks get added, instead of every new
// feedback rubric needing a matching change here.
const feedbackLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30, // feedback calls cost real money per request — worth limiting even for a legitimate user hammering retry
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_requests", message: "Try again in a few minutes." },
});

app.post("/api/feedback", feedbackLimiter, async (req, res) => {
  const { system, message } = req.body;
  if (!system || !message) {
    return res.status(400).json({ error: "system and message are required" });
  }
  if (!process.env.GROQ_API_KEY) {
    return res.status(503).json({ error: "feedback_not_configured", message: "GROQ_API_KEY is not set on the server." });
  }

  try {
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        // llama-3.3-70b-versatile was deprecated/shut down by Groq on
        // 2026-08-16 — openai/gpt-oss-120b is their official recommended
        // replacement (console.groq.com/docs/deprecations).
        model: "openai/gpt-oss-120b",
        messages: [
          { role: "system", content: system },
          { role: "user", content: message },
        ],
        response_format: { type: "json_object" }, // best-effort JSON mode; client still defensively parses either way
      }),
    });

    if (!groqRes.ok) {
      const errBody = await groqRes.text().catch(() => "");
      return res.status(502).json({ error: "upstream_error", status: groqRes.status, detail: errBody.slice(0, 300) });
    }

    const data = await groqRes.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) return res.status(502).json({ error: "empty_response" });

    res.json({ text });
  } catch (e) {
    res.status(502).json({ error: "upstream_unreachable" });
  }
});

const PORT = process.env.PORT || 4000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`دفتر backend listening on :${PORT}`));

  // Sweep once on startup — catches anything that expired while the
  // process was down or mid-restart, since nothing else was running to
  // catch it — then keep sweeping hourly. Kept inside require.main so
  // importing this file as a module (e.g. for tests) never starts a
  // background timer as a side effect.
  const sweepAndLog = () => {
    const count = sweepExpiredResponses();
    if (count > 0) console.log(`retention sweep: cleared ${count} expired response(s)`);
  };
  sweepAndLog();
  setInterval(sweepAndLog, 60 * 60 * 1000);
}

module.exports = app;

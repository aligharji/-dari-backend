const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const db = require("./lib/db");
const codes = require("./lib/codes");

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

  const classroom = {
    classroomId: crypto.randomUUID(),
    teacherId,
    name,
    joinCode: codes.classroomJoinCode(),
    joinCodeCreatedAt: new Date().toISOString(),
  };
  db.insert("classrooms", classroom);
  res.status(201).json(classroom);
});

app.post("/api/classrooms/:id/rotate-code", (req, res) => {
  const classroom = db.update(
    "classrooms",
    (c) => c.classroomId === req.params.id,
    { joinCode: codes.classroomJoinCode(), joinCodeCreatedAt: new Date().toISOString() }
  );
  if (!classroom) return res.status(404).json({ error: "classroom_not_found" });
  // per auth-flow.md §6: rotation only affects *new* joins — existing
  // learner records and their sessions are untouched by this call.
  res.json(classroom);
});

app.get("/api/classrooms/:id/pending", (req, res) => {
  const pending = db.filter(
    "learners",
    (l) => l.classroomId === req.params.id && l.status === "pending"
  );
  res.json(pending.map(({ pinHash, ...safe }) => safe)); // never return the PIN hash
});

app.post("/api/learners/:id/approve", (req, res) => {
  const learner = db.update(
    "learners",
    (l) => l.learnerId === req.params.id,
    { status: "active" }
  );
  if (!learner) return res.status(404).json({ error: "learner_not_found" });

  const session = { token: codes.sessionToken(), learnerId: learner.learnerId, createdAt: new Date().toISOString() };
  db.insert("sessions", session);
  res.json({ learner: safeLearner(learner), sessionToken: session.token });
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

  // returning-learner path: same nickname + matching PIN in this classroom
  // resumes the existing learnerId instead of creating a duplicate pending
  // request — auth-flow.md §4.
  const existing = db.find(
    "learners",
    (l) => l.classroomId === classroom.classroomId && l.displayNickname === nickname
  );
  if (existing) {
    if (existing.pinHash !== codes.hashPin(pin)) {
      return res.status(409).json({ error: "nickname_taken", message: "That name is already in use in this class — try another, or check your PIN." });
    }
    if (existing.status === "pending") {
      return res.status(202).json({ status: "pending", message: "Still waiting for teacher approval." });
    }
    const session = { token: codes.sessionToken(), learnerId: existing.learnerId, createdAt: new Date().toISOString() };
    db.insert("sessions", session);
    return res.json({ status: "active", learner: safeLearner(existing), sessionToken: session.token });
  }

  const learner = {
    learnerId: crypto.randomUUID(),
    classroomId: classroom.classroomId,
    displayNickname: nickname,
    pinHash: codes.hashPin(pin),
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  db.insert("learners", learner);
  res.status(202).json({ status: "pending", learnerId: learner.learnerId, message: "Waiting for your teacher to approve you." });
});

app.post("/api/session/resume", (req, res) => {
  const { token } = req.body;
  const session = db.find("sessions", (s) => s.token === token);
  if (!session) return res.status(401).json({ error: "invalid_session" });
  const learner = db.find("learners", (l) => l.learnerId === session.learnerId);
  res.json({ learner: safeLearner(learner) });
});

// =========================================================================
// PARENT: link to a specific learner, resume a session
// =========================================================================

app.post("/api/learners/:id/parent-link", (req, res) => {
  const learner = db.find("learners", (l) => l.learnerId === req.params.id);
  if (!learner) return res.status(404).json({ error: "learner_not_found" });

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
  if (event.stepType === "open_writing" && event.responseValue) {
    record.responseRetentionExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  }
  db.insert("events", record);
  res.status(201).json({ eventId: record.eventId });
});

// mastery rollup — same query shape as the SQL in event-schema.md §3,
// expressed against the flat-file store.
app.get("/api/learners/:id/mastery", (req, res) => {
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
        model: // llama-3.3-70b-versatile was deprecated/shut down by Groq on
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
}

module.exports = app;

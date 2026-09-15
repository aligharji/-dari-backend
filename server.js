const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const db = require("./lib/db");
const codes = require("./lib/codes");
const { sweepExpiredResponses } = require("./lib/retentionSweep");

const app = express();

// Northflank (and most platforms) sit the app behind a single reverse
// proxy, which sets X-Forwarded-For. Without telling Express to trust
// exactly one proxy hop, express-rate-limit can't safely determine each
// client's real IP — found by actually reproducing the deployed
// environment locally (curl with a spoofed X-Forwarded-For header) rather
// than assuming the rate limiter worked just because it passed tests
// running directly against localhost, which never goes through a proxy.
// "1" means trust exactly one hop; a client can't spoof past that because
// Express only reads the entry the proxy itself appended.
app.set("trust proxy", 1);

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
// AUTH: real teacher accounts via email magic link.
//
// This is genuinely different from every other credential in this system —
// everything else so far (join codes, PINs, teacherToken, recoveryCode) is
// a self-custody secret with no external identity behind it. A magic link
// is the first thing here that actually requires sending mail.
//
// Email is sent via Wix's own Email Transmissions API, not a third-party
// provider — tested live against the real aligharji.co.uk Wix site before
// this was wired in, not assumed from docs alone. Two things confirmed
// directly, not just read: (1) an unverified sender is HARD REJECTED
// (`428 UNVERIFIED_SENDER_EMAIL`), no silent partial-functionality fallback
// the way Resend's unverified default sender has; (2) with a verified
// sender, sending to an arbitrary external recipient (not an existing Wix
// contact) is accepted cleanly — confirmed via `toRecipients[].emailAddress`,
// which auto-creates a contact if one doesn't already exist.
// =========================================================================

const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10, // requesting a magic link repeatedly should be rare for a real user
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_attempts", message: "Try again later." },
});

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function sendMagicLinkEmail(email, magicLinkUrl, rawToken) {
  if (!process.env.WIX_API_KEY || !process.env.WIX_SITE_ID) {
    return { sent: false, reason: "WIX_API_KEY or WIX_SITE_ID not set" };
  }
  // WIX_SENDER_EMAIL must already be verified via the Sender Emails API
  // (dashboard or API) — an unverified sender gets a hard 428 rejection,
  // confirmed directly against the real site, not assumed.
  const senderEmail = process.env.WIX_SENDER_EMAIL;
  if (!senderEmail) {
    return { sent: false, reason: "WIX_SENDER_EMAIL not set" };
  }
  try {
    const res = await fetch("https://www.wixapis.com/email-transmissions/v1/email-transmissions/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": process.env.WIX_API_KEY,
        "wix-site-id": process.env.WIX_SITE_ID,
      },
      body: JSON.stringify({
        emailTransmission: {
          emailSubject: "لینک ورود به دفتر",
          emailHtmlContent: `
            ${magicLinkUrl
              ? `<p>برای ورود به حساب معلم خودت، روی این لینک کلیک کن:</p>
                 <p><a href="${magicLinkUrl}">${magicLinkUrl}</a></p>
                 <p>اگر لینک کار نکرد، این کد را در برنامه وارد کن:</p>`
              : `<p>برای ورود به حساب معلم خودت، این کد را در برنامه وارد کن:</p>`
            }
            <p style="font-family: monospace; font-size: 18px;">${rawToken}</p>
            <p style="color: #888; font-size: 12px;">این کد تا ۱۵ دقیقه معتبر است.</p>
          `,
          senderName: "دفتر",
          senderEmailAddress: senderEmail,
          toRecipients: [{ emailAddress: email }],
          type: "TRANSACTIONAL",
        },
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { sent: false, reason: `Wix returned ${res.status}: ${detail.slice(0, 200)}` };
    }
    const data = await res.json();
    return { sent: data.emailTransmission?.status === "ACCEPTED", reason: data.emailTransmission?.status };
  } catch (e) {
    return { sent: false, reason: "request to Wix failed" };
  }
}

app.post("/api/auth/request-magic-link", authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!isValidEmail(email)) return res.status(400).json({ error: "invalid_email" });

  let teacher = db.find("teachers", (t) => t.email === email.toLowerCase());
  if (!teacher) {
    teacher = { teacherId: crypto.randomUUID(), email: email.toLowerCase(), createdAt: new Date().toISOString() };
    db.insert("teachers", teacher);
  }

  const token = codes.sessionToken();
  const magicLink = {
    token,
    teacherId: teacher.teacherId,
    email: teacher.email,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    usedAt: null,
  };
  db.insert("magicLinks", magicLink);

  const frontendUrl = process.env.FRONTEND_URL || "";
  const magicLinkUrl = frontendUrl
    ? `${frontendUrl}${frontendUrl.includes("?") ? "&" : "?"}magicToken=${token}`
    : null; // no placeholder string — the template below only renders a real <a> when this is truthy

  const emailResult = await sendMagicLinkEmail(teacher.email, magicLinkUrl, token);
  if (!emailResult.sent) {
    // Don't fail the request over a misconfigured/unreachable email
    // provider during development — but don't pretend it worked either.
    console.log(`magic-link email NOT sent (${emailResult.reason}) — token for manual testing: ${token}`);
  }

  res.json({ message: "If that email is valid, a sign-in link has been sent.", emailSent: emailResult.sent });
});

app.post("/api/auth/verify", authLimiter, (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "token required" });

  const magicLink = db.find("magicLinks", (m) => m.token === token);
  if (!magicLink) return res.status(404).json({ error: "invalid_token" });
  if (magicLink.usedAt) return res.status(410).json({ error: "token_already_used" });
  if (new Date(magicLink.expiresAt) < new Date()) return res.status(410).json({ error: "token_expired" });

  db.update("magicLinks", (m) => m.token === token, { usedAt: new Date().toISOString() });

  const session = { token: codes.sessionToken(), teacherId: magicLink.teacherId, createdAt: new Date().toISOString() };
  db.insert("teacherSessions", session);

  res.json({ teacherId: magicLink.teacherId, email: magicLink.email, sessionToken: session.token });
});

function requireTeacherSession(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: "unauthorized" });
  const session = db.find("teacherSessions", (s) => s.token === token);
  if (!session) return res.status(401).json({ error: "unauthorized" });
  req.teacherId = session.teacherId;
  next();
}

app.get("/api/teachers/me/classrooms", requireTeacherSession, (req, res) => {
  const classrooms = db.filter("classrooms", (c) => c.ownerTeacherId === req.teacherId);
  res.json(classrooms.map(({ teacherTokenHash, recoveryCodeHash, ...safe }) => safe));
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
  //
  // recoveryCode is a SECOND one-time secret, deliberately separate from
  // teacherToken: teacherToken is what the app stores automatically for
  // day-to-day use; recoveryCode is what the teacher writes down somewhere
  // outside the app, and is the only way back in if teacherToken is ever
  // lost (cleared browser data, new device). No accounts, no email — same
  // self-custody-code pattern as every other secret in this system.
  const teacherToken = codes.sessionToken();
  const recovery = codes.recoveryCode();

  // If the request carries a valid teacher-account session, link this
  // classroom to that account so it shows up via /api/teachers/me/classrooms
  // on any device. This is purely additive — the classroom still gets its
  // own independent teacherToken/recoveryCode exactly as before, so
  // anonymous (no-account) classroom creation keeps working unchanged.
  let ownerTeacherId = null;
  const sessionToken = extractToken(req);
  if (sessionToken) {
    const session = db.find("teacherSessions", (s) => s.token === sessionToken);
    if (session) ownerTeacherId = session.teacherId;
  }

  const classroom = {
    classroomId: crypto.randomUUID(),
    teacherId,
    name,
    joinCode: codes.classroomJoinCode(),
    joinCodeCreatedAt: new Date().toISOString(),
    teacherTokenHash: codes.hashSecret(teacherToken),
    recoveryCodeHash: codes.hashSecret(recovery),
    ownerTeacherId,
  };
  db.insert("classrooms", classroom);
  const { teacherTokenHash, recoveryCodeHash, ...safeClassroom } = classroom;
  res.status(201).json({ ...safeClassroom, teacherToken, recoveryCode: recovery });
});

// Recovery: exchanges a recovery code for a fresh teacherToken. Scans all
// classrooms rather than taking a classroomId in the URL, because a
// teacher who's lost their token may not have the classroomId handy
// either — the recovery code alone should be enough to get back in. Both
// the teacherToken AND the recovery code are rotated on use, so a
// recovery code is genuinely single-use, same as the parent-link codes.
app.post("/api/classrooms/recover", codeGuessLimiter, (req, res) => {
  const { recoveryCode } = req.body;
  if (!recoveryCode) return res.status(400).json({ error: "recoveryCode required" });

  const hash = codes.hashSecret(recoveryCode.trim().toUpperCase());
  const classroom = db.find("classrooms", (c) => c.recoveryCodeHash === hash);
  if (!classroom) return res.status(404).json({ error: "invalid_recovery_code" });

  const newTeacherToken = codes.sessionToken();
  const newRecovery = codes.recoveryCode();
  const updated = db.update("classrooms", (c) => c.classroomId === classroom.classroomId, {
    teacherTokenHash: codes.hashSecret(newTeacherToken),
    recoveryCodeHash: codes.hashSecret(newRecovery),
  });
  const { teacherTokenHash, recoveryCodeHash, ...safeClassroom } = updated;
  res.json({ ...safeClassroom, teacherToken: newTeacherToken, recoveryCode: newRecovery });
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

// Shared by every teacher-auth check below: a classroom is unlocked either
// by its own per-classroom teacherToken (the original, still-primary
// credential), OR by a teacher-account session token whose teacherId
// matches the classroom's ownerTeacherId (only set if the classroom was
// created while signed in). Centralized here so the two-credential check
// only has to be written once, not reimplemented per middleware.
function isAuthorizedTeacherToken(token, classroom) {
  if (!token || !classroom) return false;
  if (codes.hashSecret(token) === classroom.teacherTokenHash) return true;
  if (classroom.ownerTeacherId) {
    const session = db.find("teacherSessions", (s) => s.token === token);
    if (session && session.teacherId === classroom.ownerTeacherId) return true;
  }
  return false;
}

function requireTeacherAuthByClassroomId(req, res, next) {
  const classroom = db.find("classrooms", (c) => c.classroomId === req.params.id);
  if (!classroom) return res.status(404).json({ error: "classroom_not_found" });
  const token = extractToken(req);
  if (!isAuthorizedTeacherToken(token, classroom)) {
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
  if (!isAuthorizedTeacherToken(token, classroom)) {
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
    .find((c) => isAuthorizedTeacherToken(token, c));

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
    .some((c) => isAuthorizedTeacherToken(token, c));
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
  const { teacherTokenHash, recoveryCodeHash, ...safe } = classroom;
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

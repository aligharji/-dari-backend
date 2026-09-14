const BASE = "http://localhost:4000";

async function post(path, body, token) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
async function get(path, token) {
  const res = await fetch(BASE + path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function log(label, result) {
  console.log(`\n--- ${label} [${result.status}] ---`);
  console.log(JSON.stringify(result.data, null, 2));
}

(async () => {
  // 1. Teacher creates a classroom
  const classroom = await post("/api/classrooms", { teacherId: "t1", name: "صنف الف" });
  log("create classroom", classroom);
  const { joinCode, classroomId, teacherToken } = classroom.data;

  // 1b. teacher-only endpoints should reject a request with no/wrong token
  const noAuth = await get(`/api/classrooms/${classroomId}/pending`);
  log("pending list with NO token (expect 401)", noAuth);
  const wrongAuth = await get(`/api/classrooms/${classroomId}/pending`, "not-the-real-token");
  log("pending list with WRONG token (expect 401)", wrongAuth);

  // 2. Learner joins -> should land pending
  const join1 = await post("/api/join", { joinCode, nickname: "احمد", pin: "1234" });
  log("learner join (first time -> pending)", join1);
  const learnerId = join1.data.learnerId;

  // 2b. Same learner tries to resume before approval -> still pending
  const joinAgainBeforeApproval = await post("/api/join", { joinCode, nickname: "احمد", pin: "1234" });
  log("same learner, same device, before approval", joinAgainBeforeApproval);

  // 2c. Someone else tries the same nickname with the WRONG pin -> rejected
  const impostor = await post("/api/join", { joinCode, nickname: "احمد", pin: "9999" });
  log("different pin, same nickname -> should be rejected", impostor);

  // 3. Teacher sees pending list (now requires the real teacherToken)
  const pending = await get(`/api/classrooms/${classroomId}/pending`, teacherToken);
  log("teacher's pending list (with real token)", pending);

  // 4. Teacher approves (also requires the token)
  const approve = await post(`/api/learners/${learnerId}/approve`, {}, teacherToken);
  log("teacher approves", approve);
  const learnerToken = approve.data.sessionToken;

  // 5. Learner resumes session (e.g. next day, same device)
  const resume = await post("/api/session/resume", { token: learnerToken });
  log("learner resumes session with stored token", resume);

  // 5b. Learner on a NEW device: rejoins with nickname + correct pin -> resumes same learnerId, no duplicate
  const newDeviceRejoin = await post("/api/join", { joinCode, nickname: "احمد", pin: "1234" });
  log("same learner, new device, correct pin -> resumes existing learnerId", newDeviceRejoin);
  console.log(`   (matches original learnerId? ${newDeviceRejoin.data.learner.learnerId === learnerId})`);

  // 6. Log a few interaction events, matching event-schema.md shapes
  await post("/api/events", {
    learnerId, classroomId, sessionId: "sess-1",
    unitId: "a1-fruit", unitLevel: "A1", grammarPoint: "verbs.want-structure", vocabDomain: "fruit-vegetables",
    stage: "quiz", stepType: "picture_match", questionIndex: 0,
    attemptNumber: 1, correct: true, responseValue: "انگور",
    eventType: "interaction_event",
  });
  await post("/api/events", {
    learnerId, classroomId, sessionId: "sess-1",
    unitId: "a1-fruit", unitLevel: "A1", grammarPoint: "verbs.want-structure", vocabDomain: "fruit-vegetables",
    stage: "quiz", stepType: "letter_fill", questionIndex: 1,
    attemptNumber: 1, correct: false, responseValue: "ب",
    eventType: "interaction_event",
  });
  const evt3 = await post("/api/events", {
    learnerId, classroomId, sessionId: "sess-1",
    unitId: "a1-fruit", unitLevel: "A1", grammarPoint: "verbs.want-structure", vocabDomain: "fruit-vegetables",
    stage: "quiz", stepType: "open_writing", questionIndex: 2,
    attemptNumber: 1, correct: null, responseValue: "دو سیب می‌خواهم",
    eventType: "interaction_event",
  });
  log("open_writing event (should carry a retention expiry)", evt3);

  const summary = await post("/api/events", {
    learnerId, classroomId, sessionId: "sess-1",
    unitId: "a1-fruit", unitLevel: "A1", grammarPoint: "verbs.want-structure", vocabDomain: "fruit-vegetables",
    quizScore: 2, quizScoreMax: 3, hintsUsed: 0, totalDurationMs: 91000,
    eventType: "lesson_summary",
  });
  log("lesson_summary event", summary);

  // 7. Mastery rollup for that grammar point
  const masteryNoAuth = await get(`/api/learners/${learnerId}/mastery?tagField=grammarPoint&tagId=verbs.want-structure`);
  log("mastery with NO token (expect 401)", masteryNoAuth);

  const mastery = await get(`/api/learners/${learnerId}/mastery?tagField=grammarPoint&tagId=verbs.want-structure`, learnerToken);
  log("mastery rollup with learner's own token (1 correct, 1 incorrect -> 50%)", mastery);

  const masteryAsTeacher = await get(`/api/learners/${learnerId}/mastery?tagField=grammarPoint&tagId=verbs.want-structure`, teacherToken);
  log("same mastery, viewed with the TEACHER's token (should also succeed)", masteryAsTeacher);

  // 8. Parent link flow
  const parentLink = await post(`/api/learners/${learnerId}/parent-link`, {}, teacherToken);
  log("teacher/app generates parent link code", parentLink);
  const linkCode = parentLink.data.linkCode;

  const parentJoin = await post("/api/parent/join", { linkCode });
  log("parent enters code", parentJoin);
  const parentToken = parentJoin.data.sessionToken;

  const parentReuse = await post("/api/parent/join", { linkCode });
  log("SAME code used again -> should fail (single-use)", parentReuse);

  const parentResume = await post("/api/parent/session/resume", { token: parentToken });
  log("parent resumes session", parentResume);

  console.log("\n=== FLOW TEST COMPLETE ===");
})();

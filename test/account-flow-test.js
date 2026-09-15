const fs = require("fs");
const path = require("path");
const BASE = "http://localhost:4000";
const DATA_FILE = path.join(__dirname, "..", "data.json");

async function post(path_, body, token) {
  const res = await fetch(BASE + path_, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
async function get(path_, token) {
  const res = await fetch(BASE + path_, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
function log(label, result) {
  console.log(`\n--- ${label} [${result.status}] ---`);
  console.log(JSON.stringify(result.data, null, 2));
}

(async () => {
  const email = "teacher-test@example.com";

  // 1. Request a magic link. No RESEND_API_KEY in this local test, so the
  // email genuinely won't send — that's expected and handled gracefully
  // (emailSent: false), not a failure. The raw token still gets created
  // server-side regardless of whether delivery succeeded, same as how a
  // real "check your email" flow would work once RESEND_API_KEY is set.
  const request1 = await post("/api/auth/request-magic-link", { email });
  log("request magic link", request1);
  console.log("   emailSent false as expected locally?", request1.data.emailSent === false);

  // Pull the raw token directly from the data file — stands in for "the
  // teacher clicks the link in their inbox" in a real deployment.
  const state = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  const magicLink = state.magicLinks[state.magicLinks.length - 1];
  const token = magicLink.token;

  // 2. Verify the token -> get a real teacherSessionToken
  const verify = await post("/api/auth/verify", { token });
  log("verify magic link token", verify);
  const teacherSessionToken = verify.data.sessionToken;

  // 2b. Reusing the same token should now fail — single-use, matches every
  // other code in this system (parent-link, recovery code).
  const reuseToken = await post("/api/auth/verify", { token });
  log("reuse the SAME magic link token — expect failure", reuseToken);

  // 3. Create a classroom WHILE authenticated — should link to the account
  const classroom = await post("/api/classrooms", { teacherId: "t1", name: "linked to account" }, teacherSessionToken);
  log("create classroom while signed in", classroom);
  console.log("   classroom still got its own independent teacherToken/recoveryCode?",
    !!classroom.data.teacherToken && !!classroom.data.recoveryCode);

  // 4. List "my classrooms" via the account — this is the actual
  // cross-device payoff: a DIFFERENT device with no localStorage at all
  // could sign in with just the email and see this classroom.
  const myClassrooms = await get("/api/teachers/me/classrooms", teacherSessionToken);
  log("list classrooms via account session", myClassrooms);
  console.log("   classroom appears in the list?",
    myClassrooms.data.some(c => c.classroomId === classroom.data.classroomId));

  // 5. Dual-path auth proof: manage the classroom using ONLY the account
  // session token — never touching the classroom's own teacherToken at
  // all. This is what makes it genuinely usable from a second device.
  const pendingViaAccount = await get(`/api/classrooms/${classroom.data.classroomId}/pending`, teacherSessionToken);
  log("view pending list using ONLY the account session (not the classroom's own token)", pendingViaAccount);

  // 6. A classroom created WITHOUT being signed in should NOT show up in
  // the account's list — proves this is genuinely opt-in/additive, not
  // silently claiming every classroom for whoever happens to be logged in.
  const anonClassroom = await post("/api/classrooms", { teacherId: "t2", name: "anonymous, no account" });
  log("create classroom while NOT signed in", anonClassroom);
  const myClassroomsAgain = await get("/api/teachers/me/classrooms", teacherSessionToken);
  const anonAppearsIncorrectly = myClassroomsAgain.data.some(c => c.classroomId === anonClassroom.data.classroomId);
  console.log("\n   anonymous classroom incorrectly appears in account list?", anonAppearsIncorrectly, "(should be false)");

  console.log("\n=== ACCOUNT FLOW TEST COMPLETE ===");
})();

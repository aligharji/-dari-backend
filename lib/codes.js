const crypto = require("crypto");

// Excludes 0/O and 1/I/L — the classroom code gets written on a whiteboard
// and read aloud to a room full of kids, so ambiguous characters are a real
// usability bug, not just a cosmetic concern.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomCode(length) {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

function classroomJoinCode() {
  return randomCode(6);
}

function parentLinkCode() {
  // longer than the classroom code: this one is single-use and grants a
  // more specific, more sensitive binding (one parent to one child), so it
  // gets more entropy even though it's also shorter-lived.
  return randomCode(8);
}

function recoveryCode() {
  // 16 characters, grouped into 4s with dashes — this one is meant to be
  // written down somewhere outside the app (paper, password manager) and
  // typed back in months later if a teacherToken is ever lost, so
  // readability when handwritten/re-typed matters more than for the other
  // codes here.
  const raw = randomCode(16);
  return raw.match(/.{1,4}/g).join("-");
}

function learnerPin() {
  // 4 digits, deliberately low-friction — see auth-flow.md §4: this isn't
  // meant to resist a real attacker, just stop a classmate from casually
  // claiming someone else's nickname on a new device.
  return String(crypto.randomInt(0, 10000)).padStart(4, "0");
}

function sessionToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function hashSecret(secret) {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

module.exports = { classroomJoinCode, parentLinkCode, recoveryCode, learnerPin, sessionToken, hashSecret };

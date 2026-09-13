// Deliberately a flat JSON file, not a real database. auth-flow.md explicitly
// left the DB choice open ("Postgres vs. something simpler — schema above
// works with either") — this stands in for that decision so the actual
// logic (codes, approval, sessions, events) can be built and tested now
// without picking infrastructure prematurely. Swapping this module for a
// real DB client later shouldn't require touching server.js, since every
// route only talks to the functions exported here.

const fs = require("fs");
const path = require("path");

// DATA_DIR is configurable so this file can point at a mounted persistent
// volume in production (e.g. Northflank) instead of living next to the code
// in ephemeral container storage, which gets wiped on every redeploy/restart.
// Locally, it just defaults to the project folder — no setup needed for dev.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..");
const DATA_FILE = path.join(DATA_DIR, "data.json");

function emptyState() {
  return {
    classrooms: [],   // { classroomId, teacherId, name, joinCode, joinCodeCreatedAt }
    learners: [],     // { learnerId, classroomId, displayNickname, pinHash, status, createdAt }
    sessions: [],      // { token, learnerId, createdAt }
    parentLinks: [],   // { linkId, learnerId, linkCode, createdAt, expiresAt, usedAt }
    parentSessions: [], // { token, learnerId, createdAt }
    events: [],        // interaction_event / lesson_summary, per event-schema.md
  };
}

function load() {
  if (!fs.existsSync(DATA_FILE)) return emptyState();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (e) {
    return emptyState();
  }
}

function save(state) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

// Every exported function re-reads and re-writes the file. This is not fast
// — it's fine for a classroom-scale prototype and intentionally simple to
// audit. A real DB swap would replace the guts of these functions, not
// their signatures.

function getState() { return load(); }

function insert(collection, record) {
  const state = load();
  state[collection].push(record);
  save(state);
  return record;
}

function update(collection, predicate, patch) {
  const state = load();
  const idx = state[collection].findIndex(predicate);
  if (idx === -1) return null;
  state[collection][idx] = { ...state[collection][idx], ...patch };
  save(state);
  return state[collection][idx];
}

function find(collection, predicate) {
  return load()[collection].find(predicate) || null;
}

function filter(collection, predicate) {
  return load()[collection].filter(predicate);
}

module.exports = { getState, insert, update, find, filter, DATA_FILE };

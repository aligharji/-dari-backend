const db = require("./db");

// event-schema.md §4: free-form responses (open_writing, open_speaking) get
// a short, explicit lifetime — the raw text should not sit indefinitely in
// the same table as a tapped multiple-choice answer. This is the job that
// actually enforces the responseRetentionExpiresAt flag server.js sets at
// write time; until this existed, that flag was set but never acted on.
//
// What gets swept: responseValue is set to null and the record is marked
// responseSwept — everything else (correct, questionIndex, timestamps,
// grammarPoint/vocabDomain tags) is kept, because that's what mastery
// rollups and lesson summaries need, and none of it is the sensitive part.
function sweepExpiredResponses(now = new Date()) {
  const isExpired = (e) =>
    e.responseRetentionExpiresAt &&
    new Date(e.responseRetentionExpiresAt) <= now &&
    e.responseValue !== null &&
    e.responseValue !== undefined;

  return db.updateMany("events", isExpired, () => ({
    responseValue: null,
    responseSwept: true,
    responseSweptAt: now.toISOString(),
  }));
}

module.exports = { sweepExpiredResponses };

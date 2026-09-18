// Runs from the privileged workflow (.github/workflows/process-submission.yml),
// triggered on `issues: opened`. The issue body is UNTRUSTED DATA, never
// executed — this script only ever JSON.parse's it and checks it against a
// fixed schema.
//
// IMPORTANT CHANGE: this validator now only reads `text`. Previous
// versions also accepted a `semantic` block and a `canonical_key`
// declared by the client, revalidated by recomputing the hash — which
// protected against a forged hash, but not against a hand-crafted
// `semantic` block unrelated to `text` while staying internally
// consistent. This structure now has NO role whatsoever: even if a
// client (old or malicious) still sends it, this file never reads it,
// and scripts/process-graph.mjs won't either. Only the server-side
// extraction (scripts/semantic-extract.mjs, on `text` alone) produces
// the structure that counts. See that file's header for the full
// reasoning.
//
// What THIS file still guarantees: that `text` is indeed a non-empty
// string, of reasonable length, that `location` is a real pair of
// coordinates, and that the author hasn't exceeded the daily
// submission quota. Nothing more — semantic structuring and identity
// (canonical_key) are now entirely the responsibility of
// scripts/process-graph.mjs, downstream.
//
// LOCATION: every submission is tagged with where it came from — never
// with who submitted it. `location` travels alongside `text` in the
// same submitted JSON block, is validated here the same way, and ends
// up on the node itself (scripts/process-graph.mjs), never next to any
// contributor identity — exactly the same treatment as `text`.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const MAX_TEXT_LENGTH = 2000;
const PENDING_DIR = "submissions/pending";
const SUBMISSION_MARKER = "<!-- sgd:submission:v1 -->";

function fail(reasons) {
  writeFileSync(
    "validation-result.json",
    JSON.stringify({ valid: false, reasons }, null, 2)
  );
  console.error("INVALID:", reasons.join("; "));
  process.exit(0); // exit 0: the workflow step still needs to read the verdict
}

function ok(filename) {
  writeFileSync(
    "validation-result.json",
    JSON.stringify({ valid: true, filename }, null, 2)
  );
  console.log("VALID:", filename);
  process.exit(0);
}

const payloadPath = process.env.ISSUE_PAYLOAD_PATH;
if (!payloadPath || !existsSync(payloadPath)) {
  fail(["ISSUE_PAYLOAD_PATH missing or not found — invalid execution context"]);
}

const { number: issueNumber, login: author, body } = JSON.parse(readFileSync(payloadPath, "utf-8"));
const reasons = [];

// 1. This must be an SGD submission issue, not just any issue.
if (typeof body !== "string" || !body.includes(SUBMISSION_MARKER)) {
  fail(["the issue does not contain the SGD submission marker"]);
}

// 2. Extract the ```json ... ``` block — everything else in the body
// (explanations, quoted replies, etc.) is ignored.
const jsonMatch = body.match(/```json\s*([\s\S]*?)```/i);
if (!jsonMatch) {
  fail(["no ```json``` block found in the issue body"]);
}

let submitted;
try {
  submitted = JSON.parse(jsonMatch[1]);
} catch (e) {
  fail([`invalid JSON in the submission block: ${e.message}`]);
}

// 3. The ONLY data that matters: `text`. Everything else in the
// submitted JSON (semantic, canonical_key, or any other field an old
// client or an attacker might have included) is simply ignored — never
// read here, never passed on to scripts/process-graph.mjs.
const text = typeof submitted.text === "string" ? submitted.text.trim() : "";

if (!text) {
  reasons.push("missing or empty 'text' field");
}
if (text.length > MAX_TEXT_LENGTH) {
  reasons.push(`'text' exceeds ${MAX_TEXT_LENGTH} characters`);
}

// Required, not optional: a submission with no real, plausible pair of
// coordinates is rejected the same way one with no text is. Bounds
// check only — this can't verify the location is genuine, only that
// it's a coordinate that could exist.
const location = submitted.location;
const hasValidLocation =
  location &&
  typeof location.lat === "number" &&
  typeof location.lon === "number" &&
  Number.isFinite(location.lat) &&
  Number.isFinite(location.lon) &&
  location.lat >= -90 &&
  location.lat <= 90 &&
  location.lon >= -180 &&
  location.lon <= 180;

if (!hasValidLocation) {
  reasons.push("missing or invalid 'location' field (requires numeric lat/lon)");
}

if (reasons.length) fail(reasons);

// 4. Rate-limit per GitHub account. Any issue carrying the marker is
// labeled BEFORE this check (see the workflow), including ones later
// judged invalid — so spam via an empty or too-long text also counts
// against the quota, rather than offering free retries.
const MAX_SUBMISSIONS_PER_DAY = 30;
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;

if (author && token && repo) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const query = encodeURIComponent(
    `repo:${repo} type:issue label:sgd-submission author:${author} created:>=${since}`
  );
  const res = await fetch(`https://api.github.com/search/issues?q=${query}`, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (res.ok) {
    const data = await res.json();
    if (data.total_count > MAX_SUBMISSIONS_PER_DAY) {
      fail([
        `rate limit reached for ${author}: ${data.total_count} submissions in the last 24h (max ${MAX_SUBMISSIONS_PER_DAY})`,
      ]);
    }
  } else {
    console.warn("Rate-limit check skipped (API call failed):", res.status);
  }
} else {
  console.warn("Missing author/token context — rate-limit not checked (likely a local test).");
}

// 5. Write the raw text to submissions/pending/ — named by issue
// number, the only stable identifier available at this stage
// (canonical_key doesn't exist yet: it will be computed by
// process-graph.mjs from THIS text, never before).
if (!existsSync(PENDING_DIR)) mkdirSync(PENDING_DIR, { recursive: true });

const filename = `issue-${issueNumber}.json`;
const filePath = join(PENDING_DIR, filename);
writeFileSync(
  filePath,
  JSON.stringify(
    {
      text,
      location: { lat: location.lat, lon: location.lon },
      submitted_at: new Date().toISOString(),
      source_issue: issueNumber,
      client_version: submitted.client_version || "unknown",
    },
    null,
    2
  )
);

ok(filePath);

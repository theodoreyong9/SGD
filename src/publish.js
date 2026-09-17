// Publishing via a pre-filled GitHub Issue — no OAuth, no CORS relay,
// no fork/PR.
//
// WHY: `github.com/OWNER/REPO/issues/new?title=...&body=...` is a LINK,
// not a fetch() call. Ordinary navigation is never subject to CORS
// (CORS only applies to cross-origin JS requests). The user clicks,
// lands on github.com already logged into THEIR OWN account, reviews
// the pre-filled form, and clicks "Submit new issue" themselves.
//
// This extra click on the github.com domain isn't just a technical
// constraint: it's a native human confirmation, on a domain no
// third-party page can script-simulate. It's a better anti-automation
// signal than a programmatic POST triggered from our own page could
// ever be.
//
// What this eliminates by construction, compared to the previous
// version:
//   - no GitHub OAuth App to create/configure
//   - no CORS relay to deploy (proxy/worker.js no longer exists)
//   - no token, of any kind, ever passes through the browser
//   - no fork or PR to manage client-side
//
// What this does NOT guarantee (see scripts/validate-submission.mjs):
// the Issue body remains text that ANYONE can edit before clicking
// "Submit", or forge via the API with their own token. That's why the
// server no longer trusts ANY structured field of this payload — see
// the note on `text` below.

import { OWNER, REPO } from "./config.js";

// Invisible marker used by the workflow to distinguish an SGD
// submission Issue from any other Issue opened on the repo (bug
// report, question, etc.) — more robust than a label, which might not
// exist yet on a brand-new repo.
export const SUBMISSION_MARKER = "<!-- sgd:submission:v1 -->";

// Cautious limit: beyond this, some proxies/servers truncate very long
// URLs before they even reach GitHub.
const MAX_URL_LENGTH = 7500;

export class SubmissionTooLargeError extends Error {}

// buildSubmissionIssueUrl({ text, ref }) -> string (full URL)
//
// IMPORTANT CHANGE: this payload no longer contains `semantic` or
// `canonical_key`. Until now, the browser sent the result of its own
// WebLLM extraction, and the server only reverified the hash — which
// protected against a forged hash, but not against a hand-crafted
// `semantic` block unrelated to `text` while staying internally
// consistent. Still sending that block would no longer have any
// effect: scripts/validate-submission.mjs and scripts/process-graph.mjs
// don't read it at all anymore. `text` is now the ONLY data that
// matters — it's the server that extracts its own authoritative
// structure from it (see scripts/semantic-extract.mjs).
//
// `ref` is a client-generated identifier (see src/app.js,
// crypto.randomUUID()), with NO protocol role whatsoever — it's only
// used to find this Issue again later via GitHub's Search API, for the
// tracking shown in "Your submissions" (src/tracker.js). Replacing or
// removing it changes nothing about what's accepted or rejected.
export function buildSubmissionIssueUrl({ text, ref }) {
  const payload = {
    text,
    ref,
    submitted_at: new Date().toISOString(),
    client_version: "3.0.0",
  };

  const title = `[SGD] ${text.slice(0, 72)}`;
  const body = [
    SUBMISSION_MARKER,
    "",
    "This Issue was pre-filled automatically by the SGD interface.",
    "Only the `text` field below is used: the semantic structure and",
    "the identity of this proposition are entirely recomputed",
    "server-side, from this text alone — nothing else in this block is",
    "read or trusted.",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n");

  const params = new URLSearchParams({ title, body, labels: "sgd-submission" });
  const url = `https://github.com/${OWNER}/${REPO}/issues/new?${params.toString()}`;

  if (url.length > MAX_URL_LENGTH) {
    throw new SubmissionTooLargeError(
      "This proposition is too long for the submission link. Shorten the text."
    );
  }

  return url;
}

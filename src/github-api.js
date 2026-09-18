// DIRECT calls to the GitHub API — api.github.com natively supports
// CORS for authenticated requests (Access-Control-Allow-Origin: *,
// verified via a real OPTIONS call). No relay needed here, unlike the
// two OAuth exchange endpoints (see src/oauth.js): once the token is
// obtained, everything else is an ordinary fetch(), directly from the
// browser.

import { OWNER, REPO } from "./config.js";

const SUBMISSION_MARKER = "<!-- sgd:submission:v1 -->";

export class GitHubApiError extends Error {}

// createSubmissionIssue(token, { text, ref, location }) -> { number, html_url }
//
// Opens the Issue directly via the API, never redirecting the user to
// github.com — that's the concrete difference from the old "pre-filled
// link" flow. `ref` still has no protocol role at all (see
// scripts/validate-submission.mjs, which has only ever read `text` and
// `location`) — kept for consistency, even though its original purpose
// (finding the issue via the Search API) is less necessary now that the
// issue number is known immediately from this call's own return value.
export async function createSubmissionIssue(token, { text, ref, location }) {
  const payload = {
    text,
    location,
    ref,
    submitted_at: new Date().toISOString(),
    client_version: "4.0.0",
  };

  const body = [
    SUBMISSION_MARKER,
    "",
    "This Issue was created automatically by the SGD interface, via the",
    "GitHub API authenticated with your account — you didn't have to do",
    "anything on github.com for this particular submission. Only the",
    "`text` and `location` fields below are used: the semantic",
    "structure and the identity of this proposition are entirely",
    "recomputed server-side, from the text alone.",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n");

  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/issues`, {
    method: "POST",
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: `[SGD] ${text.slice(0, 72)}`,
      body,
      labels: ["sgd-submission"],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new GitHubApiError(err.message || `Failed to create the Issue (HTTP ${res.status})`);
  }

  const issue = await res.json();
  return { number: issue.number, html_url: issue.html_url };
}

// getIssueStatus(number) -> full Issue object (state, state_reason, ...)
// No token needed to read a public Issue — anonymous call, sufficient
// and doesn't eat into the user's own token quota.
export async function getIssueStatus(number) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/issues/${number}`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new GitHubApiError(`Failed to read Issue #${number} (HTTP ${res.status})`);
  return res.json();
}

// getIssueComments(number) -> list of comments (never throws: a network
// error just returns an empty list, tracking stays degraded rather than
// broken).
export async function getIssueComments(number) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/issues/${number}/comments`,
      { headers: { Accept: "application/vnd.github+json" } }
    );
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

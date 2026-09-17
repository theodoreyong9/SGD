// Client-side submission tracking.
//
// IMPORTANT CHANGE: since moving to Issue creation via the authenticated
// API (src/github-api.js, createSubmissionIssue), the Issue number is
// known IMMEDIATELY from the call's return value — no more need to
// guess or search via GitHub's Search API like when submission went
// through an external link we had no visibility into. Tracking
// therefore reduces to directly querying GET /issues/{number}, a public
// read, no authentication required, with a much more generous rate
// limit (60/h anonymous, versus 10/min for the old Search API).
//
// For the fallback flow (pre-filled link, used when OAuth isn't
// configured — see src/publish.js and src/app.js), the Issue number
// isn't known ahead of time. In that case, the entry is recorded with
// `number: null` and simply stays "pending" until manually dismissed —
// no automatic tracking is possible without knowing the Issue, which is
// an accepted limitation of the fallback flow.
//
// Storage: localStorage, NO account, NO server of our own. It only
// survives in THIS browser; if the user switches devices, they lose
// tracking (but not their contribution: it stays in the graph if it was
// processed).

import { getIssueStatus, getIssueComments } from "./github-api.js";

const STORAGE_KEY = "sgd_tracked_submissions";
const MAX_TRACKED = 20;

// Extracts the canonical_key from the closing comment posted by the
// workflow. Expected format (see
// .github/workflows/process-submission.yml): a node identified between
// backticks, 32 hexadecimal characters.
const NODE_ID_PATTERN = /node `([0-9a-f]{32})`/;

function readAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeAll(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_TRACKED)));
  } catch {
    // localStorage quota exceeded, or private browsing without
    // persistence — degrades silently, this is only a UX convenience,
    // not a guarantee.
  }
}

// recordSubmission({ number, html_url, text, domain }): `number` is
// null for a submission that went through the fallback flow (link),
// known immediately for one that went through the direct API.
export function recordSubmission({ number, html_url, text, domain }) {
  const list = readAll();
  list.unshift({
    number: number ?? null,
    issue_url: html_url ?? null,
    node_id: null, // discovered later, see refreshStatus
    text,
    domain,
    recorded_at: new Date().toISOString(),
    status: "pending", // pending | accepted | rejected | unknown
    reason: null,
  });
  writeAll(list);
  return list;
}

export function getTracked() {
  return readAll();
}

// Stable local identifier for an entry: the Issue number if known,
// otherwise the recording timestamp (unique in practice).
function entryId(entry) {
  return entry.number ?? entry.recorded_at;
}

export function dismissTracked(id) {
  writeAll(readAll().filter((s) => String(entryId(s)) !== String(id)));
}

export function setStatus(id, patch) {
  const list = readAll().map((s) => (String(entryId(s)) === String(id) ? { ...s, ...patch } : s));
  writeAll(list);
  return list;
}

// refreshStatus(entry): queries the Issue directly by its number. Never
// throws; a network error simply leaves the entry unchanged. Without a
// known number (fallback flow, see header), there's nothing to check
// automatically.
export async function refreshStatus(entry) {
  if (!entry.number) return entry;

  try {
    const issue = await getIssueStatus(entry.number);
    const updated = { ...entry, issue_url: issue.html_url };

    if (issue.state === "open") {
      updated.status = "pending";
    } else if (issue.state_reason === "completed") {
      updated.status = "accepted";
      updated.node_id = await extractNodeId(entry.number);
    } else if (issue.state_reason === "not_planned") {
      updated.status = "rejected";
      updated.reason = await extractLastCommentBody(entry.number);
    } else {
      updated.status = "unknown";
    }

    const list = readAll().map((s) => (entryId(s) === entryId(entry) ? updated : s));
    writeAll(list);
    return updated;
  } catch {
    return entry;
  }
}

async function extractNodeId(issueNumber) {
  const body = await extractLastCommentBody(issueNumber);
  const match = body?.match(NODE_ID_PATTERN);
  return match ? match[1] : null;
}

async function extractLastCommentBody(issueNumber) {
  const comments = await getIssueComments(issueNumber);
  return comments[comments.length - 1]?.body || null;
}

export async function refreshAllPending() {
  const list = readAll();
  const pending = list.filter((s) => s.number && (s.status === "pending" || s.status === "unknown"));
  for (const entry of pending) {
    await refreshStatus(entry);
  }
  return readAll();
}

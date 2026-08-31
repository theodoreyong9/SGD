// Runs from the single privileged workflow (.github/workflows/
// process-submission.yml), triggered on `issues: opened`. Unlike the old
// PR-based version, there is no untrusted CODE to isolate here — only
// untrusted DATA (the issue body text), which THIS script — checked out
// from `main`, never anything an issue author could alter — parses with
// JSON.parse and validates against a fixed schema. Nothing here ever
// executes anything the issue author wrote.
//
// Reads its input from ISSUE_PAYLOAD_PATH: a JSON file of shape
// { number, login, body } written beforehand by an actions/github-script
// step (never interpolated into a shell string — see the workflow file
// for why that distinction matters for injection-safety).
//
// On success, writes the validated submission to submissions/pending/ and
// prints its path so the workflow can pick it up. It never merges, never
// pushes, never touches anything else in the repo — that stays entirely
// in the hands of scripts/process-graph.mjs, still run as a separate step.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { canonicalKey } from "./canonical.mjs";

const MAX_TEXT_LENGTH = 2000;
const MAX_CONCEPTS = 20;
const MAX_RELATIONS = 20;
const ALLOWED_RELATION_TYPES = new Set([
  "implique", "contredit", "complete", "generalise", "specialise",
  "alternative_a", "depend_de",
]);
const ALLOWED_DOMAINS = new Set([
  "environnement", "transport", "energie", "sante", "education",
  "economie", "technologie", "international", "social", "autre",
]);
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
  fail(["ISSUE_PAYLOAD_PATH manquant ou introuvable — contexte d'exécution invalide"]);
}

const { number: issueNumber, login: author, body } = JSON.parse(readFileSync(payloadPath, "utf-8"));
const reasons = [];

// 1. This issue must actually carry our marker. The workflow already
// filters on this before running the script, but re-checking here means
// this script stays safe to run standalone/locally too.
if (typeof body !== "string" || !body.includes(SUBMISSION_MARKER)) {
  fail(["l'issue ne contient pas le marqueur de soumission SGD"]);
}

// 2. Extract the fenced ```json ... ``` block. Anything outside it
// (explanatory prose the author might add, quoted replies, etc.) is
// ignored entirely.
const jsonMatch = body.match(/```json\s*([\s\S]*?)```/i);
if (!jsonMatch) {
  fail(["aucun bloc ```json``` trouvé dans le corps de l'issue"]);
}

let submission;
try {
  submission = JSON.parse(jsonMatch[1]);
} catch (e) {
  fail([`JSON invalide dans le bloc de soumission: ${e.message}`]);
}

// 3. Schema + bounds. Generous enough for real proposals, tight enough
// that a script can't smuggle megabytes of junk into the repo per issue.
const s = submission.semantic || {};
if (typeof submission.text !== "string" || submission.text.length === 0) {
  reasons.push("champ 'text' manquant ou vide");
}
if (submission.text && submission.text.length > MAX_TEXT_LENGTH) {
  reasons.push(`'text' dépasse ${MAX_TEXT_LENGTH} caractères`);
}
if (!Array.isArray(s.concepts) || s.concepts.length === 0) {
  reasons.push("'semantic.concepts' doit être un tableau non vide");
}
if (Array.isArray(s.concepts) && s.concepts.length > MAX_CONCEPTS) {
  reasons.push(`'semantic.concepts' dépasse ${MAX_CONCEPTS} éléments`);
}
if (s.relations && s.relations.length > MAX_RELATIONS) {
  reasons.push(`'semantic.relations' dépasse ${MAX_RELATIONS} éléments`);
}
for (const r of s.relations || []) {
  if (!ALLOWED_RELATION_TYPES.has(r.type)) {
    reasons.push(`type de relation inconnu: ${r.type}`);
  }
}
if (!ALLOWED_DOMAINS.has(s.domain)) {
  reasons.push(`domaine inconnu: ${s.domain}`);
}
if (!submission.canonical_key || typeof submission.canonical_key !== "string") {
  reasons.push("'canonical_key' manquant");
}

if (reasons.length) fail(reasons);

// 4. Rate-limit by GitHub account. This is NOT a Sybil-proofing mechanism
// — creating accounts is cheap — it only protects against a single
// compromised or automated account flooding the queue faster than the
// diminishing-return scoring can absorb it. Every issue carrying the
// marker gets labeled `sgd-submission` by the workflow BEFORE validation
// (even invalid ones), so this count also catches malformed-JSON spam.
const MAX_SUBMISSIONS_PER_DAY = 30;
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY; // "owner/name", set by Actions

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
        `limite de fréquence atteinte pour ${author}: ${data.total_count} soumissions dans les dernières 24h (max ${MAX_SUBMISSIONS_PER_DAY})`,
      ]);
    }
  } else {
    console.warn("Vérification du rate-limit ignorée (échec API):", res.status);
  }
} else {
  console.warn("Contexte d'auteur/token absent — rate-limit non vérifié (probablement un test local).");
}

// 5. Re-derive the canonical key deterministically — the AI-produced
// structure is trusted for CONTENT, but identity/dedup NEVER depends on
// the client's self-reported hash. Anyone can hand-edit the JSON block
// before clicking "Submit new issue" (unlike the old fork+PR flow, there
// is no client-side signature protecting it) — which is exactly why this
// re-derivation, not the submitted hash, is what decides identity.
const recomputed = canonicalKey({
  concepts: s.concepts,
  relations: s.relations,
  objective: s.objective,
  means: s.means,
  domain: s.domain,
});

if (recomputed !== submission.canonical_key) {
  fail([
    `canonical_key ne correspond pas au contenu (déclaré: ${submission.canonical_key}, recalculé: ${recomputed}) — le protocole ne fait jamais confiance à un hash auto-déclaré`,
  ]);
}

// 6. Write to submissions/pending/. There is no PR/fork step anymore —
// the workflow that invokes this script has already checked out `main`
// and will commit this file (plus the graph update) directly, since the
// only untrusted input it ever touched was DATA, not code.
if (!existsSync(PENDING_DIR)) mkdirSync(PENDING_DIR, { recursive: true });

const filename = `${recomputed}__${Date.now()}.json`;
const filePath = join(PENDING_DIR, filename);
writeFileSync(
  filePath,
  JSON.stringify(
    {
      text: submission.text,
      semantic: {
        concepts: s.concepts,
        relations: s.relations || [],
        objective: s.objective || "",
        means: s.means || "",
        domain: s.domain,
      },
      canonical_key: recomputed,
      submitted_at: new Date().toISOString(),
      source_issue: issueNumber,
      client_version: submission.client_version || "unknown",
    },
    null,
    2
  )
);

ok(filePath);

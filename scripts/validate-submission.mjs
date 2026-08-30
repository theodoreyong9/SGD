// Runs on the `pull_request` trigger — NO repo secrets are available here,
// and this script may be executing code influenced by an untrusted fork.
// Its only job is to produce a verdict; it never merges, never pushes,
// never touches anything outside the current checkout.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
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
const ALLOWED_PATH_PREFIX = "submissions/pending/";

function fail(reasons) {
  writeFileSync(
    "validation-result.json",
    JSON.stringify({ valid: false, reasons }, null, 2)
  );
  console.error("INVALID:", reasons.join("; "));
  process.exit(0); // exit 0 so the workflow can still upload the artifact
}

function ok(filename) {
  writeFileSync(
    "validation-result.json",
    JSON.stringify({ valid: true, filename }, null, 2)
  );
  console.log("VALID:", filename);
  process.exit(0);
}

const reasons = [];

// 1. Diff must touch exactly one file, and it must be an addition under the
// whitelisted path. This is the anti-supply-chain gate: nothing else in the
// repo — no workflow, no source file, no other submission — may be touched.
const diff = execSync("git diff --name-status origin/main...HEAD")
  .toString()
  .trim()
  .split("\n")
  .filter(Boolean);

if (diff.length !== 1) {
  reasons.push(`la PR doit modifier exactement 1 fichier (trouvé: ${diff.length})`);
}

const [status, path] = (diff[0] || "").split("\t");
if (status !== "A") {
  reasons.push(`le fichier doit être un AJOUT, pas une modification/suppression (status: ${status})`);
}
if (!path || !path.startsWith(ALLOWED_PATH_PREFIX) || !path.endsWith(".json")) {
  reasons.push(`le fichier doit être sous ${ALLOWED_PATH_PREFIX} et finir en .json (reçu: ${path})`);
}

if (reasons.length) fail(reasons);

if (!existsSync(path)) fail([`fichier annoncé introuvable: ${path}`]);

let submission;
try {
  submission = JSON.parse(readFileSync(path, "utf-8"));
} catch (e) {
  fail([`JSON invalide: ${e.message}`]);
}

// 2. Schema + bounds. Generous enough for real proposals, tight enough that
// a script can't smuggle megabytes of junk into the repo per submission.
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

// 3. Re-derive the canonical key deterministically — the AI-produced structure
// is trusted for CONTENT, but identity/dedup NEVER depends on the client's
// self-reported hash. This is section 8 & 35 of the spec made literal.
const recomputed = canonicalKey({
  concepts: s.concepts,
  relations: s.relations,
  objective: s.objective,
  means: s.means,
  domain: s.domain,
});

if (recomputed !== submission.canonical_key) {
  fail([
    `canonical_key ne correspond pas au contenu (client: ${submission.canonical_key}, recalculé: ${recomputed}) — le protocole ne fait jamais confiance à un hash auto-déclaré`,
  ]);
}

ok(path);

// Runs from the privileged workflow (.github/workflows/process-submission.yml),
// triggered on `issues: opened`. The issue body is UNTRUSTED DATA, never
// executed — this script only ever JSON.parse's it and checks it against a
// fixed schema.
//
// CHANGEMENT IMPORTANT : ce validateur ne lit plus que `text`. Les
// versions précédentes acceptaient aussi un bloc `semantic` et un
// `canonical_key` déclarés par le client, revalidés en recalculant le
// hash — ce qui protégeait contre un hash falsifié, mais pas contre un
// bloc `semantic` construit à la main, sans rapport réel avec `text`, tout
// en restant interne-cohérent. Cette structure n'a désormais plus AUCUN
// rôle : même si un client (ancien ou malveillant) l'envoie encore, ce
// fichier ne la lit jamais, et scripts/process-graph.mjs ne la lira pas
// non plus. Seule l'extraction serveur (scripts/semantic-extract.mjs, sur
// le seul `text`) produit la structure qui compte. Voir le header de ce
// dernier fichier pour le raisonnement complet.
//
// Ce que CE fichier garantit encore : que `text` est bien une chaîne non
// vide, dans une longueur raisonnable, et que l'auteur n'a pas dépassé le
// quota de soumissions par jour. Rien de plus — la structuration
// sémantique et l'identité (canonical_key) sont désormais entièrement la
// responsabilité de scripts/process-graph.mjs, en aval.

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
  fail(["ISSUE_PAYLOAD_PATH manquant ou introuvable — contexte d'exécution invalide"]);
}

const { number: issueNumber, login: author, body } = JSON.parse(readFileSync(payloadPath, "utf-8"));
const reasons = [];

// 1. Ce doit être une issue de soumission SGD, pas une issue quelconque.
if (typeof body !== "string" || !body.includes(SUBMISSION_MARKER)) {
  fail(["l'issue ne contient pas le marqueur de soumission SGD"]);
}

// 2. Extraction du bloc ```json ... ``` — tout le reste du corps
// (explications, réponses citées, etc.) est ignoré.
const jsonMatch = body.match(/```json\s*([\s\S]*?)```/i);
if (!jsonMatch) {
  fail(["aucun bloc ```json``` trouvé dans le corps de l'issue"]);
}

let submitted;
try {
  submitted = JSON.parse(jsonMatch[1]);
} catch (e) {
  fail([`JSON invalide dans le bloc de soumission: ${e.message}`]);
}

// 3. La SEULE donnée qui compte : `text`. Tout le reste du JSON soumis
// (semantic, canonical_key, ou n'importe quel autre champ qu'un ancien
// client ou un attaquant aurait pu inclure) est simplement ignoré — ni lu
// ici, ni transmis à scripts/process-graph.mjs.
const text = typeof submitted.text === "string" ? submitted.text.trim() : "";

if (!text) {
  reasons.push("champ 'text' manquant ou vide");
}
if (text.length > MAX_TEXT_LENGTH) {
  reasons.push(`'text' dépasse ${MAX_TEXT_LENGTH} caractères`);
}

if (reasons.length) fail(reasons);

// 4. Rate-limit par compte GitHub. Toute issue portant le marqueur est
// labellisée AVANT ce contrôle (voir le workflow), y compris celles
// jugées invalides ensuite — pour que le spam par texte vide ou trop long
// compte aussi dans le quota, plutôt que d'offrir des essais gratuits.
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
        `limite de fréquence atteinte pour ${author}: ${data.total_count} soumissions dans les dernières 24h (max ${MAX_SUBMISSIONS_PER_DAY})`,
      ]);
    }
  } else {
    console.warn("Vérification du rate-limit ignorée (échec API):", res.status);
  }
} else {
  console.warn("Contexte d'auteur/token absent — rate-limit non vérifié (probablement un test local).");
}

// 5. Écrit le texte brut dans submissions/pending/ — nommé par numéro
// d'issue, seul identifiant stable disponible à ce stade (canonical_key
// n'existe pas encore : il sera calculé par process-graph.mjs à partir de
// CE texte, jamais avant).
if (!existsSync(PENDING_DIR)) mkdirSync(PENDING_DIR, { recursive: true });

const filename = `issue-${issueNumber}.json`;
const filePath = join(PENDING_DIR, filename);
writeFileSync(
  filePath,
  JSON.stringify(
    {
      text,
      submitted_at: new Date().toISOString(),
      source_issue: issueNumber,
      client_version: submitted.client_version || "unknown",
    },
    null,
    2
  )
);

ok(filePath);

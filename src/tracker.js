// Suivi de soumission côté client.
//
// CHANGEMENT IMPORTANT : depuis le passage à la création d'Issue via
// l'API authentifiée (src/github-api.js, createSubmissionIssue), on
// connaît le numéro d'Issue IMMÉDIATEMENT en retour de l'appel — plus
// besoin de deviner ou de chercher via l'API Search de GitHub comme
// lorsque la soumission passait par un lien externe sur lequel on
// n'avait aucune visibilité. Le suivi se réduit donc à interroger
// directement GET /issues/{number}, une lecture publique, sans
// authentification requise, avec une limite de débit bien plus généreuse
// (60/h anonyme, contre 10/min pour l'ancienne API Search).
//
// Pour le flux de repli (lien pré-rempli, utilisé quand OAuth n'est pas
// configuré — voir src/publish.js et src/app.js), le numéro d'Issue n'est
// pas connu à l'avance. Dans ce cas, l'entrée est enregistrée avec
// `number: null` et reste simplement "en attente" jusqu'à dismissal
// manuelle — pas de suivi automatique possible sans connaître l'Issue,
// ce qui est une limite assumée du flux de repli.
//
// Stockage : localStorage, PAS de compte, PAS de serveur à nous. Ça ne
// survit que dans CE navigateur ; si l'utilisateur change d'appareil, il
// perd le suivi (mais pas sa contribution : elle reste dans le graphe si
// elle a été traitée).

import { getIssueStatus, getIssueComments } from "./github-api.js";

const STORAGE_KEY = "sgd_tracked_submissions";
const MAX_TRACKED = 20;

// Extrait le canonical_key du commentaire de clôture posté par le
// workflow. Format attendu (voir .github/workflows/process-submission.yml) :
// un nœud identifié entre backticks, 32 caractères hexadécimaux.
const NODE_ID_PATTERN = /nœud `([0-9a-f]{32})`/;

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
    // Quota localStorage dépassé ou navigation privée sans persistance —
    // dégrade en silence, ce n'est qu'un confort d'UX, pas une garantie.
  }
}

// recordSubmission({ number, html_url, text, domain }): `number` est null
// pour une soumission passée par le flux de repli (lien), connu
// immédiatement pour une soumission passée par l'API directe.
export function recordSubmission({ number, html_url, text, domain }) {
  const list = readAll();
  list.unshift({
    number: number ?? null,
    issue_url: html_url ?? null,
    node_id: null, // découvert plus tard, voir refreshStatus
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

// Identifiant local stable pour une entrée : le numéro d'Issue s'il est
// connu, sinon l'horodatage d'enregistrement (unique en pratique).
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

// refreshStatus(entry): interroge directement l'Issue par son numéro. Ne
// lève jamais ; une erreur réseau laisse simplement l'entrée inchangée.
// Sans numéro connu (flux de repli, voir en-tête), il n'y a rien à
// vérifier automatiquement.
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

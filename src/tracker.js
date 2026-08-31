// Suivi de soumission côté client — répond au vrai trou du flux Issues :
// une fois l'utilisateur renvoyé sur github.com, le site n'avait jusqu'ici
// aucun moyen de savoir ce qu'il était advenu de sa proposition. On ne
// PEUT PAS savoir, depuis notre page, si l'utilisateur a réellement cliqué
// "Submit new issue" sur GitHub (rien ne nous notifie de ce qui se passe
// sur un autre domaine) — mais on peut au moins retenir localement ce
// qu'il a préparé, et interroger GitHub pour voir si une Issue
// correspondante existe et où elle en est.
//
// CHANGEMENT IMPORTANT : ce module suivait auparavant chaque soumission
// par son `canonical_key` — calculé côté client, et donc censé
// correspondre à l'id du nœud une fois accepté. Ce n'est plus le cas :
// l'extraction sémantique tourne désormais côté serveur (voir
// scripts/semantic-extract.mjs), sur son propre modèle, indépendamment de
// l'aperçu local. Le canonical_key que le client calcule pour son aperçu
// et celui que le serveur calcule pour de vrai n'ont AUCUNE raison de
// coïncider, même pour un texte identique. Le suivi utilise donc
// maintenant deux identifiants bien distincts :
//   - `ref` : un jeton généré côté client (crypto.randomUUID(), voir
//     src/app.js), sans aucun rôle protocolaire — sert uniquement à
//     retrouver l'Issue correspondante via l'API Search de GitHub.
//   - `node_id` : le VRAI canonical_key, découvert a posteriori en
//     analysant le commentaire de clôture que le workflow poste sur
//     l'Issue une fois la soumission acceptée (voir
//     .github/workflows/process-submission.yml).
//
// Stockage : localStorage, PAS de compte, PAS de serveur à nous — cohérent
// avec le reste du projet. Ça ne survit que dans CE navigateur ; si
// l'utilisateur change d'appareil, il perd le suivi (mais pas sa
// contribution : elle reste dans le graphe si elle a été traitée).
//
// Vérification de statut : API Search publique de GitHub, sans
// authentification. Deux limites à connaître, documentées ici plutôt que
// cachées :
//   - Limite de débit : 10 req/min sans authentification (contre 30 avec
//     un token). C'est pour ça qu'on ne poll PAS en boucle automatique —
//     seulement au chargement de la page et sur clic explicite d'un
//     bouton "Actualiser".
//   - La recherche full-text de GitHub sur `in:body` n'est pas un match
//     exact garanti à 100% sur tous les caractères (comportement interne
//     non documenté par GitHub) ; `ref` est un UUID, ce qui suffit en
//     pratique à éviter les faux positifs.

import { OWNER, REPO } from "./config.js";

const STORAGE_KEY = "sgd_tracked_submissions";
const MAX_TRACKED = 20;

// Extrait le canonical_key du commentaire de clôture posté par le
// workflow. Format attendu (voir process-submission.yml) : un nœud
// identifié entre backticks, 32 caractères hexadécimaux.
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

// recordSubmission(...): appelé au moment où l'utilisateur clique sur le
// lien d'ouverture d'Issue — AVANT de savoir s'il ira au bout du "Submit"
// côté GitHub. Optimiste par nécessité : on n'a aucun autre signal.
export function recordSubmission({ ref, text, domain }) {
  const list = readAll();
  list.unshift({
    ref,
    node_id: null, // découvert plus tard, voir refreshStatus
    text,
    domain,
    recorded_at: new Date().toISOString(),
    status: "pending", // pending | accepted | rejected | unknown
    issue_url: null,
    reason: null,
  });
  writeAll(list);
  return list;
}

export function getTracked() {
  return readAll();
}

export function dismissTracked(ref) {
  writeAll(readAll().filter((s) => s.ref !== ref));
}

// setStatus(ref, patch): mise à jour locale directe, sans appel réseau.
export function setStatus(ref, patch) {
  const list = readAll().map((s) => (s.ref === ref ? { ...s, ...patch } : s));
  writeAll(list);
  return list;
}

// refreshStatus(entry): interroge l'API Search de GitHub pour retrouver
// l'Issue correspondant à ce `ref`, et met à jour son statut — y compris
// `node_id`, découvert dans le commentaire de clôture si la soumission a
// été acceptée. Ne lève jamais ; une erreur réseau ou de rate-limit laisse
// simplement l'entrée inchangée.
export async function refreshStatus(entry) {
  try {
    const query = encodeURIComponent(`repo:${OWNER}/${REPO} in:body "${entry.ref}"`);
    const res = await fetch(`https://api.github.com/search/issues?q=${query}`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return entry; // rate-limited ou dépôt introuvable — on réessaiera plus tard

    const data = await res.json();
    const issue = data.items?.[0];
    if (!issue) return entry; // pas encore trouvé — le workflow n'a peut-être pas fini

    const updated = { ...entry, issue_url: issue.html_url };

    if (issue.state === "open") {
      updated.status = "pending";
    } else if (issue.state_reason === "completed") {
      updated.status = "accepted";
      updated.node_id = await fetchAcceptedNodeId(issue.number);
    } else if (issue.state_reason === "not_planned") {
      updated.status = "rejected";
      updated.reason = await fetchRejectionReason(issue.number);
    } else {
      updated.status = "unknown";
    }

    const list = readAll().map((s) => (s.ref === entry.ref ? updated : s));
    writeAll(list);
    return updated;
  } catch {
    return entry;
  }
}

// Va chercher le VRAI canonical_key dans le commentaire de clôture d'une
// Issue acceptée — c'est la seule façon pour le client de connaître
// l'identité que le serveur a effectivement attribuée à sa soumission,
// puisqu'il ne la calcule plus lui-même.
async function fetchAcceptedNodeId(issueNumber) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/issues/${issueNumber}/comments`,
      { headers: { Accept: "application/vnd.github+json" } }
    );
    if (!res.ok) return null;
    const comments = await res.json();
    const last = comments[comments.length - 1];
    const match = last?.body?.match(NODE_ID_PATTERN);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// Va chercher le dernier commentaire du bot sur une Issue rejetée, pour
// afficher la vraie raison plutôt qu'un simple "rejetée". Un seul appel
// API supplémentaire, uniquement pour les cas rejetés — pas pour tout le
// monde, par respect de la limite de débit non authentifiée.
async function fetchRejectionReason(issueNumber) {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/issues/${issueNumber}/comments`,
      { headers: { Accept: "application/vnd.github+json" } }
    );
    if (!res.ok) return null;
    const comments = await res.json();
    const last = comments[comments.length - 1];
    return last?.body || null;
  } catch {
    return null;
  }
}

export async function refreshAllPending() {
  const list = readAll();
  const pending = list.filter((s) => s.status === "pending" || s.status === "unknown");
  for (const entry of pending) {
    await refreshStatus(entry);
  }
  return readAll();
}

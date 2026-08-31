// Suivi de soumission côté client — répond au vrai trou du flux Issues :
// une fois l'utilisateur renvoyé sur github.com, le site n'avait jusqu'ici
// aucun moyen de savoir ce qu'il était advenu de sa proposition. On ne
// PEUT PAS savoir, depuis notre page, si l'utilisateur a réellement cliqué
// "Submit new issue" sur GitHub (rien ne nous notifie de ce qui se passe
// sur un autre domaine) — mais on peut au moins retenir localement ce
// qu'il a préparé, et interroger GitHub pour voir si une Issue
// correspondante existe et où elle en est.
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
//     non documenté par GitHub) ; canonical_key fait 32 caractères hex,
//     ce qui suffit en pratique à éviter les faux positifs.

import { OWNER, REPO } from "./config.js";

const STORAGE_KEY = "sgd_tracked_submissions";
const MAX_TRACKED = 20;

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
export function recordSubmission({ key, text, domain }) {
  const list = readAll();
  list.unshift({
    key,
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

export function dismissTracked(key) {
  writeAll(readAll().filter((s) => s.key !== key));
}

// setStatus(key, patch): mise à jour locale directe, sans appel réseau —
// utilisée par app.js pour marquer une soumission "accepted" dès que
// data/graph.json (rechargé au démarrage) contient déjà son
// canonical_key. C'est plus rapide et plus fiable que d'attendre
// l'indexation de la recherche GitHub, une fois que le déploiement
// GitHub Pages a réellement eu lieu.
export function setStatus(key, patch) {
  const list = readAll().map((s) => (s.key === key ? { ...s, ...patch } : s));
  writeAll(list);
  return list;
}

// refreshStatus(entry): interroge l'API Search de GitHub pour retrouver
// l'Issue correspondant à ce canonical_key, et met à jour son statut.
// Retourne l'entrée mise à jour ; ne lève jamais — une erreur réseau ou de
// rate-limit laisse simplement le statut "pending" inchangé.
export async function refreshStatus(entry) {
  try {
    const query = encodeURIComponent(`repo:${OWNER}/${REPO} in:body "${entry.key}"`);
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
    } else if (issue.state_reason === "not_planned") {
      updated.status = "rejected";
      updated.reason = await fetchRejectionReason(issue.number);
    } else {
      updated.status = "unknown";
    }

    const list = readAll().map((s) => (s.key === entry.key ? updated : s));
    writeAll(list);
    return updated;
  } catch {
    return entry;
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

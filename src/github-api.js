// Appels DIRECTS à l'API GitHub — api.github.com supporte CORS nativement
// pour les requêtes authentifiées (Access-Control-Allow-Origin: *,
// vérifié par un appel OPTIONS réel). Aucun relais nécessaire ici,
// contrairement aux deux endpoints d'échange OAuth (voir src/oauth.js) :
// une fois le token obtenu, tout le reste passe en fetch() ordinaire,
// directement depuis le navigateur.

import { OWNER, REPO } from "./config.js";

const SUBMISSION_MARKER = "<!-- sgd:submission:v1 -->";

export class GitHubApiError extends Error {}

// createSubmissionIssue(token, { text, ref }) -> { number, html_url }
//
// Ouvre l'Issue directement via l'API, sans jamais rediriger l'utilisateur
// vers github.com — c'est la différence concrète avec l'ancien flux "lien
// pré-rempli". `ref` n'a toujours aucun rôle protocolaire (voir
// scripts/validate-submission.mjs, qui n'a jamais lu que `text`) — gardé
// par cohérence, même si sa raison d'être initiale (retrouver l'issue via
// l'API Search) est moins nécessaire maintenant qu'on connaît le numéro
// d'issue immédiatement en retour de cet appel.
export async function createSubmissionIssue(token, { text, ref }) {
  const payload = {
    text,
    ref,
    submitted_at: new Date().toISOString(),
    client_version: "4.0.0",
  };

  const body = [
    SUBMISSION_MARKER,
    "",
    "Cette Issue a été créée automatiquement par l'interface SGD, via l'API",
    "GitHub authentifiée par votre compte — vous n'avez rien eu à faire sur",
    "github.com pour cette soumission précise. Seul le champ `text`",
    "ci-dessous est utilisé : la structure sémantique et l'identité de",
    "cette proposition sont entièrement recalculées côté serveur, à partir",
    "de ce texte seul.",
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
    throw new GitHubApiError(err.message || `Échec de création de l'Issue (HTTP ${res.status})`);
  }

  const issue = await res.json();
  return { number: issue.number, html_url: issue.html_url };
}

// getIssueStatus(number) -> objet Issue complet (state, state_reason, ...)
// Pas besoin de token pour lire une Issue publique — appel anonyme,
// suffisant et qui n'entame pas le quota du token de l'utilisateur.
export async function getIssueStatus(number) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/issues/${number}`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new GitHubApiError(`Échec de lecture de l'Issue #${number} (HTTP ${res.status})`);
  return res.json();
}

// getIssueComments(number) -> liste de commentaires (jamais levée : une
// erreur réseau retourne juste une liste vide, le suivi reste dégradé
// plutôt que cassé).
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

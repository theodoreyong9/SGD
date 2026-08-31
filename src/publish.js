// Publication via une Issue GitHub pré-remplie — pas d'OAuth, pas de relais
// CORS, pas de fork/PR.
//
// POURQUOI : `github.com/OWNER/REPO/issues/new?title=...&body=...` est un
// LIEN, pas un appel fetch(). La navigation classique n'est jamais soumise
// à CORS (CORS ne s'applique qu'aux requêtes JS cross-origin). L'utilisateur
// clique, arrive sur github.com déjà connecté à SON PROPRE compte, relit le
// formulaire pré-rempli, et clique lui-même sur "Submit new issue".
//
// Ce clic supplémentaire sur le domaine github.com n'est pas qu'une
// contrainte technique : c'est une confirmation humaine native, sur un
// domaine qu'aucune page tierce ne peut simuler par script. C'est un
// meilleur signal anti-automatisation qu'un POST programmatique déclenché
// depuis notre propre page ne pourrait jamais l'être.
//
// Ce que ça élimine par construction, comparé à la version précédente :
//   - aucune GitHub OAuth App à créer/configurer
//   - aucun relais CORS à déployer (proxy/worker.js n'existe plus)
//   - aucun token, d'aucune sorte, ne transite par le navigateur
//   - aucun fork ni PR à gérer côté client
//
// Ce que ça NE garantit PAS (voir scripts/validate-submission.mjs) : le
// corps de l'Issue reste du texte que N'IMPORTE QUI peut modifier avant de
// cliquer "Submit", ou falsifier via l'API avec son propre token. C'est
// pour ça que le serveur ne fait plus confiance à AUCUN champ structuré de
// ce payload — voir la note sur `text` ci-dessous.

import { OWNER, REPO } from "./config.js";

// Marqueur invisible utilisé par le workflow pour distinguer une Issue de
// soumission SGD de n'importe quelle autre Issue ouverte sur le dépôt
// (bug report, question, etc.) — plus robuste qu'un label, qui pourrait ne
// pas encore exister sur un dépôt tout neuf.
export const SUBMISSION_MARKER = "<!-- sgd:submission:v1 -->";

// Limite prudente : au-delà, certains proxys/serveurs tronquent les URL
// très longues avant même qu'elles n'atteignent GitHub.
const MAX_URL_LENGTH = 7500;

export class SubmissionTooLargeError extends Error {}

// buildSubmissionIssueUrl({ text, ref }) -> string (URL complète)
//
// CHANGEMENT IMPORTANT : ce payload ne contient plus `semantic` ni
// `canonical_key`. Jusqu'ici, le navigateur envoyait le résultat de sa
// propre extraction WebLLM, et le serveur se contentait de revérifier le
// hash — ce qui protégeait contre un hash falsifié, mais pas contre un
// bloc `semantic` construit à la main, sans rapport réel avec `text`, tout
// en restant interne-cohérent. Envoyer encore ce bloc n'aurait plus aucun
// effet : scripts/validate-submission.mjs et scripts/process-graph.mjs ne
// le lisent plus du tout. `text` est désormais la SEULE donnée qui compte
// — c'est le serveur qui en extrait sa propre structure faisant autorité
// (voir scripts/semantic-extract.mjs).
//
// `ref` est un identifiant généré côté client (voir src/app.js,
// crypto.randomUUID()), sans AUCUN rôle protocolaire — il ne sert qu'à
// retrouver cette Issue plus tard via l'API Search de GitHub, pour le
// suivi affiché dans "Vos soumissions" (src/tracker.js). Le remplacer ou
// le supprimer ne change rien à ce qui est accepté ou rejeté.
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
    "Cette Issue a été pré-remplie automatiquement par l'interface SGD.",
    "Seul le champ `text` ci-dessous est utilisé : la structure sémantique",
    "et l'identité de cette proposition sont entièrement recalculées côté",
    "serveur, à partir de ce texte seul — rien d'autre dans ce bloc n'est",
    "lu ni fait confiance.",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n");

  const params = new URLSearchParams({ title, body, labels: "sgd-submission" });
  const url = `https://github.com/${OWNER}/${REPO}/issues/new?${params.toString()}`;

  if (url.length > MAX_URL_LENGTH) {
    throw new SubmissionTooLargeError(
      "Cette proposition est trop longue pour le lien de soumission. Raccourcissez le texte."
    );
  }

  return url;
}

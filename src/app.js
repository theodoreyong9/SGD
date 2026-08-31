import { createGraphRenderer } from "./graph-render.js";
import { parseWithAI, isWebGPUAvailable, isModelLoaded } from "./semantic.js";
import { embed, textForEmbedding, cosineSimilarity } from "./embeddings.js";
import { synthesizeSubgraph } from "./synthesis.js";
import { buildSubmissionIssueUrl, SubmissionTooLargeError } from "./publish.js";
import { recordSubmission, getTracked, refreshStatus, dismissTracked } from "./tracker.js";
import { isOAuthConfigured } from "./config.js";
import {
  getStoredToken,
  isTokenValid,
  clearStoredToken,
  startDeviceFlow,
  DeviceFlowError,
} from "./oauth.js";
import { createSubmissionIssue, GitHubApiError } from "./github-api.js";

const canvas = document.getElementById("graph-canvas");
const renderer = createGraphRenderer(canvas);

const form = document.getElementById("submit-form");
const input = document.getElementById("submit-input");
const submitButton = document.getElementById("submit-button");
const searchButton = document.getElementById("search-button");
const statusLine = document.getElementById("status-line");
const publishPanel = document.getElementById("publish-panel");
const publishCopy = document.getElementById("publish-copy");
const publishButton = document.getElementById("publish-button");
const publishLink = document.getElementById("publish-link");
const publishStatus = document.getElementById("publish-status");
const deviceFlowBox = document.getElementById("device-flow-box");
const deviceCodeEl = document.getElementById("device-code");
const deviceLink = document.getElementById("device-link");
const resultPanel = document.getElementById("result-panel");
const resultDomain = document.getElementById("result-domain");
const resultConcepts = document.getElementById("result-concepts");
const resultRelations = document.getElementById("result-relations");
const resultClose = document.getElementById("result-close");
const resultBack = document.getElementById("result-back");
const nodeCountEl = document.getElementById("node-count");
const edgeCountEl = document.getElementById("edge-count");
const trackerPanel = document.getElementById("tracker-panel");
const trackerList = document.getElementById("tracker-list");
const searchPanel = document.getElementById("search-panel");
const searchList = document.getElementById("search-list");
const searchClose = document.getElementById("search-close");
const authPill = document.getElementById("auth-pill");
const authStatusText = document.getElementById("auth-status-text");
const authDisconnect = document.getElementById("auth-disconnect");
const toastEl = document.getElementById("toast");

let graph = { nodes: [], edges: [] };
let lastParsed = null; // { text, semantic } — aperçu local uniquement, non-autoritaire
let authToken = null; // token valide en mémoire, une fois vérifié

// --- Authentification (voir src/oauth.js, src/github-api.js) ---
// Trois états possibles, gérés ici :
//   1. OAuth non configuré (placeholders dans src/config.js) -> flux de
//      repli par lien uniquement (comportement historique).
//   2. OAuth configuré, pas encore de token valide -> le premier clic sur
//      "Publier" démarre le Device Flow.
//   3. Token valide en mémoire -> publication directe, invisible.
async function initAuth() {
  if (!isOAuthConfigured()) {
    authPill.classList.add("hidden");
    return;
  }
  authPill.classList.remove("hidden");

  const stored = getStoredToken();
  if (stored && (await isTokenValid(stored))) {
    authToken = stored;
    authStatusText.textContent = "Connecté à GitHub — publication automatique";
    authDisconnect.classList.remove("hidden");
  } else {
    authToken = null;
    authStatusText.textContent = "Non connecté — la publication ouvrira une autorisation GitHub";
    authDisconnect.classList.add("hidden");
  }
}

authDisconnect.addEventListener("click", () => {
  clearStoredToken();
  authToken = null;
  authStatusText.textContent = "Non connecté — la publication ouvrira une autorisation GitHub";
  authDisconnect.classList.add("hidden");
});

async function loadGraph() {
  const res = await fetch("data/graph.json", { cache: "no-store" });
  graph = await res.json();
  renderer.setData(graph);
  nodeCountEl.textContent = graph.nodes.length;
  edgeCountEl.textContent = graph.edges.length;
  reconcileTrackedWithGraph();
}

// Une fois qu'une soumission suivie a un `node_id` connu (voir
// src/tracker.js — découvert en lisant le commentaire de clôture posté
// sur l'Issue, PAS deviné côté client), on vérifie s'il apparaît dans le
// graphe fraîchement rechargé et on met en évidence le nœud correspondant
// — pas besoin de relancer une recherche manuelle pour voir sa propre
// contribution apparaître.
function reconcileTrackedWithGraph() {
  for (const t of getTracked()) {
    if (!t.node_id) continue;
    const node = graph.nodes.find((n) => n.id === t.node_id);
    if (node) {
      renderer.setHighlight(node.id);
      break; // on ne met en évidence que la plus récente trouvée
    }
  }
}

// setStatus/setPublishStatus : affichent toujours un petit spinner animé
// tant qu'un message est présent — plus jamais de texte figé qui donne
// l'impression que l'interface est bloquée pendant un traitement en
// cours (chargement de modèle, génération, attente du bot GitHub).
// spinning=false permet d'afficher un message final sans spinner (ex:
// une erreur, qui n'est plus "en cours").
function setStatus(msg, spinning = Boolean(msg)) {
  statusLine.innerHTML = msg
    ? `${spinning ? '<span class="spinner" aria-hidden="true"></span>' : ""}<span>${escapeHtml(msg)}</span>`
    : "";
}

function setPublishStatus(msg, spinning = Boolean(msg)) {
  publishStatus.innerHTML = msg
    ? `${spinning ? '<span class="spinner" aria-hidden="true"></span>' : ""}<span>${escapeHtml(msg)}</span>`
    : "";
}

let toastTimer = null;
function showToast(msg, duration = 4000) {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.classList.add("toast-visible");
  toastTimer = setTimeout(() => toastEl.classList.remove("toast-visible"), duration);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// pollUntilResolved(entry): sondage en arrière-plan, sans jamais exiger de
// recharger la page manuellement. Vérifie immédiatement, puis avec un
// intervalle croissant (10s → 60s max) jusqu'à résolution ou abandon après
// ~40 tentatives (~30 minutes). Uniquement possible pour les soumissions
// dont le numéro d'Issue est connu (flux direct par API) — le flux de
// repli par lien ne permet pas de savoir quand l'Issue a réellement été
// créée sur GitHub, donc rien à sonder automatiquement dans ce cas.
async function pollUntilResolved(entry) {
  const maxAttempts = 40;
  let delay = 10000;

  for (let i = 0; i < maxAttempts; i++) {
    const updated = await refreshStatus(entry);

    if (updated.status === "accepted") {
      await loadGraph();
      renderTracker();
      showToast("Mise à jour effectuée ✓");
      const node = graph.nodes.find((n) => n.id === updated.node_id);
      if (node) showNodeDetail(node);
      return;
    }
    if (updated.status === "rejected") {
      renderTracker();
      showToast(updated.reason ? "Soumission rejetée — voir « Vos soumissions »" : "Soumission rejetée");
      return;
    }

    entry = updated;
    await sleep(delay);
    delay = Math.min(delay * 1.3, 60000);
  }
}

// showNodeDetail(node): fiche complète d'un nœud EXISTANT du graphe —
// domaine, concepts, relations, et décomposition de l'influence
// (novelty/contribution/bridge/stability), exactement comme après
// "Envoyer". Utilisé à deux endroits : automatiquement quand une
// soumission suivie est acceptée (voir pollUntilResolved), et quand on
// clique un résultat du panneau "Rechercher" — dans les deux cas, voir un
// simple pourcentage de similarité sans le reste n'a pas de sens, ce
// nœud existe déjà pleinement dans le graphe, ses vraies statistiques
// aussi.
// Cache de synthèse par domaine — voir renderSynthesisSection() ci-dessous
// pour le raisonnement complet. Clé: domaine, valeur: { text, count }.
// `count` (nombre de nœuds du domaine au moment du calcul) sert à savoir
// si le cache est encore à jour ou s'il faut regénérer.
const synthesisCache = new Map();

// renderSynthesisSection(domain) -> HTML (placeholder ou texte en cache)
//
// CHANGEMENT IMPORTANT : la synthèse est maintenant automatique et
// systématique (elle se déclenche toute seule dès qu'un domaine a 2+
// propositions, plus besoin de cliquer un bouton) — mais elle reste
// délibérément un TEXTE, jamais un NŒUD DU GRAPHE. Ce n'est pas un détail
// technique : c'est le principe fondateur du projet ("l'IA ne devient
// jamais une source de vérité, seulement un outil de lecture" — voir
// README, doctrine "Séparation IA / protocole"). En faire un nœud
// recherchable signifierait lui donner un canonical_key, une influence,
// une place dans le graphe — comme si l'IA avait "participé" au même
// titre qu'une vraie personne. C'est exactement ce que le projet a été
// conçu pour éviter.
//
// Ce qui est fait à la place, pour répondre au vrai problème ("le texte
// disparaît") sans franchir cette ligne : mise en cache PAR DOMAINE, en
// mémoire, pour la durée de la session. Revisiter n'importe quel nœud
// d'un même domaine (recherche, clic sur le graphe, ou après une
// soumission acceptée) réaffiche la MÊME synthèse instantanément, sans
// la recalculer — elle ne "disparaît" donc plus tant que la page reste
// ouverte. Elle n'est simplement jamais écrite dans data/graph.json.
function renderSynthesisSection(domain) {
  const domainNodes = graph.nodes.filter((n) => n.semantic.domain === domain);
  if (domainNodes.length < 2) return "";

  const cached = synthesisCache.get(domain);
  if (cached && cached.count === domainNodes.length) {
    return `<div class="synth-output">${escapeHtml(cached.text)}</div>`;
  }
  return `<div id="synth-live" class="synth-output"><span class="spinner spinner-sm" aria-hidden="true"></span> Synthèse du domaine « ${escapeHtml(domain)} » en cours…</div>`;
}

// À appeler juste après avoir inséré renderSynthesisSection() dans le DOM
// — calcule réellement la synthèse si elle n'était pas déjà en cache, et
// met à jour l'élément en place une fois prête. Ne fait rien si un appel
// concurrent a déjà rempli le cache entre-temps (ex: deux nœuds du même
// domaine consultés coup sur coup).
async function ensureDomainSynthesis(domain) {
  const domainNodes = graph.nodes.filter((n) => n.semantic.domain === domain);
  if (domainNodes.length < 2) return;

  const cached = synthesisCache.get(domain);
  if (cached && cached.count === domainNodes.length) return;

  try {
    const text = await synthesizeSubgraph(domainNodes);
    synthesisCache.set(domain, { text, count: domainNodes.length });
    const live = document.getElementById("synth-live");
    if (live) live.textContent = text;
  } catch (err) {
    const live = document.getElementById("synth-live");
    if (live) live.textContent = `Synthèse indisponible: ${err.message}`;
  }
}

// showNodeDetail(node, opts): fiche complète d'un nœud EXISTANT du graphe
// — domaine, concepts, relations, décomposition de l'influence, et
// synthèse du domaine — exactement comme après "Envoyer". Utilisé à
// trois endroits : automatiquement quand une
// soumission suivie est acceptée (pollUntilResolved), quand on clique un
// résultat du panneau "Rechercher" (fromSearch: true, affiche le bouton
// retour), et quand on clique un point directement dans le graphe. Dans
// tous les cas, voir un simple pourcentage de similarité sans le reste
// n'a pas de sens : ce nœud existe déjà pleinement dans le graphe, ses
// vraies statistiques aussi.
function showNodeDetail(node, { fromSearch = false } = {}) {
  searchPanel.classList.add("hidden");
  publishPanel.classList.add("hidden");
  resultBack.classList.toggle("hidden", !fromSearch);

  resultDomain.textContent = node.semantic.domain;
  resultConcepts.innerHTML = (node.semantic.concepts || [])
    .map((c) => `<span>${escapeHtml(c)}</span>`)
    .join("");

  const lines = (node.semantic.relations || []).map(
    (rel) => `→ ${rel.type.replace(/_/g, " ")} : ${escapeHtml(rel.target_hint)}`
  );
  resultRelations.innerHTML =
    lines.map((l) => `<div>${l}</div>`).join("") +
    renderBreakdown(node) +
    renderSynthesisSection(node.semantic.domain);

  resultPanel.classList.remove("hidden");
  renderer.setHighlight(node.id);
  ensureDomainSynthesis(node.semantic.domain);
}

// Real embedding similarity for the live preview (mirrors scripts/embeddings.mjs
// server-side; see src/embeddings.js for why this copy is UX-only, not authoritative).
async function findClosestNode(semantic) {
  if (graph.nodes.length === 0) return { node: null, similarity: 0 };
  const queryEmbedding = await embed(textForEmbedding(semantic));
  let best = null;
  let bestScore = 0;
  for (const n of graph.nodes) {
    if (!n.embedding) continue;
    const score = cosineSimilarity(queryEmbedding, n.embedding);
    if (score > bestScore) {
      bestScore = score;
      best = n;
    }
  }
  return { node: best, similarity: bestScore };
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

// runSearch : consultation pure du graphe, sans passer par WebLLM ni
// préparer une soumission. Recherche = navigation, distincte de proposer
// — le bouton "Rechercher" utilise seulement le petit modèle d'embeddings
// (src/embeddings.js, WASM), pas le modèle génératif plus lourd chargé
// par "Envoyer" (src/semantic.js, WebGPU). On embed directement le texte
// brut de la requête, sans extraction de concepts/objectif/moyen : pour
// juste "aller voir ce qu'il y a", la structuration complète est un coût
// inutile.
async function runSearch() {
  const text = input.value.trim();
  if (!text) return;

  resultPanel.classList.add("hidden");
  publishPanel.classList.add("hidden");
  searchButton.disabled = true;
  setStatus("Recherche dans le graphe…");

  try {
    if (graph.nodes.length === 0) {
      renderSearchResults([], text);
      return;
    }
    const queryEmbedding = await embed(text);
    const ranked = graph.nodes
      .filter((n) => n.embedding)
      .map((n) => ({ node: n, similarity: cosineSimilarity(queryEmbedding, n.embedding) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 8);
    renderSearchResults(ranked, text);
  } catch (err) {
    console.error(err);
    setStatus(`Erreur de recherche: ${err.message}`);
  } finally {
    searchButton.disabled = false;
    setStatus("");
  }
}

let lastSearchRanked = null;
let lastSearchQuery = null;

function renderSearchResults(ranked, query) {
  lastSearchRanked = ranked;
  lastSearchQuery = query;
  searchPanel.classList.remove("hidden");
  if (ranked.length === 0) {
    searchList.innerHTML = `<li class="search-empty">Rien dans le graphe pour « ${escapeHtml(query)} » pour l'instant.</li>`;
    return;
  }
  searchList.innerHTML = ranked
    .map(
      ({ node, similarity }) => `
        <li class="search-item" data-key="${node.id}">
          <span class="search-similarity">${Math.round(similarity * 100)}%</span>
          <span class="search-text">${escapeHtml(truncate(node.text, 70))}</span>
        </li>`
    )
    .join("");
}

searchList.addEventListener("click", (e) => {
  const key = e.target.closest(".search-item")?.dataset.key;
  const node = graph.nodes.find((n) => n.id === key);
  if (node) showNodeDetail(node, { fromSearch: true });
});

resultBack.addEventListener("click", () => {
  resultPanel.classList.add("hidden");
  if (lastSearchRanked) renderSearchResults(lastSearchRanked, lastSearchQuery);
});

searchButton.addEventListener("click", runSearch);

searchClose.addEventListener("click", () => {
  searchPanel.classList.add("hidden");
});

function renderBreakdown(node) {
  if (!node?.stats?.breakdown) return "";
  const b = node.stats.breakdown;
  const rows = [
    ["Nouveauté", b.novelty],
    ["Répétition (décroissante)", b.contribution],
    ["Pont sémantique", b.bridge],
    ["Stabilité (persistance + usage)", b.stability],
  ];
  const bars = rows
    .map(
      ([label, val]) =>
        `<div class="breakdown-row">
           <span class="breakdown-label">${label}</span>
           <span class="breakdown-bar"><span style="width:${Math.min(100, val * 2.5)}%"></span></span>
           <span class="breakdown-val">${val}</span>
         </div>`
    )
    .join("");
  return `<div class="breakdown"><div class="breakdown-total">Influence : ${b.influence}</div>${bars}</div>`;
}

async function showResult({ semantic }) {
  resultBack.classList.add("hidden"); // aperçu de soumission, jamais "depuis la recherche"
  const { node: closest, similarity } = await findClosestNode(semantic);

  resultDomain.textContent = semantic.domain;
  resultConcepts.innerHTML = semantic.concepts
    .map((c) => `<span>${escapeHtml(c)}</span>`)
    .join("");

  const lines = [];
  let breakdownNode = null;

  // Il n'y a plus de "correspondance exacte" à afficher ici : l'extraction
  // qui fait autorité tourne côté serveur (scripts/semantic-extract.mjs),
  // indépendamment de celle-ci. Seule la proximité par embedding reste un
  // signal valide, puisqu'elle porte sur le contenu réel, pas sur une
  // égalité structurelle entre deux extractions indépendantes.
  if (closest && similarity > 0.5) {
    lines.push(
      `Idée proche à ${Math.round(similarity * 100)}% (par similarité sémantique, pas par mots-clés) d'une proposition existante : « ${escapeHtml(
        closest.text
      )} ». Aperçu local — l'extraction qui décidera réellement de la position de votre proposition dans le graphe se fait côté serveur, une fois publiée.`
    );
    renderer.setHighlight(closest.id);
    breakdownNode = closest;
  } else {
    lines.push("Aucune proposition proche trouvée dans cet aperçu — ceci pourrait introduire une idée nouvelle dans le graphe.");
    renderer.setHighlight(null);
  }

  for (const rel of semantic.relations || []) {
    lines.push(`→ ${rel.type.replace(/_/g, " ")} : ${escapeHtml(rel.target_hint)}`);
  }

  resultRelations.innerHTML =
    lines.map((l) => `<div>${l}</div>`).join("") +
    renderBreakdown(breakdownNode) +
    renderSynthesisSection(semantic.domain);

  resultPanel.classList.remove("hidden");
  setupPublishPanel();
  ensureDomainSynthesis(semantic.domain);
}

// setupPublishPanel(): configure le panneau de publication selon l'état
// d'authentification courant. Un seul bouton visible à la fois, jamais
// les deux formes en même temps.
function setupPublishPanel() {
  deviceFlowBox.classList.add("hidden");
  setPublishStatus("");

  if (!isOAuthConfigured()) {
    // Repli historique : lien pré-rempli, ouvre GitHub. Voir README.
    try {
      const ref = crypto.randomUUID();
      const url = buildSubmissionIssueUrl({ text: lastParsed.text, ref });
      publishCopy.textContent =
        "Vous allez ouvrir une Issue GitHub pré-remplie sur votre propre compte : relisez-la, puis cliquez « Submit new issue » sur GitHub pour publier réellement — revenez ensuite ici, cet onglet suit automatiquement le traitement.";
      publishLink.href = url;
      publishLink.classList.remove("hidden");
      publishButton.classList.add("hidden");
      publishLink.onclick = () => {
        recordSubmission({ number: null, html_url: null, text: lastParsed.text, domain: lastParsed.semantic.domain });
        setPublishStatus("Enregistrée dans « Vos soumissions » — cliquez « Submit new issue » sur GitHub pour la publier réellement.", false);
        renderTracker();
      };
      publishPanel.classList.remove("hidden");
    } catch (err) {
      if (err instanceof SubmissionTooLargeError) {
        setStatus(err.message, false);
        publishPanel.classList.add("hidden");
      } else {
        throw err;
      }
    }
    return;
  }

  // OAuth configuré : bouton unique, comportement adaptatif.
  publishLink.classList.add("hidden");
  publishButton.classList.remove("hidden");
  publishButton.disabled = false;
  publishCopy.textContent = authToken
    ? "Publication directe et automatique — aucun onglet GitHub ne s'ouvrira."
    : "Une autorisation GitHub unique est nécessaire avant la première publication (valable pour toutes les suivantes, dans ce navigateur).";
  publishButton.textContent = authToken ? "Publier" : "Se connecter et publier";
  publishButton.onclick = () => publishDirectly();
  publishPanel.classList.remove("hidden");
}

// publishDirectly(): chemin principal quand OAuth est configuré. Démarre
// le Device Flow si nécessaire (une fois), puis crée l'Issue via l'API —
// aucune redirection vers github.com pour l'acte de soumission lui-même.
async function publishDirectly() {
  publishButton.disabled = true;

  try {
    if (!authToken) {
      setPublishStatus("Ouverture de l'autorisation GitHub…");
      authToken = await startDeviceFlow(({ userCode, verificationUri }) => {
        deviceFlowBox.classList.remove("hidden");
        deviceCodeEl.textContent = userCode;
        deviceLink.href = verificationUri;
        window.open(verificationUri, "_blank", "noopener");
        setPublishStatus("En attente de votre autorisation sur GitHub…");
      });
      deviceFlowBox.classList.add("hidden");
      authStatusText.textContent = "Connecté à GitHub — publication automatique";
      authDisconnect.classList.remove("hidden");
      publishButton.textContent = "Publier";
      publishCopy.textContent = "Publication directe et automatique — aucun onglet GitHub ne s'ouvrira.";
    }

    setPublishStatus("Publication en cours…");
    const ref = crypto.randomUUID();
    const issue = await createSubmissionIssue(authToken, { text: lastParsed.text, ref });

    const list = recordSubmission({
      number: issue.number,
      html_url: issue.html_url,
      text: lastParsed.text,
      domain: lastParsed.semantic.domain,
    });
    renderTracker();
    // Le spinner continue de tourner ici : le traitement GitHub n'est pas
    // fini, seul l'envoi l'est. pollUntilResolved efface ce message (et
    // affiche le toast) une fois la vraie résolution connue — jamais de
    // texte figé pendant que ça travaille encore en arrière-plan.
    setPublishStatus("En cours de traitement par GitHub…");
    pollUntilResolved(list[0]);
  } catch (err) {
    console.error(err);
    if (err instanceof DeviceFlowError || err instanceof GitHubApiError) {
      setPublishStatus(`Erreur: ${err.message}`, false);
    } else {
      setPublishStatus(`Erreur inattendue: ${err.message}`, false);
    }
  } finally {
    publishButton.disabled = false;
  }
}

const STATUS_LABELS = {
  pending: "En attente sur GitHub",
  accepted: "Intégrée au graphe ✓",
  rejected: "Rejetée ✕",
  unknown: "Statut inconnu",
};

function renderTracker() {
  const tracked = getTracked();
  if (tracked.length === 0) {
    trackerPanel.classList.add("hidden");
    return;
  }
  trackerPanel.classList.remove("hidden");
  trackerList.innerHTML = tracked
    .map((t) => {
      const id = t.number ?? t.recorded_at;
      const reasonLine =
        t.status === "rejected" && t.reason
          ? `<div class="tracker-reason">${escapeHtml(t.reason)}</div>`
          : "";
      const link = t.issue_url
        ? `<a href="${t.issue_url}" target="_blank" rel="noopener" class="tracker-link">Voir l'issue →</a>`
        : "";
      // Spinner uniquement pour les états encore ouverts — une fois
      // accepté ou rejeté, il n'y a plus rien "en cours" à signaler ici.
      const isActive = t.status === "pending" || t.status === "unknown";
      const spinner = isActive ? '<span class="spinner spinner-sm" aria-hidden="true"></span>' : "";
      return `
        <li class="tracker-item tracker-${t.status}">
          <div class="tracker-text">${escapeHtml(truncate(t.text, 60))}</div>
          <div class="tracker-status">${spinner}${STATUS_LABELS[t.status] || t.status}</div>
          ${reasonLine}
          ${link}
          <button class="tracker-dismiss" data-id="${id}" aria-label="Retirer du suivi">✕</button>
        </li>`;
    })
    .join("");
}

trackerList.addEventListener("click", (e) => {
  const id = e.target.closest(".tracker-dismiss")?.dataset.id;
  if (id) {
    dismissTracked(id);
    renderTracker();
  }
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  submitButton.disabled = true;
  resultPanel.classList.add("hidden");
  publishPanel.classList.add("hidden");
  searchPanel.classList.add("hidden");
  publishStatus.textContent = "";

  try {
    if (!isWebGPUAvailable()) {
      setStatus("WebGPU indisponible sur ce navigateur — l'analyse sémantique locale ne peut pas tourner ici.", false);
      return;
    }

    setStatus(isModelLoaded() ? "Analyse de votre texte…" : "Chargement du modèle local…");
    const semantic = await parseWithAI(text, (report) => {
      const progress = typeof report?.progress === "number" ? report.progress : 0;
      if (progress < 1) {
        setStatus(`Chargement du modèle local… ${Math.round(progress * 100)}%`);
      } else {
        // Le callback de progression de WebLLM ne couvre que le
        // CHARGEMENT du modèle — une fois à 100%, plus aucun événement ne
        // survient pendant la génération elle-même. Sans ce changement de
        // texte, le dernier message de chargement (souvent illisible,
        // type "Finish loading on WebGPU - amd") resterait figé à
        // l'écran pendant toute la génération, comme si l'app était
        // bloquée — le spinner continue de tourner, mais le texte doit
        // changer de phase pour rester honnête sur ce qui se passe.
        setStatus("Analyse de votre texte…");
      }
    });
    lastParsed = { text, semantic };

    // Le spinner continue de tourner : showResult() fait encore une
    // recherche par embedding avant d'afficher le résultat et le bouton
    // "Publier" — pas d'interruption visuelle entre la génération et
    // l'apparition du résultat.
    setStatus("Recherche dans le graphe…");
    await showResult(lastParsed);
    setStatus("");
  } catch (err) {
    console.error(err);
    setStatus(`Erreur: ${err.message}`, false);
  } finally {
    submitButton.disabled = false;
  }
});

resultClose.addEventListener("click", () => {
  resultPanel.classList.add("hidden");
  publishPanel.classList.add("hidden");
  renderer.setHighlight(null);
});

// --- Cliquer un nœud dans le graphe ouvre sa fiche complète ---
renderer.onNodeClick((node) => {
  if (!node) return;
  showNodeDetail(node);
});

renderTracker();
initAuth();
loadGraph().then(() => {
  reconcileTrackedWithGraph();
  renderTracker();
  for (const t of getTracked()) {
    if (t.number && (t.status === "pending" || t.status === "unknown")) {
      pollUntilResolved(t);
    }
  }
});

import { createGraphRenderer } from "./graph-render.js";
import { parseWithAI, canonicalKey, isWebGPUAvailable } from "./semantic.js";
import { embed, textForEmbedding, cosineSimilarity } from "./embeddings.js";
import { synthesizeSubgraph } from "./synthesis.js";
import { buildSubmissionIssueUrl, SubmissionTooLargeError } from "./publish.js";

const canvas = document.getElementById("graph-canvas");
const renderer = createGraphRenderer(canvas);

const form = document.getElementById("submit-form");
const input = document.getElementById("submit-input");
const submitButton = document.getElementById("submit-button");
const statusLine = document.getElementById("status-line");
const publishPanel = document.getElementById("publish-panel");
const publishLink = document.getElementById("publish-link");
const resultPanel = document.getElementById("result-panel");
const resultDomain = document.getElementById("result-domain");
const resultConcepts = document.getElementById("result-concepts");
const resultRelations = document.getElementById("result-relations");
const resultClose = document.getElementById("result-close");
const nodeCountEl = document.getElementById("node-count");
const edgeCountEl = document.getElementById("edge-count");
const focusPill = document.getElementById("focus-pill");
const focusLabel = document.getElementById("focus-label");
const focusClear = document.getElementById("focus-clear");

let graph = { nodes: [], edges: [] };
let lastParsed = null; // { text, semantic, key }

async function loadGraph() {
  const res = await fetch("data/graph.json", { cache: "no-store" });
  graph = await res.json();
  renderer.setData(graph);
  nodeCountEl.textContent = graph.nodes.length;
  edgeCountEl.textContent = graph.edges.length;
}

function setStatus(msg) {
  statusLine.textContent = msg;
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

async function showResult({ semantic, key }) {
  const exactMatch = graph.nodes.find((n) => n.id === key);
  const { node: closest, similarity } = await findClosestNode(semantic);

  resultDomain.textContent = semantic.domain;
  resultConcepts.innerHTML = semantic.concepts
    .map((c) => `<span>${escapeHtml(c)}</span>`)
    .join("");

  const lines = [];
  let breakdownNode = null;

  if (exactMatch) {
    lines.push(
      `Cette formulation correspond déjà à une proposition existante (${exactMatch.stats.participants} participations, contribution marginale décroissante appliquée).`
    );
    renderer.setHighlight(exactMatch.id);
    breakdownNode = exactMatch;
  } else if (closest && similarity > 0.5) {
    lines.push(
      `Idée proche à ${Math.round(similarity * 100)}% (par similarité sémantique, pas par mots-clés) d'une proposition existante : « ${escapeHtml(
        closest.text
      )} ». Une nouvelle nuance sera tout de même enregistrée.`
    );
    renderer.setHighlight(closest.id);
    breakdownNode = closest;
  } else {
    lines.push("Aucune proposition proche trouvée — ceci introduirait une idée nouvelle dans le graphe.");
    renderer.setHighlight(null);
  }

  for (const rel of semantic.relations || []) {
    lines.push(`→ ${rel.type.replace(/_/g, " ")} : ${escapeHtml(rel.target_hint)}`);
  }

  resultRelations.innerHTML =
    lines.map((l) => `<div>${l}</div>`).join("") + renderBreakdown(breakdownNode);

  const domainNodes = graph.nodes.filter((n) => n.semantic.domain === semantic.domain);
  if (domainNodes.length >= 2) {
    resultRelations.innerHTML += `<button id="synth-btn" class="synth-button">Synthétiser les propositions du domaine « ${escapeHtml(
      semantic.domain
    )} » (${domainNodes.length})</button><div id="synth-output" class="synth-output"></div>`;
    document.getElementById("synth-btn").addEventListener("click", async (e) => {
      e.target.disabled = true;
      e.target.textContent = "Synthèse en cours…";
      const out = document.getElementById("synth-output");
      try {
        out.textContent = await synthesizeSubgraph(domainNodes);
      } catch (err) {
        out.textContent = `Erreur de synthèse: ${err.message}`;
      } finally {
        e.target.remove();
      }
    });
  }

  resultPanel.classList.remove("hidden");

  try {
    const url = buildSubmissionIssueUrl(lastParsed);
    publishLink.href = url;
    publishPanel.classList.remove("hidden");
  } catch (err) {
    if (err instanceof SubmissionTooLargeError) {
      setStatus(err.message);
      publishPanel.classList.add("hidden");
    } else {
      throw err;
    }
  }
}

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

  try {
    if (!isWebGPUAvailable()) {
      setStatus("WebGPU indisponible sur ce navigateur — l'analyse sémantique locale ne peut pas tourner ici.");
      return;
    }

    setStatus("Chargement du modèle local (une seule fois)…");
    const semantic = await parseWithAI(text, (report) => setStatus(report.text || "Chargement…"));

    setStatus("Analyse et recherche dans le graphe…");
    const key = await canonicalKey(semantic);
    lastParsed = { text, semantic, key };

    setStatus("");
    await showResult(lastParsed);
  } catch (err) {
    console.error(err);
    setStatus(`Erreur: ${err.message}`);
  } finally {
    submitButton.disabled = false;
  }
});

resultClose.addEventListener("click", () => {
  resultPanel.classList.add("hidden");
  publishPanel.classList.add("hidden");
  renderer.setHighlight(null);
});

// --- Navigation par niveaux : paysage (tout le graphe) <-> région (domaine) ---
// Cliquer un nœud dans le canvas fait "zoomer" la vue sur son domaine
// sémantique : les nœuds hors domaine sont estompés plutôt que retirés de
// la simulation, pour éviter que le graphe ne saute visuellement.
renderer.onNodeClick((node) => {
  if (!node) return;
  focusOnDomain(node.semantic.domain);
});

function focusOnDomain(domain) {
  renderer.setFocusDomain(domain);
  focusLabel.textContent = domain;
  focusPill.classList.remove("hidden");
}

function clearFocus() {
  renderer.setFocusDomain(null);
  focusPill.classList.add("hidden");
}

focusClear.addEventListener("click", clearFocus);

loadGraph();

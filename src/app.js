import { createGraphRenderer } from "./graph-render.js";
import { parseWithAI, canonicalKey, isWebGPUAvailable } from "./semantic.js";
import { startDeviceFlow, getStoredToken, signOut } from "./oauth.js";
import { submitProposal } from "./github-api.js";

const canvas = document.getElementById("graph-canvas");
const renderer = createGraphRenderer(canvas);

const form = document.getElementById("submit-form");
const input = document.getElementById("submit-input");
const submitButton = document.getElementById("submit-button");
const statusLine = document.getElementById("status-line");
const authPanel = document.getElementById("auth-panel");
const authButton = document.getElementById("auth-button");
const authDeviceCode = document.getElementById("auth-device-code");
const resultPanel = document.getElementById("result-panel");
const resultDomain = document.getElementById("result-domain");
const resultConcepts = document.getElementById("result-concepts");
const resultRelations = document.getElementById("result-relations");
const resultClose = document.getElementById("result-close");
const nodeCountEl = document.getElementById("node-count");
const edgeCountEl = document.getElementById("edge-count");

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

function jaccard(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  const inter = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : inter / union;
}

function findClosestNode(concepts) {
  let best = null;
  let bestScore = 0;
  for (const n of graph.nodes) {
    const score = jaccard(concepts, n.semantic.concepts);
    if (score > bestScore) {
      bestScore = score;
      best = n;
    }
  }
  return { node: best, similarity: bestScore };
}

function showResult({ semantic, key }) {
  const exactMatch = graph.nodes.find((n) => n.id === key);
  const { node: closest, similarity } = findClosestNode(semantic.concepts);

  resultDomain.textContent = semantic.domain;
  resultConcepts.innerHTML = semantic.concepts
    .map((c) => `<span>${escapeHtml(c)}</span>`)
    .join("");

  const lines = [];
  if (exactMatch) {
    lines.push(
      `Cette formulation correspond déjà à une proposition existante (${exactMatch.stats.participants} participations, contribution marginale décroissante appliquée).`
    );
    renderer.setHighlight(exactMatch.id);
  } else if (closest && similarity > 0.3) {
    lines.push(
      `Idée proche à ${Math.round(similarity * 100)}% d'une proposition existante : « ${escapeHtml(
        closest.text
      )} ». Une nouvelle nuance sera tout de même enregistrée.`
    );
    renderer.setHighlight(closest.id);
  } else {
    lines.push("Aucune proposition proche trouvée — ceci introduirait une idée nouvelle dans le graphe.");
    renderer.setHighlight(null);
  }

  for (const rel of semantic.relations || []) {
    lines.push(`→ ${rel.type.replace(/_/g, " ")} : ${escapeHtml(rel.target_hint)}`);
  }

  resultRelations.innerHTML = lines.map((l) => `<div>${l}</div>`).join("");
  resultPanel.classList.remove("hidden");

  const token = getStoredToken();
  authPanel.classList.toggle("hidden", !!token);
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
    showResult(lastParsed);
  } catch (err) {
    console.error(err);
    setStatus(`Erreur: ${err.message}`);
  } finally {
    submitButton.disabled = false;
  }
});

resultClose.addEventListener("click", () => {
  resultPanel.classList.add("hidden");
  renderer.setHighlight(null);
});

authButton.addEventListener("click", async () => {
  authButton.disabled = true;
  try {
    const { token, login } = await startDeviceFlow(({ userCode, verificationUri }) => {
      authDeviceCode.innerHTML = `Code : <strong>${userCode}</strong><br/><a href="${verificationUri}" target="_blank" rel="noopener">${verificationUri}</a>`;
      authDeviceCode.classList.remove("hidden");
    });

    authDeviceCode.classList.add("hidden");
    authPanel.classList.add("hidden");
    setStatus(`Connecté en tant que ${login}. Publication de la proposition…`);

    if (lastParsed) {
      const filename = `${lastParsed.key}__${Date.now()}.json`;
      const url = await submitProposal({
        token,
        login,
        filename,
        submission: {
          text: lastParsed.text,
          semantic: lastParsed.semantic,
          canonical_key: lastParsed.key,
          submitted_at: new Date().toISOString(),
          client_version: "1.0.0",
        },
      });
      setStatus(`Proposition envoyée pour validation : ${url}`);
    }
  } catch (err) {
    console.error(err);
    setStatus(`Erreur d'authentification: ${err.message}`);
  } finally {
    authButton.disabled = false;
  }
});

loadGraph();

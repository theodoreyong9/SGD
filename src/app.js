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
let lastParsed = null; // { text, semantic } — local preview only, non-authoritative
let authToken = null; // valid token in memory, once verified

// --- Authentication (see src/oauth.js, src/github-api.js) ---
// Three possible states, handled here:
//   1. OAuth not configured (placeholders in src/config.js) -> link-only
//      fallback flow (legacy behavior).
//   2. OAuth configured, no valid token yet -> the first click on
//      "Publish" starts the Device Flow.
//   3. Valid token in memory -> direct, invisible publication.
async function initAuth() {
  if (!isOAuthConfigured()) {
    authPill.classList.add("hidden");
    return;
  }
  authPill.classList.remove("hidden");

  const stored = getStoredToken();
  if (stored && (await isTokenValid(stored))) {
    authToken = stored;
    authStatusText.textContent = "Connected to GitHub — automatic publishing";
    authDisconnect.classList.remove("hidden");
  } else {
    authToken = null;
    authStatusText.textContent = "Not connected — publishing will open a GitHub authorization";
    authDisconnect.classList.add("hidden");
  }
}

authDisconnect.addEventListener("click", () => {
  clearStoredToken();
  authToken = null;
  authStatusText.textContent = "Not connected — publishing will open a GitHub authorization";
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

// Once a tracked submission has a known `node_id` (see src/tracker.js —
// discovered by reading the closing comment posted on the Issue, NEVER
// guessed client-side), check whether it shows up in the freshly
// reloaded graph and highlight the corresponding node — no need to
// re-run a manual search to see your own contribution appear.
function reconcileTrackedWithGraph() {
  for (const t of getTracked()) {
    if (!t.node_id) continue;
    const node = graph.nodes.find((n) => n.id === t.node_id);
    if (node) {
      renderer.setHighlight(node.id);
      break; // only highlight the most recently found one
    }
  }
}

// setStatus/setPublishStatus: always show a small animated spinner as
// long as a message is present — never a static piece of text that
// makes the interface look stuck while processing is under way (model
// loading, generation, waiting for the GitHub bot). spinning=false
// allows a final message to be shown without a spinner (e.g. an error,
// which is no longer "in progress").
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

// pollUntilResolved(entry): background polling, never requiring a
// manual page reload. Checks immediately, then with a growing interval
// (10s → 60s max) until resolved or given up after ~40 attempts (~30
// minutes). Only possible for submissions whose Issue number is known
// (direct API flow) — the link fallback flow has no way to know when
// the Issue was actually created on GitHub, so there's nothing to poll
// automatically in that case.
async function pollUntilResolved(entry) {
  const maxAttempts = 40;
  let delay = 10000;

  for (let i = 0; i < maxAttempts; i++) {
    const updated = await refreshStatus(entry);

    if (updated.status === "accepted") {
      await loadGraph();
      renderTracker();
      showToast("Update applied ✓");
      const node = graph.nodes.find((n) => n.id === updated.node_id);
      if (node) showNodeDetail(node);
      return;
    }
    if (updated.status === "rejected") {
      renderTracker();
      showToast(updated.reason ? "Submission rejected — see “Your submissions”" : "Submission rejected");
      return;
    }

    entry = updated;
    await sleep(delay);
    delay = Math.min(delay * 1.3, 60000);
  }
}

// showNodeDetail(node): full sheet for an EXISTING node in the graph —
// domain, concepts, relations, and influence breakdown
// (novelty/contribution/bridge/stability), exactly like after "Send".
// Used in two places: automatically when a tracked submission is
// accepted (see pollUntilResolved), and when clicking a result in the
// "Search" panel — in both cases, seeing a plain similarity percentage
// without the rest wouldn't make sense, this node already fully exists
// in the graph, its real statistics too.
// Per-domain synthesis cache — see renderSynthesisSection() below for
// the full reasoning. Key: domain, value: { text, count }. `count`
// (number of nodes in the domain at computation time) is used to know
// whether the cache is still up to date or needs regenerating.
const synthesisCache = new Map();

// renderSynthesisSection(domain) -> HTML (placeholder or cached text)
//
// IMPORTANT CHANGE: the synthesis is now automatic and systematic (it
// triggers on its own as soon as a domain has 2+ propositions, no
// button click needed anymore) — but it deliberately stays a TEXT,
// never a GRAPH NODE. This isn't a technical detail: it's the
// project's founding principle ("AI never becomes a source of truth,
// only a reading tool" — see README, "AI / protocol separation"
// doctrine). Turning it into a searchable node would mean giving it a
// canonical_key, an influence, a place in the graph — as if the AI had
// "participated" the same way a real person did. That's exactly what
// this project was designed to avoid.
//
// What's done instead, to address the real problem ("the text
// disappears") without crossing that line: caching PER DOMAIN, in
// memory, for the duration of the session. Revisiting any node of the
// same domain (search, clicking the graph, or after an accepted
// submission) instantly re-displays the SAME synthesis, without
// recomputing it — it therefore no longer "disappears" as long as the
// page stays open. It is simply never written to data/graph.json.
function renderSynthesisSection(domain) {
  const domainNodes = graph.nodes.filter((n) => n.semantic.domain === domain);
  if (domainNodes.length < 2) return "";

  const cached = synthesisCache.get(domain);
  if (cached && cached.count === domainNodes.length) {
    return `<div class="synth-output">${escapeHtml(cached.text)}</div>`;
  }
  return `<div id="synth-live" class="synth-output"><span class="spinner spinner-sm" aria-hidden="true"></span> Synthesizing the “${escapeHtml(domain)}” domain…</div>`;
}

// To be called right after inserting renderSynthesisSection() into the
// DOM — actually computes the synthesis if it wasn't already cached,
// and updates the element in place once ready. Does nothing if a
// concurrent call already filled the cache in the meantime (e.g. two
// nodes of the same domain consulted back to back).
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
    if (live) live.textContent = `Synthesis unavailable: ${err.message}`;
  }
}

// showNodeDetail(node, opts): full sheet for an EXISTING node in the
// graph — domain, concepts, relations, influence breakdown, and domain
// synthesis — exactly like after "Send". Used in three places:
// automatically when a tracked submission is accepted
// (pollUntilResolved), when clicking a result in the "Search" panel
// (fromSearch: true, shows the back button), and when clicking a dot
// directly in the graph. In all cases, seeing a plain similarity
// percentage without the rest wouldn't make sense: this node already
// fully exists in the graph, its real statistics too.
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

// runSearch: pure consultation of the graph, without going through
// WebLLM or preparing a submission. Search = navigation, distinct from
// proposing — the "Search" button only uses the small embeddings model
// (src/embeddings.js, WASM), not the heavier generative model loaded by
// "Send" (src/semantic.js, WebGPU). The raw query text is embedded
// directly, without extracting concepts/objective/means: for just
// "going to see what's there", full structuring is an unnecessary cost.
async function runSearch() {
  const text = input.value.trim();
  if (!text) return;

  resultPanel.classList.add("hidden");
  publishPanel.classList.add("hidden");
  searchButton.disabled = true;
  setStatus("Searching the graph…");

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
    setStatus(`Search error: ${err.message}`);
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
    searchList.innerHTML = `<li class="search-empty">Nothing in the graph for “${escapeHtml(query)}” yet.</li>`;
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
    ["Novelty", b.novelty],
    ["Repetition (decaying)", b.contribution],
    ["Semantic bridge", b.bridge],
    ["Stability (persistence + engagement)", b.stability],
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
  return `<div class="breakdown"><div class="breakdown-total">Influence: ${b.influence}</div>${bars}</div>`;
}

async function showResult({ semantic }) {
  resultBack.classList.add("hidden"); // submission preview, never "from search"
  const { node: closest, similarity } = await findClosestNode(semantic);

  resultDomain.textContent = semantic.domain;
  resultConcepts.innerHTML = semantic.concepts
    .map((c) => `<span>${escapeHtml(c)}</span>`)
    .join("");

  const lines = [];
  let breakdownNode = null;

  // There's no more "exact match" to show here: the authoritative
  // extraction runs server-side (scripts/semantic-extract.mjs),
  // independently of this one. Only embedding proximity remains a valid
  // signal, since it's based on the actual content, not a structural
  // equality between two independent extractions.
  if (closest && similarity > 0.5) {
    lines.push(
      `Idea ${Math.round(similarity * 100)}% close (by semantic similarity, not keywords) to an existing proposition: “${escapeHtml(
        closest.text
      )}”. Local preview — the extraction that will actually decide your proposition's position in the graph happens server-side, once published.`
    );
    renderer.setHighlight(closest.id);
    breakdownNode = closest;
  } else {
    lines.push("No close proposition found in this preview — this might introduce a new idea into the graph.");
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

// setupPublishPanel(): configures the publish panel based on the
// current authentication state. Only one button visible at a time,
// never both forms at once.
function setupPublishPanel() {
  deviceFlowBox.classList.add("hidden");
  setPublishStatus("");

  if (!isOAuthConfigured()) {
    // Legacy fallback: pre-filled link, opens GitHub. See README.
    try {
      const ref = crypto.randomUUID();
      const url = buildSubmissionIssueUrl({ text: lastParsed.text, ref });
      publishCopy.textContent =
        "You're about to open a pre-filled GitHub Issue on your own account: review it, then click “Submit new issue” on GitHub to actually publish it — come back here afterward, this tab tracks processing automatically.";
      publishLink.href = url;
      publishLink.classList.remove("hidden");
      publishButton.classList.add("hidden");
      publishLink.onclick = () => {
        recordSubmission({ number: null, html_url: null, text: lastParsed.text, domain: lastParsed.semantic.domain });
        setPublishStatus("Recorded in “Your submissions” — click “Submit new issue” on GitHub to actually publish it.", false);
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

  // OAuth configured: single button, adaptive behavior.
  publishLink.classList.add("hidden");
  publishButton.classList.remove("hidden");
  publishButton.disabled = false;
  publishCopy.textContent = authToken
    ? "Direct, automatic publishing — no GitHub tab will open."
    : "A one-time GitHub authorization is needed before the first publication (valid for every subsequent one, in this browser).";
  publishButton.textContent = authToken ? "Publish" : "Connect and publish";
  publishButton.onclick = () => publishDirectly();
  publishPanel.classList.remove("hidden");
}

// publishDirectly(): main path when OAuth is configured. Starts the
// Device Flow if needed (once), then creates the Issue via the API —
// no redirect to github.com for the act of submission itself.
async function publishDirectly() {
  publishButton.disabled = true;

  try {
    if (!authToken) {
      setPublishStatus("Opening GitHub authorization…");
      authToken = await startDeviceFlow(({ userCode, verificationUri }) => {
        deviceFlowBox.classList.remove("hidden");
        deviceCodeEl.textContent = userCode;
        deviceLink.href = verificationUri;
        window.open(verificationUri, "_blank", "noopener");
        setPublishStatus("Waiting for your authorization on GitHub…");
      });
      deviceFlowBox.classList.add("hidden");
      authStatusText.textContent = "Connected to GitHub — automatic publishing";
      authDisconnect.classList.remove("hidden");
      publishButton.textContent = "Publish";
      publishCopy.textContent = "Direct, automatic publishing — no GitHub tab will open.";
    }

    setPublishStatus("Publishing…");
    const ref = crypto.randomUUID();
    const issue = await createSubmissionIssue(authToken, { text: lastParsed.text, ref });

    const list = recordSubmission({
      number: issue.number,
      html_url: issue.html_url,
      text: lastParsed.text,
      domain: lastParsed.semantic.domain,
    });
    renderTracker();
    // The spinner keeps running here: GitHub's processing isn't done,
    // only the sending is. pollUntilResolved clears this message (and
    // shows the toast) once the real resolution is known — never a
    // static piece of text while work is still happening in the
    // background.
    setPublishStatus("Being processed by GitHub…");
    pollUntilResolved(list[0]);
  } catch (err) {
    console.error(err);
    if (err instanceof DeviceFlowError || err instanceof GitHubApiError) {
      setPublishStatus(`Error: ${err.message}`, false);
    } else {
      setPublishStatus(`Unexpected error: ${err.message}`, false);
    }
  } finally {
    publishButton.disabled = false;
  }
}

const STATUS_LABELS = {
  pending: "Pending on GitHub",
  accepted: "Merged into the graph ✓",
  rejected: "Rejected ✕",
  unknown: "Unknown status",
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
        ? `<a href="${t.issue_url}" target="_blank" rel="noopener" class="tracker-link">View the issue →</a>`
        : "";
      // Spinner only for still-open states — once accepted or rejected,
      // there's nothing "in progress" left to signal here.
      const isActive = t.status === "pending" || t.status === "unknown";
      const spinner = isActive ? '<span class="spinner spinner-sm" aria-hidden="true"></span>' : "";
      return `
        <li class="tracker-item tracker-${t.status}">
          <div class="tracker-text">${escapeHtml(truncate(t.text, 60))}</div>
          <div class="tracker-status">${spinner}${STATUS_LABELS[t.status] || t.status}</div>
          ${reasonLine}
          ${link}
          <button class="tracker-dismiss" data-id="${id}" aria-label="Remove from tracking">✕</button>
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
      setStatus("WebGPU unavailable in this browser — local semantic analysis can't run here.", false);
      return;
    }

    setStatus(isModelLoaded() ? "Analyzing your text…" : "Loading the local model…");
    const semantic = await parseWithAI(text, (report) => {
      const progress = typeof report?.progress === "number" ? report.progress : 0;
      if (progress < 1) {
        setStatus(`Loading the local model… ${Math.round(progress * 100)}%`);
      } else {
        // WebLLM's progress callback only ever covers model LOADING —
        // once at 100%, no further event happens during generation
        // itself. Without this text change, the last loading message
        // (often unreadable, like "Finish loading on WebGPU - amd")
        // would stay frozen on screen for the whole generation, as if
        // the app were stuck — the spinner keeps spinning, but the text
        // has to change phase to stay honest about what's happening.
        setStatus("Analyzing your text…");
      }
    });
    lastParsed = { text, semantic };

    // The spinner keeps running: showResult() still does an embedding
    // search before showing the result and the "Publish" button — no
    // visual interruption between generation and the result appearing.
    setStatus("Searching the graph…");
    await showResult(lastParsed);
    setStatus("");
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`, false);
  } finally {
    submitButton.disabled = false;
  }
});

resultClose.addEventListener("click", () => {
  resultPanel.classList.add("hidden");
  publishPanel.classList.add("hidden");
  renderer.setHighlight(null);
});

// --- Clicking a node in the graph opens its full sheet ---
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

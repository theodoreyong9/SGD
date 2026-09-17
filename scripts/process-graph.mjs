// Runs AFTER validate-submission.mjs has written a validated file into
// submissions/pending/, in the same privileged workflow step
// (.github/workflows/process-submission.yml). What that file now contains
// is ONLY `text` (plus bookkeeping like source_issue) — the client's
// `semantic` block, if it ever sent one, is never read anywhere in this
// pipeline. THIS script is what turns raw text into the structured
// representation that decides canonical_key, via extractSemantic()
// (scripts/semantic-extract.mjs). See that file's header for why this
// moved server-side: it closes a real gap where a submitter could hand-
// craft an internally-consistent `semantic` block unrelated to their own
// `text`, which no amount of hash re-verification alone could catch.
//
// This is where sections 10-15, 21, and 37 of the spec become arithmetic:
//   - repeated submissions of the same canonical proposition get a
//     shrinking marginal contribution (R_P(n) = 1/n)
//   - novelty and relation-matching use real sentence embeddings, not
//     keyword overlap, so paraphrases with different vocabulary are still
//     recognized as semantically close
//   - each node's influence score is decomposed and stored, so the UI can
//     show a breakdown instead of a single opaque number

import { readFileSync, writeFileSync, readdirSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { embed, textForEmbedding, cosineSimilarity } from "./embeddings.mjs";
import { extractSemantic } from "./semantic-extract.mjs";
import { canonicalKey } from "./canonical.mjs";

const GRAPH_PATH = "data/graph.json";
const PENDING_DIR = "submissions/pending";
const PROCESSED_DIR = "submissions/processed";
const EDGE_SIMILARITY_THRESHOLD = 0.55;

// Threshold for auto-generated "similar" edges (see upsertSimilarityEdges
// below) — deliberately higher than EDGE_SIMILARITY_THRESHOLD. The latter
// matches a `target_hint` (free text, often short) to an existing
// concept; this one compares two entire nodes directly against each
// other, a stronger signal that deserves a higher bar so it only
// captures genuine near-paraphrases, not mere thematic kinship.
const SIMILARITY_EDGE_THRESHOLD = 0.72;

// Influence weights (spec section 12): I(v) = alpha*N + beta*R + gamma*D + delta*P
// None of these dominates by construction — see spec section 60.
const WEIGHTS = { novelty: 0.4, contribution: 0.3, bridge: 0.2, stability: 0.1 };

function loadGraph() {
  if (!existsSync(GRAPH_PATH)) {
    return { version: 1, updated_at: null, nodes: [], edges: [] };
  }
  return JSON.parse(readFileSync(GRAPH_PATH, "utf-8"));
}

function findNode(graph, canonicalKey) {
  return graph.nodes.find((n) => n.id === canonicalKey);
}

function maxSimilarityToExisting(graph, embedding, excludeId) {
  let max = 0;
  for (const n of graph.nodes) {
    if (n.id === excludeId || !n.embedding) continue;
    const sim = cosineSimilarity(embedding, n.embedding);
    if (sim > max) max = sim;
  }
  return max;
}

async function upsertNode(graph, submission) {
  const key = submission.canonical_key;
  let node = findNode(graph, key);
  const now = new Date().toISOString();

  const embedding = await embed(textForEmbedding(submission.semantic));

  if (!node) {
    const novelty = 1 - maxSimilarityToExisting(graph, embedding, key);
    node = {
      id: key,
      type: "proposition",
      text: submission.text,
      semantic: submission.semantic,
      embedding,
      first_seen: now,
      last_seen: now,
      stats: {
        participants: 0,
        contribution: 0,
        novelty,
      },
    };
    graph.nodes.push(node);
  } else {
    // Re-embed on every occurrence — wording can drift slightly across
    // resubmissions — but novelty itself is fixed at first appearance
    // (spec: novelty describes what the idea ADDED to the graph, not a
    // property that should keep changing after the fact).
    node.embedding = embedding;
  }

  // Diminishing marginal contribution: the (n+1)-th occurrence of the SAME
  // canonical proposition adds 1/(n+1) instead of a flat +1. Participants is
  // kept separately as a purely descriptive count (section 15).
  node.stats.participants += 1;
  node.stats.contribution += 1 / node.stats.participants;
  node.text = submission.text; // keep most recent formulation as the human-facing label
  node.last_seen = now;

  return node;
}

async function upsertEdges(graph, node, submission) {
  for (const rel of submission.semantic.relations || []) {
    if (!rel.target_hint) continue;
    const hintEmbedding = await embed(rel.target_hint);

    let best = null;
    let bestSim = 0;
    for (const other of graph.nodes) {
      if (other.id === node.id || !other.embedding) continue;
      const sim = cosineSimilarity(hintEmbedding, other.embedding);
      if (sim > bestSim) {
        bestSim = sim;
        best = other;
      }
    }
    if (!best || bestSim < EDGE_SIMILARITY_THRESHOLD) continue;

    const edgeId = `${node.id}->${best.id}:${rel.type}`;
    let edge = graph.edges.find((e) => e.id === edgeId);
    if (!edge) {
      edge = { id: edgeId, source: node.id, target: best.id, type: rel.type, weight: 0, similarity: round(bestSim) };
      graph.edges.push(edge);
    }
    edge.weight += 1; // simplest possible w_ij; see spec section 28 for richer variants
  }
}

// "similar" edges: until now, semantic proximity between two DISTINCT
// nodes (so not merged by canonical_key) only fed into the `novelty`
// computation and the client preview's "idea close at X%" — nothing
// kept track of it in the graph itself. Two paraphrases that don't
// share the exact same canonical_key therefore stayed visually
// unconnected in data/graph.json, even though they should appear
// connected: this is exactly protocol case 2 (paraphrase → same
// semantic region, not two independent ideas).
//
// Unlike the edges from upsertEdges above (coming from a relation
// asserted by the AI — implies, contradicts, etc.), a "similar" edge
// doesn't accumulate with repetitions: its weight reflects the CURRENT
// proximity, not a count of assertions.
async function upsertSimilarityEdges(graph, node) {
  for (const other of graph.nodes) {
    if (other.id === node.id || !other.embedding) continue;
    const sim = cosineSimilarity(node.embedding, other.embedding);
    if (sim < SIMILARITY_EDGE_THRESHOLD) continue;

    // Sorted ID to stay stable regardless of the order the two nodes are
    // processed in — a single edge per pair, never one in each direction.
    const [a, b] = [node.id, other.id].sort();
    const edgeId = `${a}<->${b}:similar`;
    let edge = graph.edges.find((e) => e.id === edgeId);
    if (!edge) {
      edge = { id: edgeId, source: a, target: b, type: "similar", weight: 1, similarity: round(sim) };
      graph.edges.push(edge);
    } else {
      edge.similarity = round(sim); // proximity can drift slightly on re-embedding
    }
  }
}

// Bridge (section 21): a node's ability to connect otherwise poorly
// connected semantic regions. Two signals, combined in equal parts:
//
//   (a) diversity of declared DOMAINS among neighbors — the original
//       signal, kept as-is, but deliberately capped in weight: `domain`
//       is a label chosen by the LLM at submission time (a closed enum
//       of 10 values, see semantic.js), not an emergent region. Making
//       the ENTIRE bridge score rest on it would freeze an a-priori
//       taxonomy into a protocol meant to do without one.
//
//   (b) SEMANTIC dispersion among the neighbors themselves (average
//       pairwise cosine distance of their embeddings) — independent of
//       any declared label. A node whose neighbors are already close to
//       each other doesn't connect much; a node whose neighbors are
//       dispersed across the semantic space genuinely connects ideas
//       that wouldn't otherwise touch. This is the closest approximation
//       of "bridge between regions" that doesn't depend on the `domain`
//       enum.
//
// "similar" edges (see upsertSimilarityEdges) are deliberately EXCLUDED
// from the neighborhood considered here: by definition they connect
// nodes that are already close to each other, so including them would
// mechanically lower the average dispersion — diluting the bridge score
// with the very signal it's meant to filter out. `bridge` measures
// ASSERTED relations (implies, contradicts, questions, etc.), not
// content proximity.
function computeBridgeScore(graph, node) {
  const neighborIds = new Set();
  for (const e of graph.edges) {
    if (e.type === "similar") continue;
    if (e.source === node.id) neighborIds.add(e.target);
    else if (e.target === node.id) neighborIds.add(e.source);
  }
  const neighbors = [...neighborIds].map((id) => findNode(graph, id)).filter(Boolean);

  const connectedDomains = new Set(
    neighbors.filter((n) => n.semantic.domain !== node.semantic.domain).map((n) => n.semantic.domain)
  );
  const domainDiversity = Math.min(1, connectedDomains.size / 3); // saturates at 3 distinct domains

  let dispersion = 0;
  const withEmbedding = neighbors.filter((n) => n.embedding);
  if (withEmbedding.length >= 2) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < withEmbedding.length; i++) {
      for (let j = i + 1; j < withEmbedding.length; j++) {
        sum += 1 - cosineSimilarity(withEmbedding[i].embedding, withEmbedding[j].embedding);
        count++;
      }
    }
    // Cosine distance between paraphrases rarely exceeds ~0.65 in practice
    // with this embedding model, so scale up before saturating at 1.
    dispersion = count > 0 ? Math.min(1, (sum / count) * 1.5) : 0;
  }

  return 0.5 * domainDiversity + 0.5 * dispersion;
}

// Stability (section 29): not just age. A proposition that just sits
// there with nobody ever coming back to it, connecting it, rephrasing
// it, or contesting it shouldn't reach maximum stability — the doctrine
// (section 29) explicitly talks about persistence AND ongoing
// structural validation. So we combine:
//
//   - persistence: age since first appearance, normalized over 30 days
//     (the original signal, kept).
//   - engagement: two purely structural signals, with no contributor
//     identity — number of reappearances of the same canonical
//     proposition beyond the first (independent of the harmonic decay
//     already applied to `contribution`), and number of accumulated
//     edges (being referenced by, or referencing, other nodes).
//
// Persistence alone caps at 0.4: an idea can't become "stable" merely by
// staying inactive for a month. It also needs engagement to approach 1.
function computeStabilityScore(graph, node) {
  const ageMs = Date.now() - new Date(node.first_seen).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const persistence = Math.min(1, ageDays / 30);

  const participationSignal = Math.min(1, (node.stats.participants - 1) / 4);
  const edgeCount = graph.edges.filter((e) => e.source === node.id || e.target === node.id).length;
  const connectionSignal = Math.min(1, edgeCount / 4);
  const engagement = 0.5 * participationSignal + 0.5 * connectionSignal;

  return persistence * (0.4 + 0.6 * engagement);
}

function computeInfluence(graph, node) {
  const contributionNorm = Math.min(1, node.stats.contribution / 5); // saturates around 5 harmonic units
  const bridge = computeBridgeScore(graph, node);
  const stability = computeStabilityScore(graph, node);

  const breakdown = {
    novelty: round(node.stats.novelty * WEIGHTS.novelty * 100),
    contribution: round(contributionNorm * WEIGHTS.contribution * 100),
    bridge: round(bridge * WEIGHTS.bridge * 100),
    stability: round(stability * WEIGHTS.stability * 100),
  };
  breakdown.influence = round(
    breakdown.novelty + breakdown.contribution + breakdown.bridge + breakdown.stability
  );
  return breakdown;
}

function round(x) {
  return Math.round(x * 10) / 10;
}

async function main() {
  const graph = loadGraph();
  const pendingFiles = existsSync(PENDING_DIR)
    ? readdirSync(PENDING_DIR).filter((f) => f.endsWith(".json"))
    : [];

  if (pendingFiles.length === 0) {
    console.log("Nothing to process.");
    return;
  }

  // In practice a single workflow run only ever processes one Issue at a
  // time, but a general loop is kept for robustness in case several
  // files pile up (e.g. a manual replay). Each result is logged so the
  // workflow can compose its closing comment with the REAL canonical_key
  // — the one the server computed, never one an old client might still
  // have included.
  const processed = [];

  for (const file of pendingFiles) {
    const fullPath = join(PENDING_DIR, file);
    const raw = JSON.parse(readFileSync(fullPath, "utf-8"));

    if (typeof raw.text !== "string" || raw.text.trim().length === 0) {
      console.warn(`Skipped (missing text): ${file}`);
      renameSync(fullPath, join(PROCESSED_DIR, file));
      continue;
    }

    // This is WHERE, and only where, the semantic structure and
    // canonical_key exist. `raw.semantic` / `raw.canonical_key`, if an
    // old submission format still contained them, are never read.
    const semantic = await extractSemantic(raw.text);
    const key = canonicalKey(semantic);
    const submission = { text: raw.text, semantic, canonical_key: key };

    const node = await upsertNode(graph, submission);
    await upsertEdges(graph, node, submission);
    await upsertSimilarityEdges(graph, node);

    renameSync(fullPath, join(PROCESSED_DIR, file));
    console.log(
      `Processed: ${file} -> node ${node.id} (participants=${node.stats.participants}, contribution=${node.stats.contribution.toFixed(3)}, novelty=${node.stats.novelty.toFixed(3)})`
    );

    processed.push({
      source_issue: raw.source_issue ?? null,
      node_id: node.id,
      domain: semantic.domain,
      concepts: semantic.concepts,
    });
  }

  // Recompute influence breakdown for every node (bridge scores can change
  // for OTHER nodes when a new edge lands, not just the submitted one).
  for (const node of graph.nodes) {
    node.stats.breakdown = computeInfluence(graph, node);
  }

  graph.updated_at = new Date().toISOString();
  writeFileSync(GRAPH_PATH, JSON.stringify(graph, null, 2));
  console.log(`Graph updated: ${graph.nodes.length} nodes, ${graph.edges.length} relations.`);

  // Read by the workflow (the "Comment + close as processed" step) to
  // include the real canonical_key in the Issue's closing comment —
  // without this, there'd be no way for the client-side tracker
  // (src/tracker.js) to know which node corresponds to its submission,
  // since the client never computes the authoritative identity anymore.
  for (const p of processed) {
    const nodeForBreakdown = findNode(graph, p.node_id);
    p.influence = nodeForBreakdown?.stats?.breakdown?.influence ?? null;
  }
  writeFileSync("processing-result.json", JSON.stringify({ processed }, null, 2));
}

main();

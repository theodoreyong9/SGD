// Runs AFTER a submission PR has been merged into main, in a privileged
// workflow that never checks out untrusted PR code — only main, which by
// this point has already passed validate-submission.mjs.
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

const GRAPH_PATH = "data/graph.json";
const PENDING_DIR = "submissions/pending";
const PROCESSED_DIR = "submissions/processed";
const EDGE_SIMILARITY_THRESHOLD = 0.55;

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

// Bridge/diversity (section 21, approximated): how many DISTINCT domains
// this node is connected to via edges, in either direction. This
// intentionally avoids tracking per-contributor identity (section 20's
// literal "domain of contributors" would require storing who submitted
// what, which this design deliberately does not do).
function computeBridgeScore(graph, node) {
  const connectedDomains = new Set();
  for (const e of graph.edges) {
    if (e.source === node.id) {
      const t = findNode(graph, e.target);
      if (t && t.semantic.domain !== node.semantic.domain) connectedDomains.add(t.semantic.domain);
    } else if (e.target === node.id) {
      const s = findNode(graph, e.source);
      if (s && s.semantic.domain !== node.semantic.domain) connectedDomains.add(s.semantic.domain);
    }
  }
  return Math.min(1, connectedDomains.size / 3); // saturates at 3 distinct domains
}

// Stability (section 29): how long the proposition has persisted and stayed
// active in the graph, normalized to [0,1] over a 30-day horizon.
function computeStabilityScore(node) {
  const ageMs = Date.now() - new Date(node.first_seen).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.min(1, ageDays / 30);
}

function computeInfluence(graph, node) {
  const contributionNorm = Math.min(1, node.stats.contribution / 5); // saturates around 5 harmonic units
  const bridge = computeBridgeScore(graph, node);
  const stability = computeStabilityScore(node);

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
    console.log("Rien à traiter.");
    return;
  }

  for (const file of pendingFiles) {
    const fullPath = join(PENDING_DIR, file);
    const submission = JSON.parse(readFileSync(fullPath, "utf-8"));

    // NOTE: this script trusts submission.canonical_key here because
    // validate-submission.mjs already re-derived and checked it before merge.
    // Nothing reaches main without passing through that gate first.
    const node = await upsertNode(graph, submission);
    await upsertEdges(graph, node, submission);

    renameSync(fullPath, join(PROCESSED_DIR, file));
    console.log(
      `Traité: ${file} -> nœud ${node.id} (participants=${node.stats.participants}, contribution=${node.stats.contribution.toFixed(3)}, novelty=${node.stats.novelty.toFixed(3)})`
    );
  }

  // Recompute influence breakdown for every node (bridge scores can change
  // for OTHER nodes when a new edge lands, not just the submitted one).
  for (const node of graph.nodes) {
    node.stats.breakdown = computeInfluence(graph, node);
  }

  graph.updated_at = new Date().toISOString();
  writeFileSync(GRAPH_PATH, JSON.stringify(graph, null, 2));
  console.log(`Graphe mis à jour: ${graph.nodes.length} nœuds, ${graph.edges.length} relations.`);
}

main();

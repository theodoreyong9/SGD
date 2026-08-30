// Runs AFTER a submission PR has been merged into main, in a privileged
// workflow that never checks out untrusted PR code — only main, which by
// this point has already passed validate-submission.mjs.
//
// This is where sections 10-15 of the spec become arithmetic:
//   - repeated submissions of the same canonical proposition get a
//     shrinking marginal contribution (R_P(n) = 1/n)
//   - a brand-new proposition can outrank a popular one on "novelty" if
//     its concept set doesn't overlap with anything already in the graph

import { readFileSync, writeFileSync, readdirSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";

const GRAPH_PATH = "data/graph.json";
const PENDING_DIR = "submissions/pending";
const PROCESSED_DIR = "submissions/processed";

function jaccard(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function loadGraph() {
  if (!existsSync(GRAPH_PATH)) {
    return { version: 1, updated_at: null, nodes: [], edges: [] };
  }
  return JSON.parse(readFileSync(GRAPH_PATH, "utf-8"));
}

function findNode(graph, canonicalKey) {
  return graph.nodes.find((n) => n.id === canonicalKey);
}

function computeNovelty(graph, concepts) {
  if (graph.nodes.length === 0) return 1;
  const maxSimilarity = Math.max(
    0,
    ...graph.nodes.map((n) => jaccard(concepts, n.semantic.concepts))
  );
  return Math.max(0, 1 - maxSimilarity);
}

function upsertNode(graph, submission) {
  const key = submission.canonical_key;
  let node = findNode(graph, key);
  const now = new Date().toISOString();

  if (!node) {
    node = {
      id: key,
      type: "proposition",
      text: submission.text, // latest human-readable formulation
      semantic: submission.semantic,
      first_seen: now,
      last_seen: now,
      stats: {
        participants: 0,
        contribution: 0,
        novelty: computeNovelty(graph, submission.semantic.concepts),
      },
    };
    graph.nodes.push(node);
  }

  // Diminishing marginal contribution: the (n+1)-th occurrence of the SAME
  // canonical proposition adds 1/(n+1) instead of a flat +1. Participants is
  // kept separately as a purely descriptive count (section 15: "le système
  // peut néanmoins conserver le nombre de participants comme information
  // descriptive").
  node.stats.participants += 1;
  node.stats.contribution += 1 / node.stats.participants;
  node.text = submission.text; // keep most recent formulation as the human-facing label
  node.last_seen = now;

  return node;
}

function upsertEdges(graph, node, submission) {
  for (const rel of submission.semantic.relations || []) {
    // Lightweight matching: link to any existing node sharing a concept
    // overlap with the relation's target_hint. A real deployment would use
    // embedding similarity here; this keeps the skeleton dependency-free.
    const hintWords = new Set(
      (rel.target_hint || "").toLowerCase().split(/\s+/).filter(Boolean)
    );
    const target = graph.nodes.find(
      (n) =>
        n.id !== node.id &&
        n.semantic.concepts.some((c) => hintWords.has(c.toLowerCase()))
    );
    if (!target) continue;

    const edgeId = `${node.id}->${target.id}:${rel.type}`;
    let edge = graph.edges.find((e) => e.id === edgeId);
    if (!edge) {
      edge = { id: edgeId, source: node.id, target: target.id, type: rel.type, weight: 0 };
      graph.edges.push(edge);
    }
    edge.weight += 1; // simplest possible w_ij; see spec section 28 for richer variants
  }
}

function main() {
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
    const node = upsertNode(graph, submission);
    upsertEdges(graph, node, submission);

    renameSync(fullPath, join(PROCESSED_DIR, file));
    console.log(`Traité: ${file} -> nœud ${node.id} (participants=${node.stats.participants}, contribution=${node.stats.contribution.toFixed(3)}, novelty=${node.stats.novelty.toFixed(3)})`);
  }

  graph.updated_at = new Date().toISOString();
  writeFileSync(GRAPH_PATH, JSON.stringify(graph, null, 2));
  console.log(`Graphe mis à jour: ${graph.nodes.length} nœuds, ${graph.edges.length} relations.`);
}

main();

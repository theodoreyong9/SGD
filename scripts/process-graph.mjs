// Runs AFTER validate-submission.mjs has written a validated file into
// submissions/pending/, in the same privileged workflow step
// (.github/workflows/process-submission.yml) — never on untrusted input
// directly; the only thing this script ever reads from submissions/pending/
// has already passed schema validation and canonical_key re-derivation.
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

// Bridge (section 21): capacité d'un nœud à connecter des régions
// sémantiques autrement peu connectées. Deux signaux, combinés à parts
// égales:
//
//   (a) diversité de DOMAINES déclarés parmi les voisins — le signal
//       d'origine, gardé tel quel, mais volontairement plafonné en poids:
//       `domaine` est une étiquette choisie par le LLM à la soumission
//       (un enum fermé de 10 valeurs, voir semantic.js), pas une région
//       émergente. Y faire reposer TOUT le score de pont reviendrait à
//       figer une taxonomie a priori dans un protocole censé s'en passer.
//
//   (b) dispersion SÉMANTIQUE entre les voisins eux-mêmes (distance
//       cosinus moyenne de leurs embeddings, deux à deux) — indépendant
//       de toute étiquette déclarée. Un nœud dont les voisins sont déjà
//       proches les uns des autres ne relie pas grand-chose ; un nœud
//       dont les voisins sont dispersés dans l'espace sémantique relie
//       réellement des idées qui ne se touchaient pas autrement. C'est
//       l'approximation la plus proche de "pont entre régions" qui ne
//       dépend pas de l'enum `domaine`.
function computeBridgeScore(graph, node) {
  const neighborIds = new Set();
  for (const e of graph.edges) {
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

// Stability (section 29): pas seulement l'âge. Une proposition qui reste
// simplement ASSISE sans que personne n'y revienne, ne la relie, ne la
// reformule ou ne la conteste ne devrait pas atteindre la stabilité
// maximale — la doctrine (section 29) parle explicitement de persistance
// ET de validation structurelle continue. On combine donc :
//
//   - persistance : âge depuis la première apparition, normalisé sur 30
//     jours (le signal d'origine, gardé).
//   - engagement : deux signaux purement structurels, sans identité de
//     contributeur — nombre de réapparitions de la même proposition
//     canonique au-delà de la première (indépendant de la décroissance
//     harmonique déjà appliquée à `contribution`), et nombre d'arêtes
//     accumulées (être référencé par, ou référencer, d'autres nœuds).
//
// La persistance seule plafonne à 0.4 : une idée ne peut pas devenir
// "stable" par le seul fait de rester inactive un mois. Il lui faut aussi
// de l'engagement pour approcher 1.
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

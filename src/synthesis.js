// Synthèse par IA (spec section 25): summarize a cluster of propositions
// into a short, human-readable paragraph. This NEVER replaces the
// underlying data — it's explicitly a derived view, regenerated on demand,
// never stored as ground truth in the graph itself.

import { loadModel } from "./semantic.js";

const SYSTEM_PROMPT = `Tu es un synthétiseur neutre de débats collectifs.
On te donne une liste de propositions appartenant à un même domaine ou sous-graphe.
Produis une synthèse de 2 à 4 phrases en français qui:
- identifie les grandes tendances ou stratégies qui se dégagent,
- signale les tensions ou désaccords s'il y en a,
- ne prend jamais parti et ne juge jamais la qualité des propositions.
Réponds uniquement avec le texte de la synthèse, sans préambule ni liste à puces.`;

export async function synthesizeSubgraph(nodes) {
  if (nodes.length === 0) return "Aucune proposition à synthétiser pour l'instant.";

  const engine = await loadModel();
  const listing = nodes
    .slice(0, 30) // keep the prompt bounded even for a large sub-graph
    .map((n, i) => `${i + 1}. ${n.text} (participants: ${n.stats.participants})`)
    .join("\n");

  const reply = await engine.chat.completions.create({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: listing },
    ],
    temperature: 0.3,
    max_tokens: 220,
  });

  return reply.choices[0].message.content.trim();
}

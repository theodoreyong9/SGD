// AI synthesis (spec section 25): summarize a cluster of propositions
// into a short, human-readable paragraph. This NEVER replaces the
// underlying data — it's explicitly a derived view, regenerated on demand,
// never stored as ground truth in the graph itself.

import { loadModel } from "./semantic.js";

const SYSTEM_PROMPT = `You are a neutral synthesizer of collective debates.
You are given a list of propositions belonging to the same domain or sub-graph.
Produce a 2-to-4-sentence synthesis in English that:
- identifies the major trends or strategies that emerge,
- flags tensions or disagreements if there are any,
- never takes a side and never judges the quality of the propositions.
Reply only with the synthesis text, no preamble and no bullet list.`;

export async function synthesizeSubgraph(nodes) {
  if (nodes.length === 0) return "No proposition to synthesize yet.";

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

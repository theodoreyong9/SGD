# Semantic Graph Democracy (SGD)

A public space for collective participation, built entirely on GitHub: a static page, GitHub Issues as the only inbox, GitHub Actions as the only backend, and an AI that turns free text into structure — never into a vote, never into an identity.

Live: https://theodoreyong9.github.io/SGD/

## What this is

Anyone can write a short text — an idea, an objection, a question — and submit it. There's no for/against button: a submission is never a vote, it's a proposition that takes its place in a shared, browsable semantic graph. An AI reads the text and extracts a small structured meaning from it (which domain it belongs to, what concepts it touches, what it relates to and how); that structure decides where the proposition lands in the graph and how it connects to what's already there. Repeating an idea that already exists strengthens it instead of duplicating it. Nothing about a node ever depends on who wrote it — there are no accounts, no profiles, no identity anywhere in the graph itself.

## How it works

```
Browser (static page, GitHub Pages)
  ├─ a small local model (WebLLM) parses your text for an instant preview —
  │  concepts, domain, closest existing idea — before you publish anything
  ├─ "Send" opens a submission, "Search" just looks at the graph — the two
  │  are kept deliberately separate
  └─ publishing opens a GitHub Issue, either automatically (if a one-time
     GitHub authorization has been granted) or via a pre-filled link
     (zero configuration, always works)

GitHub Actions (one workflow, triggered when an Issue opens)
  ├─ reads the issue as data, never as code — validates that a `text`
  │  field exists, is a reasonable length, and the author hasn't hit the
  │  daily submission cap
  ├─ a second model, of comparable size but running on GitHub's own
  │  CPU runner, re-derives the SAME kind of structure the browser
  │  previewed, from the raw text alone — this run is the one that
  │  actually counts
  ├─ that structure decides the proposition's identity (a hash of its
  │  normalized meaning), its embedding-based similarity to every
  │  existing node, and its place in the graph
  └─ commits the updated graph, closes the Issue with the result

GitHub Pages
  └─ serves the static page and the graph data; redeploys automatically
     whenever the graph changes
```

There is no database, no server we run, and no account system beyond GitHub's own. The graph itself is a single JSON file, versioned like any other file in this repository.

## Design principles

**The AI is a reading tool, never a source of truth.** Two separate small models are involved — one in the browser, for an instant preview, and one running in the GitHub Actions job — but only the second one's output is ever written to the graph. A submission's `text` is the only thing that travels from your browser to GitHub; whatever structure the browser's own preview computed is discarded the moment you publish. This closes a real gap: if the browser's own structure were trusted, anyone could hand-craft a `semantic` block with no real relationship to their own text.

**Identity never enters the graph.** A node's score depends only on its content, its connections, and how the graph has responded to it over time — never on who submitted it, how many times, or from where. There is no per-contributor reputation, no login required to be visible in the graph, and no way to look up "who said this."

**Meaning is compared by content, not by keywords.** Two propositions phrased in completely different words but making the same point are recognized as close, because both are compared through real sentence embeddings, not word overlap. This is what lets the graph merge paraphrases and surface genuinely related ideas rather than only exact repeats.

**A canonical identity is reproducible.** The same idea, resubmitted in slightly different wording, normalizes down to the same identity (case, accents, whitespace, and field order are all stripped away before hashing) — so it strengthens the existing node rather than forking into a near-duplicate.

## Publishing

There are two ways a submission becomes a real GitHub Issue, and the site picks automatically between them based on whether an optional OAuth App has been configured (see "Optional setup" below):

- **Without any configuration**: clicking "Send" then "Publish" opens a pre-filled GitHub Issue in a new tab; you review it and click "Submit new issue" yourself. This always works, needs nothing deployed, and the click on github.com itself is a real human confirmation no script could fake.
- **With the optional OAuth App configured**: the first publish asks for a one-time authorization (an 8-character code, entered once on github.com); every submission after that is a direct, invisible API call — no more tabs opening.

Both paths produce the exact same kind of Issue, and the workflow that processes it treats them identically — nothing about how a submission arrived changes what happens to it.

## Security model

**Guaranteed by construction:**
- An Issue's body is treated as data, never as code. The processing workflow reads it through GitHub's API into a plain JSON file and only ever runs `JSON.parse` plus a schema check against it — nothing is interpolated into a shell command or executed.
- The semantic structure and identity of a proposition are never something a submitter can influence. Only the text itself crosses from the browser to the Issue; the structure and identity that end up in the graph are computed by GitHub's own runner, from that text alone.
- Repeating the same underlying idea has a diminishing marginal effect (each further occurrence contributes less than the last), so simple repetition doesn't let one idea dominate the graph.
- The optional OAuth token, when used, lives only in your own browser's local storage and carries the narrowest possible scope (opening issues on public repos) — the relay it briefly passes through never sees it again after the initial exchange.

**Not guaranteed, by structural limit:**
- **Who really submitted something.** Anyone with their own GitHub token could forge an identical Issue outside the interface entirely. This is intentional: the system evaluates content, not provenance.
- **That an author is a distinct human.** A GitHub account has a cost to create at scale but is not proof of humanity.
- **Resistance to patient rephrasing.** Someone willing to reword the same point slightly each time can partially outrun the diminishing-return mechanism, since it tracks exact normalized identity, not approximate meaning.
- **Quality of the automated extraction.** The model doing the real, authoritative extraction is a small one chosen to run affordably on a shared CI runner; a weak extraction produces a less informative node, never a broken one, but it is not a guarantee of accuracy.

## How the graph scores a proposition

Every node carries a breakdown of four independent signals that sum to its overall influence:

- **Novelty** — how different a proposition was from everything already in the graph the moment it first appeared. Fixed at first appearance; it describes what an idea added, not something that should keep changing afterward.
- **Contribution** — a diminishing-return count of how often the same canonical idea has been resubmitted (the second occurrence adds less than the first, the tenth barely moves it), so popularity by repetition alone has a hard ceiling.
- **Bridge** — how much a proposition connects otherwise distant parts of the graph, combining the diversity of neighboring domains with how semantically spread out its neighbors are from each other. A node whose neighbors already resemble each other scores low here even if it has many connections.
- **Stability** — a mix of how long an idea has persisted and how much real engagement it has drawn (reappearances, incoming and outgoing connections). Age alone caps out well below the maximum; an idea nobody ever returns to, connects, or contests can sit in the graph a long time without becoming "stable."

Connections between nodes come in two kinds. Most are relations the AI extracted directly from the text — implies, contradicts, completes, generalizes, specializes, is an alternative to, depends on, or questions another idea — and these accumulate weight every time the same relation is asserted again. A separate kind, rendered dashed in the interface, is generated automatically whenever two distinct propositions turn out to be highly similar in meaning without ever sharing an exact canonical identity — this is what keeps close paraphrases visibly connected instead of sitting in the graph as if unrelated.

## Optional setup: direct publishing

The site works with zero configuration — publishing falls back to the pre-filled Issue link automatically. Setting up direct, invisible publishing instead takes three steps:

1. **Create a GitHub OAuth App** (Settings → Developer settings → OAuth Apps → New OAuth App), then open its settings and enable **"Enable Device Flow"**. The homepage and callback URLs just need to point at your GitHub Pages URL — the callback itself is unused by this flow.
2. **Put the Client ID** (public information, not a secret) into `src/config.js` as `OAUTH_CLIENT_ID`.
3. **Deploy `proxy/worker.js`** to Cloudflare Workers (`cd proxy && npx wrangler deploy`) and put the resulting URL into `src/config.js` as `PROXY_URL`. This relay exists only because GitHub's two OAuth Device Flow exchange endpoints lack CORS headers — it never sees or stores your token, and the Device Flow itself never uses a client secret.

Once both values are set, the site detects it automatically and switches the "Publish" button to direct mode.

## Required setup

1. Set `OWNER`/`REPO` in `src/config.js` (already pointed at this repository).
2. Enable GitHub Pages on this repository (Settings → Pages → Source: GitHub Actions).
3. Under Settings → Actions → General → Workflow permissions, grant "Read and write permissions" so the processing workflow can commit the updated graph.

## Running it locally

Open `index.html`, at the repository root, through a real local server (module imports need `http://`, not `file://`), e.g. `npx serve .`. The processing scripts (`npm run validate`, `npm run process`) are meant to run inside the GitHub Actions workflow, but can be exercised locally against a file in `submissions/pending/` for testing.

## Honest limits

- **The extraction model hasn't been validated against high production volume.** It was chosen for being small enough to run affordably on a shared CI runner and compatible with the exact pipeline this project needs; if it starts falling back to minimal extraction systematically, that model choice is the first thing to check.
- **The similarity threshold for automatically-generated connections (0.72) is a reasonable starting guess, not an empirically tuned value.** It should be revisited once there's enough real submission volume to see whether the graph over- or under-connects paraphrases.
- **A proposition's domain is a closed set of ten categories chosen by the model at submission time, not an emergent grouping.** The bridge score partially depends on it; clustering embeddings directly instead would be a more principled long-term direction.
- **There is no proof of human uniqueness.** A determined actor can create multiple GitHub accounts; nothing here defends against that beyond the cost of doing so.
- **The graph's rendering has no upper bound built in.** Node repulsion is computed pairwise, which will need a spatial index if the graph grows into the thousands of nodes; embeddings are also stored as plain arrays of floats, which would benefit from a more compact format at scale.

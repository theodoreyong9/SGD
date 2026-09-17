# Semantic Graph Democracy — skeleton

Reference implementation of the process described in the project
document: a single submission action = search + navigation +
participation in the collective graph, with no for/against button.

## Architecture

```
Browser (GitHub Pages, static)
  ├─ WebLLM (src/semantic.js)          — local semantic parsing, PREVIEW ONLY
  ├─ Publishing — TWO possible paths, chosen automatically:
  │    (a) OAuth configured + connected → src/github-api.js creates the
  │        Issue DIRECTLY via the API, no redirect to github.com
  │    (b) otherwise → src/publish.js builds a pre-filled Issue link
  │        (legacy fallback, works with zero configuration)
  └─ Pure search ("Search" button) — direct embedding of the text, no WebLLM,
       consults the graph without ever preparing a submission

GitHub Actions (two workflows)
  ├─ process-submission.yml (issues: opened)
  │    → extracts `text` from the issue body (data, never executed code) —
  │      the rest of the JSON block (semantic, canonical_key) is ignored,
  │      even if a client still sends it
  │    → scripts/semantic-extract.mjs: SERVER-SIDE semantic extraction from
  │      `text` alone — it's THIS structure, never a client's, that
  │      determines canonical_key
  │    → if valid: updates data/graph.json, commits + pushes to main, closes the issue
  │    → if invalid: comments the reasons, closes the issue with no change
  └─ deploy.yml (push to main OR end of process-submission.yml)
       → republishes the site on GitHub Pages — see "Why two triggers" below
```

There's no more CORS relay, OAuth App, or fork/PR. See "Why this choice"
below for what changed compared to the previous version.

## Why semantic extraction now runs server-side

Until now, only the submitter's own browser ran the WebLLM extraction,
and the server only reverified that `canonical_key` matched the
`semantic` block declared by that same browser. That protects against a
forged hash in isolation, but not against a hand-crafted `semantic`
block unrelated to `text` while staying internally consistent with
itself — the submitter is precisely the party whose extraction
neutrality we wanted to guarantee. No hash check can detect this case:
structurally, it's a perfectly valid JSON.

`scripts/semantic-extract.mjs` eliminates the problem at the root
rather than detecting it after the fact: `scripts/validate-submission.mjs`
now reads ONLY `text` — any `semantic` block or `canonical_key` a
client might still send is purely and simply ignored, never passed
further down the pipeline. It's the server that extracts its own
structure, on a model that runs in the GitHub Actions runner — free and
unlimited on a public repo, same as for embeddings. The client-side
WebLLM (`src/semantic.js`) stays in use for the instant preview before
publication, but no longer has any protocol role: nothing it produces
is sent to the server.

Real cost of this change: latency. A CPU generation, even on a small
model, can take several tens of seconds — not a problem since
processing an Issue is already asynchronous.

## Why `deploy.yml` has two triggers

`process-submission.yml` pushes its commit with the Actions runner's
automatic `GITHUB_TOKEN`. GitHub **deliberately** blocks that token's
`push` event from chain-triggering another workflow — an infinite-loop
protection built into Actions, documented but easy to forget. Without
the second trigger (`workflow_run`, which listens for
`process-submission.yml` finishing rather than the push event itself),
the graph updates in the repo but the site keeps serving a stale
version indefinitely, until someone manually pushes something else to
`main`. That's exactly the symptom that occurred before this trigger
was added.

## Publishing: two paths, chosen automatically

The very first version of this project used a full OAuth flow (Device
Flow + relay + API calls) to publish directly, without ever opening
GitHub. It was then simplified to a plain pre-filled link — more
robust, zero configuration, but with a real drawback: every submission
redirects to `github.com` and requires a manual click on "Submit new
issue" there. This version restores direct publishing **in addition
to** the link, without sacrificing robustness: if OAuth isn't
configured, the site keeps working exactly as before.

### What made this possible

`api.github.com` natively supports CORS for authenticated requests
(`Access-Control-Allow-Origin: *`, verified directly) — a `fetch()`
from the browser to the GitHub API works without any relay, **once you
have a token**. The one remaining obstacle: the two OAuth Device Flow
exchange endpoints
(`github.com/login/device/code`, `github.com/login/oauth/access_token`)
don't have CORS (verified: they respond `404` to an `OPTIONS` request,
unlike `api.github.com` which responds `204` with CORS headers). So a
relay is needed — but only for these two specific calls, and **with no
secret to protect**: the Device Flow, unlike the classic "Authorization
Code" flow of "Login with GitHub" buttons, doesn't require a
`client_secret`. `proxy/worker.js` therefore only forwards two requests
while adding CORS headers — it holds nothing sensitive.

### The flow, in practice

1. **With no configuration** (`src/config.js` with default values):
   identical behavior to before — pre-filled link, redirect to GitHub,
   manual click on "Submit new issue".
2. **With OAuth configured**, first publication: the user clicks
   "Connect and publish" → a GitHub popup opens with a pre-filled
   8-character code → a click on "Authorize" there is enough → the
   token is stored in this browser's `localStorage`.
3. **Every subsequent publication**, in this same browser: a direct
   `fetch()` to `api.github.com/repos/OWNER/REPO/issues`, invisible,
   never opening GitHub. Real cost: the initial authorization click
   remains necessary (impossible to establish trust without a human
   confirming once on `github.com`), but it's never repeated.

### Setting up the direct flow (optional)

The site works without any of what follows — these steps are only
needed if you want invisible publishing rather than the link.

1. **Create a GitHub OAuth App**: Settings → Developer settings → OAuth
   Apps → New OAuth App. Homepage URL: your GitHub Pages URL
   (`https://theodoreyong9.github.io/SGD`). Authorization callback URL:
   required by the form but unused by the Device Flow — put the same
   URL. Once created, open the app's settings and check
   **"Enable Device Flow"**.
2. **Get the Client ID** (visible on the app's page — it's public data,
   not the secret) and paste it into `src/config.js`
   (`OAUTH_CLIENT_ID`). Never generate or use a client secret: the
   Device Flow doesn't need one.
3. **Deploy `proxy/worker.js`** on Cloudflare Workers (the free tier is
   enough):
   ```
   cd proxy
   npx wrangler deploy
   ```
   Copy the resulting `*.workers.dev` URL into `src/config.js`
   (`PROXY_URL`).
4. Reload the site: as soon as `OAUTH_CLIENT_ID` and `PROXY_URL` are no
   longer the default values, the connection pill appears and the
   "Publish" button automatically switches to direct mode.

## Minimal setup (required, regardless of publishing mode)

1. **Configure the target repo** in `src/config.js`: `OWNER`, `REPO`
   (already set to `theodoreyong9`/`SGD` in this delivery).
2. **Enable GitHub Pages** on this repo (Settings → Pages → Source: GitHub
   Actions). The `deploy.yml` workflow handles it on every push to `main`.
3. **Actions permissions**: Settings → Actions → General → Workflow
   permissions → "Read and write permissions", so that
   `process-submission.yml` can commit and push to `main`.
4. Nothing else is required for the site to work — publishing will go
   through the pre-filled link (see above) as long as the optional
   OAuth isn't configured.

## Security model — what's guaranteed and what isn't

**Guaranteed by construction:**
- An Issue's body is treated as **data**, never as **code**:
  `process-submission.yml` only ever reads it via
  `actions/github-script` (never interpolated into a shell string —
  the classic injection vector for `${{ github.event.issue.body }}` in
  a `run:` block), then passes it to `validate-submission.mjs`, which
  only does `JSON.parse` + schema check on `text` alone.
- **`semantic` and `canonical_key` are no longer fields the client can
  influence.** It's not just "reverified" anymore — these fields aren't
  even read from the issue anymore. The server extracts its own
  structure from `text` alone (`scripts/semantic-extract.mjs`) and
  derives `canonical_key` from it itself. A hand-crafted `semantic`
  block unrelated to `text` but internally consistent — the gap a
  simple hash reverification couldn't close — no longer has any effect
  at all: it's ignored.
- No third-party code is ever executed by CI (no equivalent of
  `pull_request_target` checking out external code — there's no PR at
  all in this flow anymore).
- Repeating the same canonical proposition has a diminishing marginal
  return (`1/n`), implemented in `scripts/process-graph.mjs`.
- **Both publishing paths produce the same Issue, processed
  identically.** Whether the submission goes through the pre-filled
  link or the direct API, `process-submission.yml` sees exactly the
  same Issue body and applies exactly the same validation — the choice
  of path changes nothing about the guarantees described here.
- **The OAuth token stored client-side** (`localStorage`, never sent to
  a server of ours) has a deliberately narrow scope (`public_repo`) —
  it only allows opening issues on public repos, nothing more. The
  relay (`proxy/worker.js`) never sees it: it only takes part in the
  initial exchange (device_code → token), never in its subsequent use.

**Not guaranteed, by structural limit:**
- **Request origin.** Nothing stops someone from forging an identical
  Issue via the GitHub API with their own token, outside the interface.
  This isn't a problem in this design: the validation pipeline
  evaluates content, not provenance — Sybil resistance that doesn't
  depend on "who" submits.
- **Human uniqueness.** A GitHub account has a cost to create at scale,
  but that's not proof of humanity. If you need that guarantee, an
  external mechanism is required.
- **Sybil resistance against rephrasing.** The diminishing return
  applies per **canonical** proposition: a patient attacker who slightly
  rephrases each submission (enough to change `canonical_key`, not
  enough to change the meaning) partially bypasses the decay. This could
  be hardened by penalizing an author whose recent submissions are
  mutually very close in embedding — but that would require storing a
  contributor identity per node, which this design deliberately avoids
  (a node's score never depends on who wrote it). Left as-is, knowingly.
- **Quality of server-side semantic extraction.** The model used by
  `scripts/semantic-extract.mjs` (`Xenova/TinyLlama-1.1B-Chat-v1.0`,
  ONNX/transformers.js compatible) **could not be validated under real
  conditions** at the time this pipeline was written — the availability
  and exact behavior of text-generation models with transformers.js
  evolve fast, and this choice was only verified on its
  parsing/fallback logic, not on actual generation. If extraction fails
  systematically in production (the minimal fallback triggering on
  every submission), start with this model name. The minimal fallback
  guarantees the pipeline always moves forward, at the cost of less
  informative nodes in the meantime.
- **Per-account rate-limiting is a circuit breaker, not proof of
  humanity.** It protects against a single account flooding the queue
  faster than the diminishing return can absorb, not against mass
  account creation.

## Implemented features

- **Direct, invisible publishing (optional)** (`src/oauth.js`,
  `src/github-api.js`, `proxy/worker.js`): Device Flow OAuth with no
  client secret, one-time authorization per browser, then direct API
  calls (`fetch()` to `api.github.com`, native CORS) for every
  subsequent submission — no more redirect to GitHub after the first
  connection. Automatically falls back to the pre-filled link if
  `src/config.js` isn't configured. See "Publishing: two paths" above.
- **Server-side semantic extraction** (`scripts/semantic-extract.mjs`):
  the only source of truth for a proposition's structure, computed from
  the submitted `text` alone — never from a client `semantic` block.
  See "Why semantic extraction now runs server-side" above.
- **Deterministic canonicalization** (`scripts/canonical.mjs`), applied
  to the structure extracted server-side above, never to a
  client-declared structure.
- **Diminishing marginal return** (`1/n`) on repeated submissions of the
  same canonical proposition.
- **Real semantic embeddings** (`all-MiniLM-L6-v2` via transformers.js,
  CPU/WASM) for novelty and relation matching — replaces keyword
  overlap. Two lexically very different paraphrases of the same content
  are now recognized as close. The model also runs client-side
  (`src/embeddings.js`, WASM) for the pre-publication preview, but only
  the server version (`scripts/embeddings.mjs`, after processing) is
  authoritative: this preview is never a guarantee, just UX.
- **Semantic bridge score** (`bridge`): now combines the diversity of
  *declared* neighboring domains (original signal) **and** the
  dispersion of these same neighbors' *embeddings* among themselves, in
  equal parts. A node whose neighbors are semantically dispersed
  genuinely connects ideas that wouldn't otherwise touch —
  independently of the domain label chosen by the LLM at submission
  time, which remains a closed enum of 10 values and therefore
  shouldn't carry the entire weight of the score. `similar` edges (see
  below) are explicitly excluded from this computation, so as not to
  dilute the dispersion with close paraphrases.
- **Stability through engagement, not just age** (`stability`): temporal
  persistence (age/30 days) now caps at 0.4 if the proposition has never
  been picked back up, connected, or contested since it first appeared.
  The rest of the score depends on two structural signals with no
  contributor identity: reappearances beyond the first, and number of
  accumulated edges.
- **Widened relation engine**: `questions` type, in addition to the
  original seven (`implies`, `contradicts`, `completes`, `generalizes`,
  `specializes`, `alternative_to`, `depends_on`), for contributions that
  raise a question without taking a stance — the central case from the
  founding document ("How should this transition be funded?"), which
  previously had nowhere to go in the graph.
- **Auto-generated `similar` edges** (`scripts/process-graph.mjs`,
  `upsertSimilarityEdges`): two distinct nodes (so not merged by
  `canonical_key`) whose embeddings exceed a high proximity threshold
  (0.72, deliberately higher than the `target_hint` → concept matching
  threshold) are now linked by an edge visible in `data/graph.json`,
  rendered dashed in the interface to stay distinct from asserted
  relations. Before this change, two paraphrases stayed visually
  unconnected despite strong semantic proximity.
- **Domain and relation normalization in the client preview**
  (`src/semantic.js`): the small local model (`Llama-3.2-1B-Instruct`)
  doesn't always follow the closed-enum instruction to the letter — it
  can produce a free-form phrase instead of one of the ten expected
  `domain` values. This value is normalized and falls back to "other"
  if it doesn't match anything known. Purely cosmetic now that the
  server extraction is independent (`scripts/semantic-extract.mjs`
  applies the same clamp on its own side, separately): it just avoids
  an inconsistent preview before publication, it no longer affects
  anything on the identity side.
- **Client-side submission tracking** (`src/tracker.js`, "Your
  submissions" panel): the Issues flow sends no notification back to
  the site once the user is back on GitHub. This module locally retains
  (`localStorage`, no account) a client-generated correlation
  identifier (`ref`, with no protocol role) and queries GitHub's public
  Search API to find the matching Issue (limited to 10 req/min without
  authentication — no automatic polling loop, only on load and on
  explicit click). Once the Issue is accepted, the REAL `canonical_key`
  — the one the server computed, never guessed client-side — is
  extracted from the closing comment posted by the workflow, then used
  to highlight the corresponding node in the graph as soon as it
  appears.
- **Pure search, separate from submission** ("Search" button): consults
  the graph by embedding similarity on the raw query text, without
  going through the generative WebLLM model (`src/semantic.js`, which
  requires WebGPU) or preparing any submission. Results are displayed
  ranked by similarity; clicking a result highlights the corresponding
  node in the graph. Distinct from the "Send" field, which builds a
  full semantic representation for a submission — two different
  operations that used to share the same button.
- **Visible influence breakdown**: each node exposes
  `stats.breakdown = {novelty, contribution, bridge, stability, influence}`,
  shown as bars in the interface.
- **AI synthesis of a sub-graph**: automatically invokes the
  already-loaded WebLLM model over all propositions in a domain —
  derived view generated on demand, never stored as reference data.
- **Two-level navigation (landscape / region)**: clicking a node in the
  graph dims everything outside its domain (`src/graph-render.js`,
  `setFocusDomain`); a "View full graph" button resets it. This is a
  visual filter on the existing graph, not a real "topic = recomputed
  sub-graph" level — see Known limits.
- **Publishing with no third-party account, no OAuth, no relay**
  (`src/publish.js`, `.github/workflows/process-submission.yml`):
  pre-filled GitHub Issue, fully revalidated server-side.
- **Per-GitHub-account rate-limiting** (30 submissions/24h by default,
  adjustable in `scripts/validate-submission.mjs`), checked via
  GitHub's Search API filtered on the `sgd-submission` label, applied
  even to invalid issues to avoid free spam via malformed JSON.

## Known limits

- **Direct OAuth flow not tested end-to-end under real conditions.**
  The logic in `src/oauth.js`/`src/github-api.js`/`proxy/worker.js` has
  been checked point by point (real CORS support of `api.github.com`
  confirmed by a direct request, absence of CORS on the Device Flow
  endpoints confirmed the same way, Device Flow requirements verified
  against GitHub's documentation), but I couldn't perform a full Device
  Flow authorization myself — it requires a human GitHub account
  clicking "Authorize", which an automated environment can't simulate.
  Test this path first after deployment if something doesn't work as
  expected.

- **Server extraction model unverified under real conditions, and its
  associated latency.** See "Security model" above — the model choice
  in `scripts/semantic-extract.mjs` is the top thing to watch if the
  pipeline systematically falls back to minimal extraction. Every
  submission now potentially takes several tens of seconds to process
  (CPU generation), versus a few hundred milliseconds before this
  change (which only computed a server-side embedding, never text
  generation).
- **`similar` edge threshold not empirically calibrated.** 0.72 is a
  reasonable but arbitrary choice, set with no real dataset to validate
  it — to adjust once there are enough submissions to observe whether
  the graph over-connects (threshold too low) or under-connects (too
  high) paraphrases.
- **The 5th "structural diversity" axis (proposed in design
  discussions, distinct from novelty by *content*) isn't implemented.**
  What it would precisely capture beyond `novelty` and `bridge` remains
  to be demonstrated on real cases before giving it its own formula —
  added lightly, it would likely be redundant.
- **`domain` remains a closed enum, not an emergent space.** The
  `bridge` score still partly depends on it (see above); a real next
  step would be clustering the embeddings themselves rather than having
  the LLM pick a fixed category on every submission.
- **No real "topic" level.** The project's doctrine distinguishes three
  levels (landscape / region / topic), where a "topic" is a
  *recomputed* sub-graph, not a filter. This skeleton only implements
  the first two.
- **Sybil resistance against rephrasing**: see "Security model" above.
- A real proof of human uniqueness, if the protocol ever needs to depend
  on one (deliberately absent today).
- Client-side pagination/display limit for the graph beyond a few
  thousand nodes (the `canvas` rendering in `graph-render.js` is O(n²)
  on repulsions, to be replaced with a quadtree if the graph grows
  significantly).
- Real storage of embeddings in a compact binary format rather than a
  JSON array of 384 floats per node, if `data/graph.json` grows large.

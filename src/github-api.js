// Fork -> branch off upstream's current HEAD -> commit one new file -> open PR.
// api.github.com supports CORS natively, so everything here runs directly
// from the browser with the user's own token — no relay needed past this point.

const UPSTREAM_OWNER = "YOUR_GITHUB_ORG_OR_USER";
const UPSTREAM_REPO = "YOUR_REPO_NAME";
const BASE_BRANCH = "main";

const API = "https://api.github.com";

function headers(token) {
  return {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };
}

async function gh(path, token, options = {}) {
  const res = await fetch(`${API}${path}`, { ...options, headers: headers(token) });
  if (!res.ok && res.status !== 202) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status} sur ${path}: ${body}`);
  }
  return res.status === 204 ? null : res.json();
}

// Idempotent: returns immediately if the fork already exists.
export async function ensureFork(token, login) {
  const existing = await fetch(`${API}/repos/${login}/${UPSTREAM_REPO}`, {
    headers: headers(token),
  });
  if (existing.ok) return existing.json();

  await gh(`/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/forks`, token, { method: "POST" });

  // Fork creation is asynchronous on GitHub's side — poll briefly.
  for (let i = 0; i < 10; i++) {
    await sleep(1500);
    const res = await fetch(`${API}/repos/${login}/${UPSTREAM_REPO}`, {
      headers: headers(token),
    });
    if (res.ok) return res.json();
  }
  throw new Error("Le fork n'a pas été créé à temps, réessayez dans quelques secondes.");
}

// Submits one canonical submission file as a PR. Returns the PR URL.
export async function submitProposal({ token, login, filename, submission }) {
  await ensureFork(token, login);

  // Branch from upstream's CURRENT HEAD (not the fork's, which may be stale) —
  // fork and upstream share git objects, so this is always valid.
  const upstreamRef = await gh(
    `/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/git/ref/heads/${BASE_BRANCH}`,
    token
  );
  const baseSha = upstreamRef.object.sha;
  const branchName = `submit/${filename.replace(/\.json$/, "")}`;

  // Create (or reuse) the branch on the fork.
  const branchExists = await fetch(
    `${API}/repos/${login}/${UPSTREAM_REPO}/git/ref/heads/${branchName}`,
    { headers: headers(token) }
  );
  if (!branchExists.ok) {
    await gh(`/repos/${login}/${UPSTREAM_REPO}/git/refs`, token, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
    });
  }

  const path = `submissions/pending/${filename}`;
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(submission, null, 2))));

  await gh(`/repos/${login}/${UPSTREAM_REPO}/contents/${path}`, token, {
    method: "PUT",
    body: JSON.stringify({
      message: `Soumission: ${filename}`,
      content,
      branch: branchName,
    }),
  });

  const pr = await gh(`/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/pulls`, token, {
    method: "POST",
    body: JSON.stringify({
      title: `Soumission — ${submission.semantic.domain}: ${submission.text.slice(0, 60)}`,
      head: `${login}:${branchName}`,
      base: BASE_BRANCH,
      body:
        "Soumission automatique via l'interface web.\n\n" +
        "Ce PR n'ajoute qu'un seul fichier sous `submissions/pending/`. " +
        "Il sera validé et fusionné automatiquement si le contenu respecte le schéma attendu.",
    }),
  });

  return pr.html_url;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

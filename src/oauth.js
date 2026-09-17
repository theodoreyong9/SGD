// GitHub Device Flow authentication — establishes a token ONCE that the
// browser then reuses to publish directly via the API
// (src/github-api.js), never reopening GitHub on every submission.
//
// The Device Flow does NOT require a client_secret (unlike the classic
// "Authorization Code" flow used by most "Login with GitHub" buttons)
// — see proxy/worker.js for why a relay is still needed regardless:
// only to work around the lack of CORS on the 2 exchange endpoints,
// never to protect a secret (there is none).
//
// Real cost of this approach compared to the previous Issue link: the
// user must visit github.com **once** (or occasionally, if the token is
// revoked) to authorize the app by entering an 8-character code. After
// that, every later submission in THIS browser is a direct, invisible
// API call — no more round trip to GitHub.

import { PROXY_URL, OAUTH_CLIENT_ID } from "./config.js";

const TOKEN_STORAGE_KEY = "sgd_github_token";
// public_repo is enough to open issues on a public repo — no need for a
// wider scope (no access to private repos, no account access beyond
// what's necessary).
const SCOPE = "public_repo";

export function getStoredToken() {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function clearStoredToken() {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function storeToken(token) {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Private browsing or quota exceeded — the token won't survive a
    // reload, the user will have to re-authenticate. Degraded, not broken.
  }
}

// isTokenValid(token): checks that a stored token hasn't been revoked,
// by calling the API DIRECTLY (no need for the relay here —
// api.github.com natively supports CORS for authenticated requests,
// verified).
export async function isTokenValid(token) {
  if (!token) return false;
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export class DeviceFlowError extends Error {}

// startDeviceFlow(onUserCode) -> Promise<string> (the token, once authorized)
//
// onUserCode({ userCode, verificationUri }) is called as soon as the
// code is available, so the UI can display it and offer to open the
// authorization page (verification_uri_complete pre-fills the code, a
// single click is enough on the user's side). The promise only
// resolves once authorization is confirmed on GitHub's side — internal
// polling, respecting the interval GitHub imposes to avoid rate-limiting.
export async function startDeviceFlow(onUserCode) {
  const codeRes = await fetch(`${PROXY_URL}/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: OAUTH_CLIENT_ID, scope: SCOPE }),
  });
  if (!codeRes.ok) {
    throw new DeviceFlowError("Couldn't start GitHub authorization (relay unavailable?).");
  }
  const {
    device_code,
    user_code,
    verification_uri,
    verification_uri_complete,
    interval,
    expires_in,
  } = await codeRes.json();

  onUserCode({
    userCode: user_code,
    verificationUri: verification_uri_complete || verification_uri,
  });

  const deadline = Date.now() + expires_in * 1000;
  let pollInterval = Math.max(interval, 5) * 1000;

  while (Date.now() < deadline) {
    await sleep(pollInterval);

    const tokenRes = await fetch(`${PROXY_URL}/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: OAUTH_CLIENT_ID,
        device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const data = await tokenRes.json();

    if (data.access_token) {
      storeToken(data.access_token);
      return data.access_token;
    }
    if (data.error === "authorization_pending") continue;
    if (data.error === "slow_down") {
      pollInterval += 5000;
      continue;
    }
    throw new DeviceFlowError(
      `GitHub authorization denied or expired: ${data.error_description || data.error}`
    );
  }

  throw new DeviceFlowError("Authorization timed out — try again.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

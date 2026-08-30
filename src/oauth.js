// GitHub OAuth Device Flow — token never touches any server we control.
// The relay (proxy/worker.js) only forwards bytes; the token it returns
// goes straight into the browser's memory/sessionStorage, same place it
// would end up if the person had typed it in themselves.
//
// Scope is minimal: "public_repo" only. This app never asks for access to
// private repositories or account-wide permissions.

const PROXY_BASE = "https://sgd-oauth-relay.YOUR-SUBDOMAIN.workers.dev"; // set after `wrangler deploy`
const CLIENT_ID = "YOUR_GITHUB_OAUTH_APP_CLIENT_ID"; // public value, safe to ship in client code
const SCOPE = "public_repo";
const TOKEN_STORAGE_KEY = "sgd_gh_token"; // sessionStorage — cleared when the tab closes

export function getStoredToken() {
  try {
    const raw = sessionStorage.getItem(TOKEN_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function storeToken(token, login) {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify({ token, login }));
}

export function signOut() {
  sessionStorage.removeItem(TOKEN_STORAGE_KEY);
}

// startDeviceFlow(onStatus) resolves with { token, login } once the user has
// authorized the app on github.com/login/device. onStatus(code, verificationUri)
// is called once so the UI can show the code to the user.
export async function startDeviceFlow(onStatus) {
  const deviceResp = await fetch(`${PROXY_BASE}/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPE }),
  }).then((r) => r.json());

  if (deviceResp.error) {
    throw new Error(`Échec de la demande de code: ${deviceResp.error_description || deviceResp.error}`);
  }

  const {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    interval = 5,
    expires_in: expiresIn = 900,
  } = deviceResp;

  onStatus({ userCode, verificationUri });

  const deadline = Date.now() + expiresIn * 1000;
  let pollInterval = interval;

  while (Date.now() < deadline) {
    await sleep(pollInterval * 1000);

    const tokenResp = await fetch(`${PROXY_BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    }).then((r) => r.json());

    if (tokenResp.access_token) {
      const login = await fetchLogin(tokenResp.access_token);
      storeToken(tokenResp.access_token, login);
      return { token: tokenResp.access_token, login };
    }

    if (tokenResp.error === "authorization_pending") continue;
    if (tokenResp.error === "slow_down") {
      pollInterval += 5;
      continue;
    }
    throw new Error(`Échec de l'authentification: ${tokenResp.error_description || tokenResp.error}`);
  }

  throw new Error("Le code a expiré avant validation. Réessayez.");
}

async function fetchLogin(token) {
  const res = await fetch("https://api.github.com/user", {
    headers: { Authorization: `token ${token}`, Accept: "application/vnd.github+json" },
  });
  const data = await res.json();
  return data.login;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

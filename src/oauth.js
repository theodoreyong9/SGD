// Authentification GitHub Device Flow — établit UNE FOIS un token que le
// navigateur réutilise ensuite pour publier directement via l'API
// (src/github-api.js), sans jamais rouvrir GitHub à chaque soumission.
//
// Le Device Flow ne nécessite PAS de client_secret (contrairement au flow
// "Authorization Code" classique utilisé par la plupart des boutons
// "Login with GitHub") — voir proxy/worker.js pour pourquoi un relais
// reste malgré tout nécessaire : uniquement pour contourner l'absence de
// CORS sur les 2 endpoints d'échange, jamais pour protéger un secret (il
// n'y en a pas).
//
// Coût réel de cette approche par rapport au lien d'Issue précédent :
// l'utilisateur doit visiter github.com **une fois** (ou occasionnellement,
// si le token est révoqué) pour autoriser l'app en entrant un code à 8
// caractères. Après ça, toute soumission ultérieure dans CE navigateur
// est un appel API direct et invisible — plus aucun aller-retour GitHub.

import { PROXY_URL, OAUTH_CLIENT_ID } from "./config.js";

const TOKEN_STORAGE_KEY = "sgd_github_token";
// public_repo suffit pour ouvrir des issues sur un dépôt public — pas
// besoin d'un scope plus large (pas d'accès aux repos privés, pas
// d'accès au compte au-delà de ce qui est nécessaire).
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
    // Navigation privée ou quota dépassé — le token ne survivra pas au
    // rechargement, l'utilisateur devra se réauthentifier. Dégradé, pas cassé.
  }
}

// isTokenValid(token): vérifie qu'un token stocké n'a pas été révoqué, en
// appelant DIRECTEMENT l'API (pas besoin du relais ici — api.github.com
// supporte CORS nativement pour les requêtes authentifiées, vérifié).
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

// startDeviceFlow(onUserCode) -> Promise<string> (le token, une fois autorisé)
//
// onUserCode({ userCode, verificationUri }) est appelé dès que le code est
// disponible, pour que l'UI puisse l'afficher et proposer d'ouvrir la page
// d'autorisation (verification_uri_complete pré-remplit le code, un seul
// clic suffit côté utilisateur). La promesse ne se résout qu'une fois
// l'autorisation confirmée côté GitHub — poll interne, respectant
// l'intervalle imposé par GitHub pour éviter le rate-limiting.
export async function startDeviceFlow(onUserCode) {
  const codeRes = await fetch(`${PROXY_URL}/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: OAUTH_CLIENT_ID, scope: SCOPE }),
  });
  if (!codeRes.ok) {
    throw new DeviceFlowError("Impossible de démarrer l'autorisation GitHub (relais indisponible ?).");
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
      `Autorisation GitHub refusée ou expirée: ${data.error_description || data.error}`
    );
  }

  throw new DeviceFlowError("Délai d'autorisation dépassé — réessayez.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

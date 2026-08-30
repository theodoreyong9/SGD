// Minimal CORS relay for GitHub's OAuth Device Flow endpoints.
//
// WHY THIS EXISTS: github.com/login/device/code and github.com/login/oauth/access_token
// do not send Access-Control-Allow-Origin, so a browser fetch() to them fails with a
// CORS error even though the Device Flow is designed to be used without a client secret.
// This worker does nothing except forward the request byte-for-byte and add CORS headers.
//
// IT HOLDS NO SECRET. The GitHub OAuth App's client_id is public by design (it is sent
// from the browser anyway). Device Flow never requires a client_secret. If you find
// yourself wanting to add a secret here, stop — that would turn this relay into a
// privileged component, defeating the point of keeping it stateless and disposable.
//
// Deploy: `wrangler deploy` (see wrangler.toml). Point src/oauth.js's PROXY_BASE at
// the resulting *.workers.dev URL.

const ALLOWED_TARGETS = {
  "/device/code": "https://github.com/login/device/code",
  "/token": "https://github.com/login/oauth/access_token",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // tighten to your Pages origin in production
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const target = ALLOWED_TARGETS[url.pathname];
    if (!target || request.method !== "POST") {
      return new Response("Not found", { status: 404, headers: CORS_HEADERS });
    }

    const upstream = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: await request.text(),
    });

    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  },
};

// Minimal relay, WITH NO SECRET — used ONLY to work around the lack of
// CORS on GitHub's two OAuth Device Flow exchange endpoints
// (login/device/code, login/oauth/access_token — verified: they respond
// 404 to an OPTIONS request, unlike api.github.com which responds 204
// with Access-Control-Allow-Origin: *).
//
// This relay holds NO sensitive data whatsoever: the Device Flow
// doesn't require a client_secret (unlike the classic "Authorization
// Code" flow) — so there's nothing to protect here, just CORS to add to
// two calls. Everything else (Issue creation, status reads) goes as a
// direct call from the browser to api.github.com, which natively
// supports CORS — see src/github-api.js.
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: cors });
    }

    let target;
    if (url.pathname === "/device/code") {
      target = "https://github.com/login/device/code";
    } else if (url.pathname === "/device/token") {
      target = "https://github.com/login/oauth/access_token";
    } else {
      return new Response("Not found", { status: 404, headers: cors });
    }

    const body = await request.text();
    const upstream = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body,
    });

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  },
};

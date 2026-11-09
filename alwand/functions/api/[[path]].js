// Cloudflare Pages Function — proxies /api/* to the Apps Script Web App.
// Runs on the same origin as the site, so no CORS is needed on the browser side.

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const action = url.pathname.replace(/^\/api\//, "").replace(/\/+$/, "");

  const APPS_URL = env.APPS_SCRIPT_URL;
  if (!APPS_URL) return json({ error: "APPS_SCRIPT_URL not set" }, 500);

  try {
        if (request.method === "GET") {
      const target = `${APPS_URL}?action=${encodeURIComponent(action)}`;
      const resp = await fetch(target, { redirect: "follow" });
      const text = await resp.text();

      // If Google returns HTML (like a login page), catch it and return a JSON error
      if (text.trim().startsWith("<")) {
        return json({ error: "Google Apps Script returned HTML. Check deployment permissions." }, 500);
      }

      return json(text);
    }

    if (request.method === "POST") {
      // Wrap the browser payload with the action so Apps Script doPost can route it
      const body = await request.json();
      const wrapped = JSON.stringify({ action, payload: body });

      const resp = await fetch(APPS_URL, {
        method: "POST",
        // text/plain avoids a redirect/preflight quirk with Apps Script's /exec
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: wrapped,
        redirect: "follow",
      });
      const text = await resp.text();
      return json(text);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

function json(body, status = 200) {
  return new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    }
  );
}

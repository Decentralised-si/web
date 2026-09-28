// decentralised.si is the canonical website. The .ai domains have their own landing page
// (the network story) at "/"; every other path on an alias domain redirects to the canonical
// site so there is one origin (one app session).
//
// "/" always plays the intro film (/intro). The landing page lives at /home: "Skip intro",
// "Enter the site", the old /?intro=skip link and every "Home"/logo link go there.
// Crawlers and link-preview bots get the landing page at "/" so the site stays indexable.
const CANONICAL = "decentralised.si";
const AI_HOSTS = new Set(["decentralised.ai", "www.decentralised.ai", "decentralise.ai", "www.decentralise.ai"]);
const ALIASES = new Set(["www.decentralised.si", "decentralise.si", "www.decentralise.si", ...AI_HOSTS]);
// Pages and files renamed since publication.
const MOVED = { "/install/oifd.sh": "/install/synapse.sh", "/install/oifd.ps1": "/install/synapse.ps1" };
const BOTS = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|whatsapp|telegram|discord|slack|linkedin|twitter|pinterest|vkshare|quora|redditbot|applebot|bingpreview|headless/i;

function withHeaders(res, extra) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(extra)) r.headers.set(k, v);
  return r;
}

async function asset(env, request, url, pathname) {
  const u = new URL(url);
  u.pathname = pathname;
  u.search = "";
  return env.ASSETS.fetch(new Request(u, request));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isAi = AI_HOSTS.has(url.hostname);
    if (MOVED[url.pathname]) return Response.redirect(new URL(MOVED[url.pathname], url).toString(), 301);

    // Only redirect once the canonical domain actually resolves; until then every alias serves the site itself.
    if (env.CANONICAL_LIVE === "true" && ALIASES.has(url.hostname) && !(isAi && url.pathname === "/")) {
      url.hostname = CANONICAL;
      url.protocol = "https:";
      url.port = "";
      return Response.redirect(url.toString(), 301);
    }

    const landing = isAi ? "/ai" : "/";
    const html = (res) => withHeaders(res, { "cache-control": "private, no-cache", vary: "User-Agent" });
    if (url.pathname === "/home") return html(await asset(env, request, url, landing));
    if (url.pathname === "/") {
      if (url.searchParams.has("intro")) {
        url.searchParams.delete("intro");
        return new Response(null, { status: 302, headers: { location: "/home" + url.search, "cache-control": "no-store" } });
      }
      const bot = BOTS.test(request.headers.get("user-agent") || "");
      return html(await asset(env, request, url, bot ? landing : "/intro"));
    }

    return env.ASSETS.fetch(request);
  },
};

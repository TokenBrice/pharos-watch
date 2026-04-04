#!/usr/bin/env node
/**
 * Dev-only proxy that authenticates local API requests against the production
 * site-api, mimicking the Cloudflare Pages Functions site-data proxy.
 *
 * Reads SITE_API_SHARED_SECRET from the environment (loaded via --env-file).
 * If the secret is missing the process exits silently so `npm run dev` still
 * starts the Next.js dev server — just without authenticated API data.
 */

import { createServer } from "node:http";

const SECRET = process.env.SITE_API_SHARED_SECRET?.trim();
const UPSTREAM_ORIGIN =
  process.env.DEV_PROXY_UPSTREAM || "https://site-api.pharos.watch";
const PORT = parseInt(process.env.DEV_PROXY_PORT || "3001", 10);

const FORWARDED_HEADERS = [
  "cache-control",
  "content-type",
  "etag",
  "last-modified",
  "warning",
  "x-data-age",
];

if (!SECRET) {
  console.warn(
    "[dev-proxy] SITE_API_SHARED_SECRET not found in environment.\n" +
      "            Add it to .env.local for authenticated API access in dev.\n" +
      "            Protected endpoints will return 401 without it.",
  );
  process.exit(0);
}

const server = createServer(async (req, res) => {
  const local = new URL(req.url || "/", `http://localhost:${PORT}`);
  const upstream = new URL(local.pathname + local.search, UPSTREAM_ORIGIN);

  try {
    const upstreamRes = await fetch(upstream.toString(), {
      method: "GET",
      headers: {
        "X-Pharos-Site-Proxy-Secret": SECRET,
        Accept: req.headers.accept || "application/json",
      },
    });

    const headers = {};
    for (const name of FORWARDED_HEADERS) {
      const value = upstreamRes.headers.get(name);
      if (value) headers[name] = value;
    }

    const body = Buffer.from(await upstreamRes.arrayBuffer());
    res.writeHead(upstreamRes.status, headers);
    res.end(body);
  } catch (err) {
    console.error(`[dev-proxy] ${req.url} → ${err.message}`);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Dev proxy upstream error" }));
  }
});

process.on("SIGINT", () => {
  server.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`[dev-proxy] localhost:${PORT} → ${UPSTREAM_ORIGIN}`);
});

#!/usr/bin/env node
/**
 * Dev-only proxy that authenticates local API requests against the production
 * site-api, mimicking the Cloudflare Pages Functions site-data proxy.
 *
 * Reads SITE_API_SHARED_SECRET from the environment (loaded via --env-file).
 * If the secret is missing the process exits silently so `npm run dev` still
 * starts the Next.js dev server — just without authenticated API data.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const envFile = resolve(".env.local");

if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const SECRET = process.env.SITE_API_SHARED_SECRET?.trim();
const DEFAULT_UPSTREAM_ORIGIN = "https://site-api.pharos.watch";
const PORT = parseInt(process.env.DEV_PROXY_PORT || "3001", 10);
const ALLOWED_UPSTREAM_HOSTS = new Set(["site-api.pharos.watch", "localhost", "127.0.0.1", "[::1]"]);
const ALLOWED_PATH_PREFIX = "/api/";

function resolveUpstreamOrigin(rawOrigin?: string): string {
  const parsed = new URL(rawOrigin || DEFAULT_UPSTREAM_ORIGIN);
  const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (!ALLOWED_UPSTREAM_HOSTS.has(parsed.hostname) || (parsed.protocol !== "https:" && !isLocalhost)) {
    throw new Error(`DEV_PROXY_UPSTREAM must target ${DEFAULT_UPSTREAM_ORIGIN} or a local development server`);
  }
  return parsed.origin;
}

function resolveProxyPath(rawUrl?: string): string {
  const local = new URL(rawUrl || "/", `http://localhost:${PORT}`);
  if (!local.pathname.startsWith(ALLOWED_PATH_PREFIX)) {
    throw new Error("Dev proxy only forwards /api/* requests");
  }

  let decodedSegments;
  try {
    decodedSegments = local.pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    throw new Error("Dev proxy request path must use valid URL encoding");
  }
  if (decodedSegments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("Dev proxy request path must not contain path traversal segments");
  }

  const pathname = `/${decodedSegments.map((segment) => encodeURIComponent(segment)).join("/")}`;
  const query = [...local.searchParams.entries()]
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return query ? `${pathname}?${query}` : pathname;
}

let UPSTREAM_ORIGIN: string;
try {
  UPSTREAM_ORIGIN = resolveUpstreamOrigin(process.env.DEV_PROXY_UPSTREAM);
} catch (err: unknown) {
  console.error(`[dev-proxy] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (!Number.isFinite(PORT) || PORT <= 0) {
  console.error(`[dev-proxy] Invalid DEV_PROXY_PORT: ${process.env.DEV_PROXY_PORT}`);
  process.exit(1);
}

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

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    const upstream = new URL(resolveProxyPath(req.url), UPSTREAM_ORIGIN);
    // codeql[js/request-forgery] UPSTREAM_ORIGIN is allowlisted above, and resolveProxyPath only permits normalized /api/* paths.
    const upstreamRes = await fetch(upstream.toString(), {
      method: "GET",
      redirect: "error",
      headers: {
        "X-Pharos-Site-Proxy-Secret": SECRET,
        Accept: (req.headers.accept || "application/json") as string,
      },
    });

    const headers: Record<string, string> = {};
    for (const name of FORWARDED_HEADERS) {
      const value = upstreamRes.headers.get(name);
      if (value) headers[name] = value;
    }

    const body = Buffer.from(await upstreamRes.arrayBuffer());
    res.writeHead(upstreamRes.status, headers);
    res.end(body);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Dev proxy request path")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid dev proxy path" }));
      return;
    }
    if (err instanceof Error && err.message.startsWith("Dev proxy only forwards")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unsupported dev proxy path" }));
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[dev-proxy] ${req.url} → ${message}`);
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

server.on("error", (err) => {
  const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
  if (code === "EADDRINUSE") {
    console.warn(
      `[dev-proxy] localhost:${PORT} is already in use; skipping local API proxy.\n` +
        "            Stop the existing process or set DEV_PROXY_PORT to run another proxy.",
    );
    process.exit(0);
  }

  const message = err instanceof Error ? err.message : String(err);
  console.error(`[dev-proxy] Failed to listen on localhost:${PORT}: ${message}`);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`[dev-proxy] localhost:${PORT} → ${UPSTREAM_ORIGIN}`);
});

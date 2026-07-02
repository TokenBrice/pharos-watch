#!/usr/bin/env node

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { brotliCompress, gzip } from "node:zlib";
import { promisify } from "node:util";
import {
  addNonceToInlineScripts,
  buildContentSecurityPolicy,
  createCspNonce,
  isTelegramMiniAppPath,
} from "../../shared/lib/site-csp.ts";
import origins from "../../shared/lib/runtime-origins.json" with { type: "json" };
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ndjson": "application/x-ndjson; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
};

const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

const COMPRESSIBLE_CONTENT_TYPES = [
  "application/javascript",
  "application/json",
  "application/rss+xml",
  "application/xml",
  "image/svg+xml",
  "text/css",
  "text/csv",
  "text/html",
  "text/plain",
];

function isCompressibleContentType(contentType) {
  return COMPRESSIBLE_CONTENT_TYPES.some((candidate) => contentType.startsWith(candidate));
}

function pickAcceptedCompression(acceptEncoding = "") {
  const accepted = acceptEncoding.toLowerCase();
  if (accepted.includes("br")) return "br";
  if (accepted.includes("gzip")) return "gzip";
  return null;
}

async function maybeCompressStaticBody(body, contentType, acceptEncoding) {
  if (body.byteLength < 1024 || !isCompressibleContentType(contentType)) {
    return { body, encoding: null };
  }

  const encoding = pickAcceptedCompression(acceptEncoding);
  if (encoding === "br") {
    return { body: await brotliCompressAsync(body), encoding };
  }
  if (encoding === "gzip") {
    return { body: await gzipAsync(body), encoding };
  }
  return { body, encoding: null };
}

const EXCLUDED_PROXY_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "transfer-encoding",
]);

export function resolveStaticFilePath(rootDir, requestPathname) {
  const decodedPath = decodeURIComponent(requestPathname);
  const relativePath = decodedPath.replace(/^\/+/, "");
  let candidate = path.resolve(rootDir, relativePath);

  if (decodedPath.endsWith("/")) {
    candidate = path.join(candidate, "index.html");
  } else if (!path.extname(candidate)) {
    candidate = path.join(candidate, "index.html");
  }

  const relativeCandidatePath = path.relative(rootDir, candidate);
  if (relativeCandidatePath.startsWith("..") || path.isAbsolute(relativeCandidatePath)) {
    throw new Error(`Path escapes static export root: ${requestPathname}`);
  }

  return candidate;
}

function buildContentType(filePath, requestPathname = "") {
  if (requestPathname.startsWith("/feed/") && requestPathname.endsWith(".xml")) {
    return "application/rss+xml; charset=utf-8";
  }
  return CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream";
}

function getProxyBaseUrl() {
  const configured = (process.env.STATIC_EXPORT_API_BASE ?? "").trim();
  return configured || origins.apiOrigin;
}

function getSiteProxyBaseUrl() {
  const configured = (process.env.STATIC_EXPORT_SITE_API_BASE ?? "").trim();
  return configured || getProxyBaseUrl();
}

let siteDataResolverPromise;

async function getSiteDataResolver() {
  if (!siteDataResolverPromise) {
    siteDataResolverPromise = import("../../shared/lib/site-data-lane.ts").then(
      (module) => module.resolveSiteDataUpstreamPath,
    );
  }
  return siteDataResolverPromise;
}

function getProxyApiKey() {
  return (process.env.STATIC_EXPORT_API_KEY ?? "").trim();
}

async function readRequestBody(req, method) {
  if (method === "GET" || method === "HEAD") {
    return undefined;
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

function buildForwardedRequestHeaders(req, extraHeaders = {}) {
  const forwarded = {};
  for (const name of ["accept", "content-type", "idempotency-key", "x-pharos-admin"]) {
    const value = req.headers[name];
    if (Array.isArray(value)) {
      forwarded[name] = value.join(", ");
    } else if (value) {
      forwarded[name] = value;
    }
  }
  return {
    Accept: "application/json",
    "User-Agent": "pharos-static-export-smoke/1.0",
    ...forwarded,
    ...extraHeaders,
  };
}

async function proxyApiRequest(targetUrl, method, headers = {}, body) {
  const apiKey = getProxyApiKey();
  return fetch(targetUrl, {
    method,
    headers: {
      ...(apiKey ? { "X-API-Key": apiKey } : {}),
      ...headers,
    },
    body,
  });
}

async function readStaticExportFile(rootDir, requestPathname) {
  const filePath = resolveStaticFilePath(rootDir, requestPathname);
  const file = await readFile(filePath);
  return { file, filePath };
}

async function sendStaticExportFile(req, res, method, { file, filePath }, requestPathname) {
  const contentType = buildContentType(filePath, requestPathname);
  const headers = {
    "Content-Type": contentType,
    "Vary": "Accept-Encoding",
  };
  let body = file;

  if (contentType.startsWith("text/html")) {
    const nonce = createCspNonce();
    body = Buffer.from(addNonceToInlineScripts(file.toString("utf8"), nonce), "utf8");
    headers["Content-Security-Policy"] = buildContentSecurityPolicy(nonce, {
      telegramMiniApp: isTelegramMiniAppPath(requestPathname),
    });
    headers["Cloudflare-CDN-Cache-Control"] = "no-store";
    headers["CDN-Cache-Control"] = "no-store";
    if (isTelegramMiniAppPath(requestPathname)) {
      headers["X-Robots-Tag"] = "noindex, nofollow";
    }
  }

  const compressed = await maybeCompressStaticBody(body, contentType, req.headers["accept-encoding"]);
  body = compressed.body;
  if (compressed.encoding) {
    headers["Content-Encoding"] = compressed.encoding;
  }

  res.writeHead(200, {
    ...headers,
    "Content-Length": String(body.byteLength),
  });
  if (method === "HEAD") {
    res.end();
  } else {
    res.end(body);
  }
}

function isPathEscapeError(error) {
  return error instanceof Error && error.message.startsWith("Path escapes static export root:");
}

export function createStaticExportServer({
  apiBaseUrl = getProxyBaseUrl(),
  siteApiBaseUrl = getSiteProxyBaseUrl(),
  host = process.env.STATIC_EXPORT_HOST ?? "127.0.0.1",
  port = Number.parseInt(process.env.STATIC_EXPORT_PORT ?? "4173", 10),
  rootDir = path.resolve(process.cwd(), process.env.STATIC_EXPORT_ROOT ?? "out"),
} = {}) {
  const normalizedRoot = path.resolve(rootDir);
  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", `http://${host}:${port}`);
    const method = req.method ?? "GET";

    const isNestedApiPath = requestUrl.pathname.startsWith("/api/") && requestUrl.pathname !== "/api/";
    const isSiteDataPath = requestUrl.pathname.startsWith("/_site-data/");
    const canServeStaticMethod = method === "GET" || method === "HEAD";

    if (isNestedApiPath && canServeStaticMethod) {
      try {
        const staticFile = await readStaticExportFile(normalizedRoot, requestUrl.pathname);
        await sendStaticExportFile(req, res, method, staticFile, requestUrl.pathname);
        return;
      } catch (error) {
        if (isPathEscapeError(error)) {
          res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Forbidden");
          return;
        }
      }
    }

    if (
      isNestedApiPath
      || isSiteDataPath
    ) {
      if (isSiteDataPath && !canServeStaticMethod) {
        res.writeHead(405, { Allow: "GET, HEAD" });
        res.end();
        return;
      }

      try {
        const resolveSiteDataUpstreamPath = isSiteDataPath
          ? await getSiteDataResolver()
          : null;
        const upstreamPath = isSiteDataPath
          ? resolveSiteDataUpstreamPath(requestUrl.pathname)
          : requestUrl.pathname;
        if (!upstreamPath) {
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "Not found" }));
          return;
        }

        const siteProxySecret = (process.env.STATIC_EXPORT_SITE_API_SHARED_SECRET ?? "").trim();
        const proxyHeaders = buildForwardedRequestHeaders(
          req,
          isSiteDataPath && siteProxySecret
            ? { "X-Pharos-Site-Proxy-Secret": siteProxySecret }
            : {},
        );
        const requestBody = await readRequestBody(req, method);
        const upstream = await proxyApiRequest(
          `${(isSiteDataPath ? siteApiBaseUrl : apiBaseUrl)}${upstreamPath}${requestUrl.search}`,
          method,
          proxyHeaders,
          requestBody,
        );
        const body = method === "HEAD" ? null : Buffer.from(await upstream.arrayBuffer());
        const headers = {};

        for (const [key, value] of upstream.headers) {
          if (EXCLUDED_PROXY_RESPONSE_HEADERS.has(key.toLowerCase())) continue;
          headers[key] = value;
        }

        if (body) {
          headers["Content-Length"] = String(body.byteLength);
        }

        res.writeHead(upstream.status, headers);
        if (body) {
          res.end(body);
        } else {
          res.end();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown proxy failure";
        res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`Proxy request failed: ${message}`);
      }
      return;
    }

    if (!canServeStaticMethod) {
      res.writeHead(405, { Allow: "GET, HEAD" });
      res.end();
      return;
    }

    try {
      const staticFile = await readStaticExportFile(normalizedRoot, requestUrl.pathname);
      await sendStaticExportFile(req, res, method, staticFile, requestUrl.pathname);
      return;
    } catch (error) {
      if (isPathEscapeError(error)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Forbidden");
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
  });

  return {
    host,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve(server);
        });
      });
    },
    port,
    rootDir: normalizedRoot,
    siteApiBaseUrl,
    server,
  };
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  const app = createStaticExportServer();
  await app.listen();
  console.log(
    `[serve-static-export] Serving ${app.rootDir} on http://${app.host}:${app.port} with /api proxy ${getProxyBaseUrl()} and /_site-data proxy ${getSiteProxyBaseUrl()}`,
  );
}

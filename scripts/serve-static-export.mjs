#!/usr/bin/env node

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import origins from "../shared/lib/runtime-origins.json" with { type: "json" };

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
};

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

function buildContentType(filePath) {
  return CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream";
}

function getProxyBaseUrl() {
  const configured = (process.env.STATIC_EXPORT_API_BASE ?? "").trim();
  return configured || origins.apiOrigin;
}

async function proxyApiRequest(targetUrl, method) {
  return fetch(targetUrl, {
    method,
    headers: {
      Accept: "application/json",
      "User-Agent": "pharos-static-export-smoke/1.0",
    },
  });
}

export function createStaticExportServer({
  apiBaseUrl = getProxyBaseUrl(),
  host = process.env.STATIC_EXPORT_HOST ?? "127.0.0.1",
  port = Number.parseInt(process.env.STATIC_EXPORT_PORT ?? "4173", 10),
  rootDir = path.resolve(process.cwd(), process.env.STATIC_EXPORT_ROOT ?? "out"),
} = {}) {
  const normalizedRoot = path.resolve(rootDir);
  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", `http://${host}:${port}`);
    const method = req.method ?? "GET";

    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      res.end();
      return;
    }

    if (requestUrl.pathname.startsWith("/api/")) {
      try {
        const upstream = await proxyApiRequest(`${apiBaseUrl}${requestUrl.pathname}${requestUrl.search}`, method);
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

    let filePath;
    try {
      filePath = resolveStaticFilePath(normalizedRoot, requestUrl.pathname);
    } catch {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    try {
      const file = await readFile(filePath);
      res.writeHead(200, {
        "Content-Length": String(file.byteLength),
        "Content-Type": buildContentType(filePath),
      });
      if (method === "HEAD") {
        res.end();
      } else {
        res.end(file);
      }
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
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
    server,
  };
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  const app = createStaticExportServer();
  await app.listen();
  console.log(
    `[serve-static-export] Serving ${app.rootDir} on http://${app.host}:${app.port} with /api proxy ${getProxyBaseUrl()}`,
  );
}

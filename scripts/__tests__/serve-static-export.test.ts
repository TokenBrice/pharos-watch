import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createStaticExportServer, resolveMissingYieldWorkbenchLocation } from "../maintenance/serve-static-export.mjs";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
    ),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function makeRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pharos-static-export-"));
  roots.push(root);
  return root;
}

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server did not bind to a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

function directive(csp: string, name: string): string {
  return (
    csp
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name} `)) ?? ""
  );
}

describe("serve-static-export", () => {
  it("mirrors the Pages fallback for intentionally omitted yield workbenches", async () => {
    expect(
      resolveMissingYieldWorkbenchLocation(
        new URL("https://pharos.watch/stablecoin/usdc-circle/yield/?days=90"),
        new Set(["usdc-circle"]),
      ),
    ).toBe("/yield/?days=90&compare=usdc-circle&from=detail-fallback");
    expect(
      resolveMissingYieldWorkbenchLocation(
        new URL("https://pharos.watch/stablecoin/not-tracked/yield/"),
        new Set(["usdc-circle"]),
      ),
    ).toBeNull();

    const app = createStaticExportServer({
      port: 0,
      rootDir: await makeRoot(),
    });
    const baseUrl = await listen(app.server);
    const response = await fetch(`${baseUrl}/stablecoin/usdc-circle/yield/?days=90`, {
      redirect: "manual",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/yield/?days=90&compare=usdc-circle&from=detail-fallback");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("serves exact /api and /api/ from the static API access page", async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, "api"), { recursive: true });
    await writeFile(path.join(root, "api", "index.html"), "<h1>API access</h1>");

    const app = createStaticExportServer({
      apiBaseUrl: "http://127.0.0.1:1",
      port: 0,
      rootDir: root,
    });
    const baseUrl = await listen(app.server);

    const exactResponse = await fetch(`${baseUrl}/api`);
    const slashResponse = await fetch(`${baseUrl}/api/`);

    expect(exactResponse.status).toBe(200);
    expect(await exactResponse.text()).toBe("<h1>API access</h1>");
    expect(slashResponse.status).toBe(200);
    expect(await slashResponse.text()).toBe("<h1>API access</h1>");
  });

  it("serves static /api route assets before falling through to the API proxy", async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, "api"), { recursive: true });
    await writeFile(path.join(root, "api", "__next.api.txt"), "static api route asset");

    const app = createStaticExportServer({
      apiBaseUrl: "http://127.0.0.1:1",
      port: 0,
      rootDir: root,
    });
    const baseUrl = await listen(app.server);

    const response = await fetch(`${baseUrl}/api/__next.api.txt?_rsc=test`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("static api route asset");
  });

  it("compresses static text assets when the browser accepts Brotli", async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, "app.css"), ".a{color:red;}\n".repeat(200));

    const app = createStaticExportServer({
      apiBaseUrl: "http://127.0.0.1:1",
      port: 0,
      rootDir: root,
    });
    const baseUrl = await listen(app.server);

    const response = await fetch(`${baseUrl}/app.css`, {
      method: "HEAD",
      headers: { "Accept-Encoding": "br, gzip" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Encoding")).toBe("br");
    expect(response.headers.get("Vary")).toBe("Accept-Encoding");
  });

  it("serves Mini App HTML with Telegram-specific CSP", async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, "pharoswatchbot", "app"), { recursive: true });
    await writeFile(path.join(root, "pharoswatchbot", "app", "index.html"), "<html><script>1</script></html>");

    const app = createStaticExportServer({
      apiBaseUrl: "http://127.0.0.1:1",
      port: 0,
      rootDir: root,
    });
    const baseUrl = await listen(app.server);

    const response = await fetch(`${baseUrl}/pharoswatchbot/app/`);
    const csp = response.headers.get("Content-Security-Policy") ?? "";

    expect(response.status).toBe(200);
    expect(csp).toContain("https://telegram.org");
    expect(csp).toContain("frame-ancestors https://telegram.org https://*.telegram.org");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(await response.text()).toMatch(/<script nonce="[^"]+">1<\/script>/);
  });

  it("allows analytics image beacons in local static-export CSP", async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, "index.html"), "<html><script>1</script></html>");

    const app = createStaticExportServer({
      apiBaseUrl: "http://127.0.0.1:1",
      port: 0,
      rootDir: root,
    });
    const baseUrl = await listen(app.server);

    const response = await fetch(`${baseUrl}/`);
    const csp = response.headers.get("Content-Security-Policy") ?? "";
    const imgSrc = directive(csp, "img-src");

    expect(response.status).toBe(200);
    expect(imgSrc).toContain("https://www.googletagmanager.com");
    expect(imgSrc).toContain("https://*.googletagmanager.com");
  });

  it("continues proxying nested /api paths when no static export file exists", async () => {
    const upstream = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ url: req.url }));
    });
    const upstreamBaseUrl = await listen(upstream);

    const app = createStaticExportServer({
      apiBaseUrl: upstreamBaseUrl,
      port: 0,
      rootDir: await makeRoot(),
    });
    const baseUrl = await listen(app.server);

    const response = await fetch(`${baseUrl}/api/peg-summary?range=7d`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ url: "/api/peg-summary?range=7d" });
  });

  it("proxies nested admin API paths during local static-export smoke runs", async () => {
    const upstream = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          url: req.url,
          adminHeader: req.headers["x-pharos-admin"] ?? null,
        }),
      );
    });
    const upstreamBaseUrl = await listen(upstream);

    const app = createStaticExportServer({
      apiBaseUrl: upstreamBaseUrl,
      port: 0,
      rootDir: await makeRoot(),
    });
    const baseUrl = await listen(app.server);

    const response = await fetch(`${baseUrl}/api/api-key-requests-admin?limit=1`, {
      headers: { "X-Pharos-Admin": "1" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: "/api/api-key-requests-admin?limit=1",
      adminHeader: "1",
    });
  });

  it("proxies allowlisted /_site-data paths to their API upstream paths", async () => {
    const upstream = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          url: req.url,
          siteSecret: req.headers["x-pharos-site-proxy-secret"] ?? null,
        }),
      );
    });
    const upstreamBaseUrl = await listen(upstream);

    const app = createStaticExportServer({
      apiBaseUrl: "http://127.0.0.1:1",
      siteApiBaseUrl: upstreamBaseUrl,
      port: 0,
      rootDir: await makeRoot(),
    });
    const baseUrl = await listen(app.server);
    const previousSecret = process.env.STATIC_EXPORT_SITE_API_SHARED_SECRET;
    process.env.STATIC_EXPORT_SITE_API_SHARED_SECRET = "site-secret";

    try {
      const response = await fetch(`${baseUrl}/_site-data/stablecoins?limit=1`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        url: "/api/stablecoins?limit=1",
        siteSecret: "site-secret",
      });
    } finally {
      if (previousSecret == null) {
        delete process.env.STATIC_EXPORT_SITE_API_SHARED_SECRET;
      } else {
        process.env.STATIC_EXPORT_SITE_API_SHARED_SECRET = previousSecret;
      }
    }
  });

  it("proxies POST bodies and headers for self-serve API endpoints", async () => {
    const upstream = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        res.writeHead(400, {
          "Content-Type": "application/json; charset=utf-8",
          "X-Upstream-Method": req.method ?? "",
        });
        res.end(
          JSON.stringify({
            method: req.method,
            url: req.url,
            contentType: req.headers["content-type"],
            body,
          }),
        );
      });
    });
    const upstreamBaseUrl = await listen(upstream);

    const app = createStaticExportServer({
      apiBaseUrl: upstreamBaseUrl,
      port: 0,
      rootDir: await makeRoot(),
    });
    const baseUrl = await listen(app.server);

    const requestResponse = await fetch(`${baseUrl}/api/api-key-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    const verifyResponse = await fetch(`${baseUrl}/api/api-key-requests/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });

    expect(requestResponse.status).toBe(400);
    await expect(requestResponse.json()).resolves.toEqual({
      method: "POST",
      url: "/api/api-key-requests",
      contentType: "application/json",
      body: "{not-json",
    });
    expect(verifyResponse.status).toBe(400);
    await expect(verifyResponse.json()).resolves.toEqual({
      method: "POST",
      url: "/api/api-key-requests/verify",
      contentType: "application/json",
      body: "{not-json",
    });
  });
});

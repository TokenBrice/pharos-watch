import { createServer, get, type Server } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { createStaticExportServer, resolveMissingYieldWorkbenchLocation } from "../maintenance/serve-static-export";

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

async function startExport(rootDir: string, overrides: Parameters<typeof createStaticExportServer>[0] = {}) {
  return listen(createStaticExportServer({ port: 0, rootDir, apiBaseUrl: "http://127.0.0.1:1", ...overrides }).server);
}

function rawGet(baseUrl: string, requestPath: string, encoding = "identity") {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    get(`${baseUrl}${requestPath}`, { headers: { "Accept-Encoding": encoding } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
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
    ).toBe("/yield/?days=90&compare=usdc-circle&from=detail-fallback&workbenchFallback=usdc-circle");
    expect(
      resolveMissingYieldWorkbenchLocation(
        new URL("https://pharos.watch/stablecoin/not-tracked/yield/"),
        new Set(["usdc-circle"]),
      ),
    ).toBeNull();

    const baseUrl = await startExport(await makeRoot());
    const response = await fetch(`${baseUrl}/stablecoin/usdc-circle/yield/?days=90`, {
      redirect: "manual",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/yield/?days=90&compare=usdc-circle&from=detail-fallback&workbenchFallback=usdc-circle",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps local fallback state while overriding the dedicated notice id", () => {
    const location = resolveMissingYieldWorkbenchLocation(
      new URL(
        "https://pharos.watch/stablecoin/usdc-circle/yield/?compare=usdt-tether&from=watchlist&workbenchFallback=spoofed&days=30",
      ),
      new Set(["usdc-circle"]),
    );

    expect(location).not.toBeNull();
    const redirected = new URL(location!, "https://pharos.watch");
    expect(redirected.searchParams.get("compare")).toBe("usdt-tether");
    expect(redirected.searchParams.get("from")).toBe("watchlist");
    expect(redirected.searchParams.get("days")).toBe("30");
    expect(redirected.searchParams.getAll("workbenchFallback")).toEqual(["usdc-circle"]);
  });

  it("serves exact /api and /api/ from the static API access page", async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, "api"), { recursive: true });
    await writeFile(path.join(root, "api", "index.html"), "<h1>API access</h1>");

    const baseUrl = await startExport(root);

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

    const baseUrl = await startExport(root);

    const response = await fetch(`${baseUrl}/api/__next.api.txt?_rsc=test`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("static api route asset");
  });

  it.each(["br", "gzip", "br;q=0, gzip"] as const)("serves valid compressed bytes for %s", async (accepted) => {
    const root = await makeRoot();
    const body = Buffer.from(".a{color:red;}\n".repeat(200));
    await writeFile(path.join(root, "app.css"), body);
    const response = await rawGet(await startExport(root), "/app.css", accepted);
    const encoding = accepted === "br" ? "br" : "gzip";
    expect(response.status).toBe(200);
    expect(response.headers["content-encoding"]).toBe(encoding);
    expect(response.headers.vary).toBe("Accept-Encoding");
    expect(Number(response.headers["content-length"])).toBe(response.body.length);
    expect((encoding === "br" ? brotliDecompressSync : gunzipSync)(response.body)).toEqual(body);
  });

  it("compresses at 1024 bytes but not below the threshold or for binary content", async () => {
    const root = await makeRoot();
    const baseUrl = await startExport(root);
    for (const [file, size, compressed] of [["small.css", 1023, false], ["large.css", 1024, true], ["image.png", 2048, false]] as const) {
      const body = Buffer.alloc(size, 65);
      await writeFile(path.join(root, file), body);
      const response = await rawGet(baseUrl, `/${file}`, "br");
      expect(response.headers["content-encoding"]).toBe(compressed ? "br" : undefined);
      expect(compressed ? brotliDecompressSync(response.body) : response.body).toEqual(body);
    }
  });

  it("serves Mini App HTML with Telegram-specific CSP", async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, "pharoswatchbot", "app"), { recursive: true });
    await writeFile(path.join(root, "pharoswatchbot", "app", "index.html"), "<html><script>1</script></html>");

    const baseUrl = await startExport(root);

    const response = await fetch(`${baseUrl}/pharoswatchbot/app/`);
    const csp = response.headers.get("Content-Security-Policy") ?? "";

    expect(response.status).toBe(200);
    expect(csp).toContain("https://telegram.org");
    expect(csp).toContain("frame-ancestors https://telegram.org https://*.telegram.org");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    const nonce = (await response.text()).match(/<script nonce="([^"]+)">1<\/script>/)?.[1];
    expect(nonce).toBeTruthy();
    expect(directive(csp, "script-src").split(/\s+/)).toContain(`'nonce-${nonce}'`);
    const second = await fetch(`${baseUrl}/pharoswatchbot/app/`);
    const secondNonce = (await second.text()).match(/<script nonce="([^"]+)">1<\/script>/)?.[1];
    expect(secondNonce).toBeTruthy();
    expect(secondNonce).not.toBe(nonce);
    expect(directive(second.headers.get("Content-Security-Policy") ?? "", "script-src").split(/\s+/))
      .toContain(`'nonce-${secondNonce}'`);
  });

  it("allows analytics image beacons in local static-export CSP", async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, "index.html"), "<html><script>1</script></html>");

    const baseUrl = await startExport(root);

    const response = await fetch(`${baseUrl}/`);
    const csp = response.headers.get("Content-Security-Policy") ?? "";
    const imgSrc = directive(csp, "img-src");

    expect(response.status).toBe(200);
    expect(imgSrc).toContain("https://www.googletagmanager.com");
    expect(imgSrc).toContain("https://*.googletagmanager.com");
  });

  it.each([
    { requestPath: "/api/peg-summary?range=7d", adminHeader: null },
    { requestPath: "/api/api-key-requests-admin?limit=1", adminHeader: "1" },
  ])("proxies nested $requestPath with its admin header", async ({ requestPath, adminHeader }) => {
    const upstreamBaseUrl = await listen(createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ url: req.url, adminHeader: req.headers["x-pharos-admin"] ?? null }));
    }));
    const baseUrl = await startExport(await makeRoot(), { apiBaseUrl: upstreamBaseUrl });
    const response = await fetch(`${baseUrl}${requestPath}`, {
      headers: adminHeader ? { "X-Pharos-Admin": adminHeader } : {},
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ url: requestPath, adminHeader });
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

    const baseUrl = await startExport(await makeRoot(), { siteApiBaseUrl: upstreamBaseUrl });
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

    const baseUrl = await startExport(await makeRoot(), { apiBaseUrl: upstreamBaseUrl });

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

  it("refuses encoded traversal and unallowlisted site data without contacting upstream", async () => {
    let requests = 0;
    const upstream = await listen(createServer((_req, res) => { requests++; res.end("unexpected"); }));
    const baseUrl = await startExport(await makeRoot(), { apiBaseUrl: upstream, siteApiBaseUrl: upstream });
    for (const requestPath of ["/..%2fsecret.txt", "/api/..%2f..%2fsecret.txt"]) {
      expect((await rawGet(baseUrl, requestPath)).status).toBe(403);
    }
    expect((await rawGet(baseUrl, "/_site-data/not-allowlisted")).status).toBe(404);
    expect(requests).toBe(0);
  });

  it("refuses POST to static and site-data routes", async () => {
    const baseUrl = await startExport(await makeRoot());
    for (const requestPath of ["/", "/_site-data/stablecoins"]) {
      const response = await fetch(`${baseUrl}${requestPath}`, { method: "POST" });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
    }
  });

  it("returns 502 when the upstream terminates the connection", async () => {
    const upstream = await listen(createServer((req) => req.socket.destroy()));
    const baseUrl = await startExport(await makeRoot(), { apiBaseUrl: upstream });
    expect((await fetch(`${baseUrl}/api/peg-summary`)).status).toBe(502);
  });

  it("prefers an existing workbench and leaves unknown missing workbenches at 404", async () => {
    const root = await makeRoot();
    const directory = path.join(root, "stablecoin/usdc-circle/yield");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "index.html"), "existing workbench");
    const baseUrl = await startExport(root);
    const existing = await fetch(`${baseUrl}/stablecoin/usdc-circle/yield/`, { redirect: "manual" });
    expect(existing.status).toBe(200);
    expect(await existing.text()).toBe("existing workbench");
    expect((await fetch(`${baseUrl}/stablecoin/not-tracked/yield/`, { redirect: "manual" })).status).toBe(404);
  });
});

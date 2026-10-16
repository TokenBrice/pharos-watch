import { createServer, get, type Server } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createStaticExportServer } from "../maintenance/serve-static-export";

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
    { requestPath: "/api/api-keys/audit-log?limit=1", adminHeader: "1" },
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

  it("proxies POST bodies and headers for public write endpoints", async () => {
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

    const claimResponse = await fetch(`${baseUrl}/api/donor-key-claims`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    const feedbackResponse = await fetch(`${baseUrl}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });

    expect(claimResponse.status).toBe(400);
    await expect(claimResponse.json()).resolves.toEqual({
      method: "POST",
      url: "/api/donor-key-claims",
      contentType: "application/json",
      body: "{not-json",
    });
    expect(feedbackResponse.status).toBe(400);
    await expect(feedbackResponse.json()).resolves.toEqual({
      method: "POST",
      url: "/api/feedback",
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

});

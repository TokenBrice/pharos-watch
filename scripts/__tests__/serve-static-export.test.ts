/* eslint-disable security/detect-non-literal-fs-filename */
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createStaticExportServer } from "../serve-static-export.mjs";

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

describe("serve-static-export", () => {
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
});

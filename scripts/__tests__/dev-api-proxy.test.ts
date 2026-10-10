import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { allocatePort } from "../lib/smoke-runtime.mjs";

const nonLoopbackAddress = Object.values(networkInterfaces()).flat()
  .find((address) => address?.family === "IPv4" && !address.internal)?.address;

async function startProxy(port: number, upstream: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/maintenance/dev-api-proxy.ts"], {
    cwd: resolve(import.meta.dirname, "../.."),
    env: { ...process.env, SITE_API_SHARED_SECRET: "local-fixture-only", DEV_PROXY_PORT: String(port), DEV_PROXY_UPSTREAM: upstream },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Proxy exited during startup: ${code}`)));
      let output = "";
      child.stdout!.on("data", (chunk) => {
        output += chunk.toString();
        if (output.includes(" → ")) resolve();
      });
    });
    return child;
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
}

async function stopProxy(child: ChildProcess): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return;
  const stopped = once(child, "exit");
  child.kill("SIGTERM");
  await stopped;
}

describe("dev-api-proxy", () => {
  it("forwards allowlisted GETs but denies internal build inputs and non-admitted methods before adding credentials", async () => {
    const requests: Array<{ url: string | undefined; secret: string | string[] | undefined }> = [];
    const upstream = createServer((req, res) => {
      requests.push({ url: req.url, secret: req.headers["x-pharos-site-proxy-secret"] });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Missing upstream address");
    let child: ChildProcess | undefined;
    try {
      const port = await allocatePort("127.0.0.1");
      child = await startProxy(port, `http://127.0.0.1:${address.port}`);
      const base = `http://127.0.0.1:${port}`;
      const admitted = await fetch(`${base}/api/stablecoins?fixture=yes`);
      expect(admitted.status).toBe(200);
      expect(await admitted.json()).toEqual({ ok: true });
      expect((await fetch(`${base}/api/stablecoin-detail-snapshot-inputs?ids=usdc-circle`)).status).toBe(404);
      for (const method of ["POST", "HEAD", "DELETE"]) {
        expect((await fetch(`${base}/api/stablecoins`, { method })).status).toBe(405);
      }
      expect(requests).toEqual([{ url: "/api/stablecoins?fixture=yes", secret: "local-fixture-only" }]);
    } finally {
      if (child) await stopProxy(child);
      await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  }, 15_000);

  it.skipIf(!nonLoopbackAddress)("binds only IPv4 loopback rather than the developer network interface", async () => {
    const port = await allocatePort("127.0.0.1");
    const child = await startProxy(port, "http://127.0.0.1:1");
    try {
      await expect(fetch(`http://${nonLoopbackAddress}:${port}/api/stablecoins`, {
        signal: AbortSignal.timeout(1000),
      })).rejects.toThrow();
    } finally {
      await stopProxy(child);
    }
  }, 15_000);
});

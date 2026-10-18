import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  assertQualificationHeavyEntry, assertQualificationHeavyGraph,
  qualificationProbeSource, qualifyWorkerMemory,
} from "../qualify-worker-memory.mjs";
import { offlineTransferMaterialityDependencies } from "../../../shared/test-utils/v9-resource-offline";

describe("Worker memory qualification harness", () => {
  it("accepts the private placed executor's unauthenticated refusal, not public HTTP", async () => {
    const fetch = vi.fn(async () => Response.json({ error: "placed-executor-unauthorized" }, { status: 401 }));
    await expect(assertQualificationHeavyEntry({ scheduled() {}, fetch })).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(expect.any(Request), {});
    await expect(assertQualificationHeavyEntry({ scheduled() {}, fetch: async () => Response.json({ ok: true }) }))
      .rejects.toThrow("invalid-heavy-fetch");
    await expect(assertQualificationHeavyEntry({ scheduled() {}, fetch: async () => Response.json({ error: "unauthorized" }, { status: 401 }) }))
      .rejects.toThrow("invalid-heavy-fetch");
    expect(() => assertQualificationHeavyGraph([
      "worker/src/index.heavy.ts", "worker/src/handlers/scheduled/placed-executor.ts",
    ])).not.toThrow();
  });

  it.each([
    "worker/src/api/og.tsx", "worker/src/telegram/webhook/telegram-webhook.ts",
    "worker/src/telegram/commands/start.ts", "worker/src/telegram/callbacks/confirm.ts",
    "worker/src/telegram/mini-app/telegram-mini-app.ts", "worker/src/telegram/adoption/telegram-adoption.ts",
    "worker/src/telegram/admin/admin-telegram-broadcast.ts", "worker/src/telegram/webhook/telegram-ingress-abuse.ts",
    "worker/src/handlers/http/request-dispatch.ts", "worker/src/routes/public-routes.ts",
    "node_modules/satori/dist/index.js", "node_modules/@resvg/resvg-wasm/index.js",
    "node_modules/yoga-wasm-web/yoga.wasm", "worker/assets/fonts/Inter.ttf",
  ])("still rejects HTTP/rendering graph input %s", (path) => {
    expect(() => assertQualificationHeavyGraph([path])).toThrow("invalid-heavy-http-graph");
  });

  it("returns deterministic unavailable observer fixtures without calling fetch", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
    try {
      expect(Object.keys(offlineTransferMaterialityDependencies).sort()).toEqual([
        "fetchEvmBlockHeader", "fetchEvmBlockNumber", "fetchEvmMulticall3Aggregate3AtBlock",
        "fetchMoveFungibleAssetSupply", "fetchSafetyScoreV9SolanaRpc",
        "observeEconomicSolanaMint", "resolveClosestBlockAtOrBeforeTimestamp",
      ]);
      for (const dependency of Object.values(offlineTransferMaterialityDependencies)) {
        expect(await dependency()).toBeNull();
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });

  it.each([
    ["fetch", "await fetch('https://example.invalid')"],
    ["TCP", "(await import('node:net')).connect(443, 'example.invalid')"],
    ["HTTP", "(await import('node:http')).request('http://example.invalid')"],
    ["HTTPS", "(await import('node:https')).get('https://example.invalid')"],
    ["TLS", "(await import('node:tls')).connect(443, 'example.invalid')"],
    ["UDP", "(await import('node:dgram')).createSocket('udp4')"],
    ["DNS", "await (await import('node:dns/promises')).resolve4('example.invalid')"],
    ["WebSocket", "new WebSocket('wss://example.invalid')"],
  ])("terminates unexpected %s before retries or sockets can run", (_transport, code) => {
    const preload = fileURLToPath(new URL("../../../worker/scripts/lib/v9-resource-offline.mjs", import.meta.url));
    const result = spawnSync(process.execPath, ["--import", preload, "--input-type=module", "-e",
      `${code}; console.log('unexpected-network-success');`], { encoding: "utf8", timeout: 2_000 });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("worker-memory-network-denied");
    expect(result.stdout).not.toContain("unexpected-network-success");
  });

  it("permits the local Unix-domain IPC required by the tsx loader", () => {
    const preload = fileURLToPath(new URL("../../../worker/scripts/lib/v9-resource-offline.mjs", import.meta.url));
    const code = `
      import net from 'node:net';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      const path = join(tmpdir(), 'pharos-memory-ipc-' + process.pid);
      const server = net.createServer(socket => socket.end());
      server.listen(path, () => {
        const client = net.connect({ path });
        client.on('end', () => server.close(() => console.log('local-ipc-complete')));
        client.resume();
      });
    `;
    const result = spawnSync(process.execPath, ["--import", preload, "--import", "tsx", "--input-type=module", "-e", code],
      { encoding: "utf8", timeout: 2_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("local-ipc-complete");
    expect(result.stderr).not.toContain("worker-memory-network-denied");
  });

  it("rejects unknown flags, duplicate options and missing output before filesystem effects", async () => {
    await expect(qualifyWorkerMemory(["--unknown"])).rejects.toThrow();
    await expect(qualifyWorkerMemory(["--runs", "2", "--runs", "3"])).rejects.toThrow();
    await expect(qualifyWorkerMemory([])).rejects.toThrow("--out-dir is required");
  });

  it("rejects invalid repeat counts before creating an output directory", async () => {
    await expect(qualifyWorkerMemory(["--out-dir", "unused", "--runs", "0"])).rejects.toThrow();
    await expect(qualifyWorkerMemory(["--out-dir", "unused", "--runs", "1.5"])).rejects.toThrow();
  });

  it("measures the cold entry before the charts loader and accepted readers", () => {
    const source = qualificationProbeSource();
    expect(source.indexOf("phase('cold-heavy-entry')")).toBeLessThan(source.indexOf("halfHourlyChartsOffset()"));
    expect(source.indexOf("phase('cold-charts-loader')")).toBeLessThan(source.indexOf("loadSafetyScoreV9AcceptedBaselineState(db)"));
    expect(source).toContain("getHeapSpaceStatistics()");
    expect(source).toContain("getHeapCodeStatistics()");
    expect(source).toContain("process.memoryUsage()");
    expect(source).toContain("readOnly: true");
    expect(source).toContain("baseline.kind !== 'accepted'");
    expect(source).toContain("lender.kind !== 'accepted'");
    expect(source).toContain("accepted-readers-co-resident");
    expect(source).not.toContain("public-runners");
  });
});

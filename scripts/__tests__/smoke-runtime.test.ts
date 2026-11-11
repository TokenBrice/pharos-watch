import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  isDirectRun,
  resolveStaticExportPort,
  retrySmokeOperation,
  waitForStaticExportServer,
} from "../lib/smoke-runtime.mjs";
import { withTempRepo } from "./helpers/test-state";

describe("smoke-runtime CLI helpers", () => {
  it("rejects imports and missing argv paths", () => {
    const argvPath = "/tmp/pharos-watch/scripts/maintenance/build-annotation-candidates.ts";

    expect(isDirectRun("file:///tmp/pharos-watch/other.ts", argvPath)).toBe(false);
    expect(isDirectRun(pathToFileURL(argvPath).href, undefined)).toBe(false);
  });

  it("recognizes a CLI invoked through a symlink on either side", () => {
    const runtimeUrl = pathToFileURL(resolve("scripts/lib/smoke-runtime.mjs")).href;
    withTempRepo("pharos-smoke-runtime", {
      "entry.mjs": `import { isDirectRun } from ${JSON.stringify(runtimeUrl)};\nconsole.log(isDirectRun(import.meta.url, process.argv[1]));\n`,
    }, (cwd) => {
      const entry = join(cwd, "entry.mjs");
      const alias = join(cwd, "alias.mjs");
      symlinkSync(entry, alias);
      expect(execFileSync(process.execPath, [alias], { encoding: "utf8" })).toBe("true\n");
      expect(isDirectRun(pathToFileURL(alias).href, entry)).toBe(true);
      expect(isDirectRun(pathToFileURL(entry).href, alias)).toBe(true);
    });
  });

  it("rejects an explicitly occupied port even when its unrelated listener serves successful HTTP", async () => {
    const listener = createServer((_req, res) => { res.end("unrelated artifact"); });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Missing listener address");
    try {
      expect((await fetch(`http://127.0.0.1:${address.port}/`)).status).toBe(200);
      await expect(resolveStaticExportPort("127.0.0.1", {
        env: { STATIC_EXPORT_PORT: String(address.port) },
      })).rejects.toThrow("already in use");
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each(["error", "exit"])("fails owned-server readiness on early child %s without probing another listener", async (event) => {
    const server = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null,
    });
    const fetchImpl = vi.fn(async () => new Response("unrelated", { status: 200 }));
    const waiting = waitForStaticExportServer(server, "http://127.0.0.1:4173", {
      fetchImpl, sleepImpl: async () => {
        if (event === "error") server.emit("error", new Error("bind failed"));
        else server.emit("exit", 1, null);
      },
    });
    await expect(waiting).rejects.toThrow(event === "error" ? "bind failed" : "exited before readiness");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires the owned server startup marker before HTTP readiness", async () => {
    const server = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null,
    });
    const fetchImpl = vi.fn(async () => new Response("current artifact", { status: 200 }));
    const baseUrl = "http://127.0.0.1:4173";
    const sleepImpl = vi.fn(async () => {
      expect(fetchImpl).not.toHaveBeenCalled();
      server.stdout.write(`[serve-static-export] Serving /current/out on ${baseUrl} with /api proxy local\n`);
    });
    await expect(waitForStaticExportServer(server, baseUrl, { fetchImpl, sleepImpl })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(sleepImpl).toHaveBeenCalledOnce();
  });

  it.each([
    { retryable: true, attempts: 3, sleeps: 2 },
    { retryable: false, attempts: 1, sleeps: 0 },
  ])("bounds failed retries when retryable=$retryable", async ({ retryable, attempts, sleeps }) => {
    const failure = new Error("original failure");
    const operation = vi.fn().mockRejectedValue(failure);
    const sleepImpl = vi.fn().mockResolvedValue(undefined);
    await expect(retrySmokeOperation(operation, {
      retries: 2, shouldRetry: (() => retryable) as () => true, sleepImpl,
    })).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(attempts);
    expect(sleepImpl).toHaveBeenCalledTimes(sleeps);
  });
});

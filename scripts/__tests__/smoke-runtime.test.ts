import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  allocatePort,
  aggregateRouteResults,
  canListen,
  isDirectRun,
  launchChromiumBrowser,
  parseBoolean,
  parseCliOptions,
  readCliValue,
  resolveStaticExportPort,
  retrySmokeOperation,
  runBoundedWorkerPool,
  withBrowserContext,
} from "../lib/smoke-runtime.mjs";

describe("smoke-runtime CLI helpers", () => {
  it("parses boolean-ish env values with a fallback", () => {
    expect(parseBoolean("true", false)).toBe(true);
    expect(parseBoolean("0", true)).toBe(false);
    expect(parseBoolean("", true)).toBe(true);
  });

  it("dispatches value and flag options without hand-written loops", () => {
    const args = { timeoutMs: 100, verbose: false };

    parseCliOptions(["--timeout-ms", "250", "--verbose"], {
      "--timeout-ms": ({ readValue }) => {
        args.timeoutMs = Number(readValue());
        return "value";
      },
      "--verbose": () => {
        args.verbose = true;
      },
    });

    expect(args).toEqual({ timeoutMs: 250, verbose: true });
  });

  it("reports missing option values with the option name", () => {
    expect(() => readCliValue(["--url"], 0, "--url")).toThrow("--url requires a value");
  });

  it("matches direct execution from URL-escaped checkout paths", () => {
    const argvPath = "/tmp/pharos watch checkout/scripts/maintenance/build-annotation-candidates.ts";

    expect(isDirectRun(pathToFileURL(argvPath).href, argvPath)).toBe(true);
  });

  it("matches direct execution from relative argv paths", () => {
    const argvPath = "scripts/maintenance/build-annotation-candidates.ts";

    expect(isDirectRun(pathToFileURL(resolve(argvPath)).href, argvPath)).toBe(true);
  });

  it("rejects imports and missing argv paths", () => {
    const argvPath = "/tmp/pharos-watch/scripts/maintenance/build-annotation-candidates.ts";

    expect(isDirectRun("file:///tmp/pharos-watch/other.ts", argvPath)).toBe(false);
    expect(isDirectRun(pathToFileURL(argvPath).href, undefined)).toBe(false);
  });

  it("allocates numeric local ports for smoke servers", async () => {
    const listeners = new Map<string, (...args: never[]) => void>();
    const server = {
      once: (event: string, callback: (...args: never[]) => void) => { listeners.set(event, callback); },
      listen: () => { listeners.get("listening")?.(); },
      close: (callback: () => void) => callback(),
      address: () => ({ port: 49232 }),
    };
    const createFakeServer = (() => server) as unknown as typeof import("node:net").createServer;
    const port = await allocatePort("127.0.0.1", { createServerImpl: createFakeServer });

    expect(port).toBe(49232);
    expect(await canListen("127.0.0.1", port, { createServerImpl: createFakeServer })).toBe(true);
  });

  it("resolves explicit and fallback static-export ports as numbers", async () => {
    expect(
      await resolveStaticExportPort("127.0.0.1", {
        env: { STATIC_EXPORT_PORT: "49231" },
      }),
    ).toBe(49231);

    const preferredPort = 49231;

    const fallbackCalls: Array<{ host: string; preferredPort: number; fallbackPort: number }> = [];
    const fallbackPort = await resolveStaticExportPort("127.0.0.1", {
      env: {},
      preferredPort,
      canListenImpl: async () => false,
      allocatePortImpl: async () => 49232,
      onFallback: (event) => fallbackCalls.push(event),
    });

    expect(fallbackPort).toBe(49232);
    expect(fallbackCalls).toEqual([{ host: "127.0.0.1", preferredPort, fallbackPort }]);
  });

  it("owns Chromium fallback and browser/context lifecycle through adapters", async () => {
    const closeContext = vi.fn();
    const closeBrowser = vi.fn();
    const context = { close: closeContext };
    const browser = { close: closeBrowser, newContext: vi.fn(async () => context) };
    const launch = vi.fn()
      .mockRejectedValueOnce(new Error("Executable doesn't exist; Please run the following command"))
      .mockResolvedValueOnce(browser);
    const chromium = { launch } as Parameters<typeof launchChromiumBrowser>[0];

    const launched = await launchChromiumBrowser(chromium, { env: {} as NodeJS.ProcessEnv, log: vi.fn() });
    expect(launched).toBe(browser);
    expect(launch).toHaveBeenLastCalledWith({ channel: "chrome", headless: true });

    const launchBrowser = (async () => browser) as NonNullable<Parameters<typeof withBrowserContext>[0]["launch"]>;
    await expect(withBrowserContext({ chromium, contextOptions: undefined, launch: launchBrowser }, async (activeContext: typeof context) => {
      expect(activeContext).toBe(context);
      return "ok";
    })).resolves.toBe("ok");
    expect(closeContext).toHaveBeenCalledOnce();
    expect(closeBrowser).toHaveBeenCalledOnce();
  });

  it.each(["callback", "newContext", "context.close"])("closes owned resources when %s fails", async (stage) => {
    const failure = new Error(stage);
    const closed: string[] = [];
    const context = {
      close: async () => {
        closed.push("context");
        if (stage === "context.close") throw failure;
      },
    };
    const browser = {
      newContext: async () => {
        if (stage === "newContext") throw failure;
        return context;
      },
      close: async () => { closed.push("browser"); },
    };
    const launch = (async () => browser) as typeof launchChromiumBrowser;
    await expect(withBrowserContext({ chromium: undefined, contextOptions: undefined, launch }, async () => {
      if (stage === "callback") throw failure;
      return "ok";
    })).rejects.toBe(failure);
    expect(closed).toEqual(stage === "newContext" ? ["browser"] : ["context", "browser"]);
  });

  it.each([
    { env: { NODE_ENV: "test" as const }, message: "browser crashed" },
    { env: { NODE_ENV: "test" as const, SMOKE_UI_BROWSER_EXECUTABLE_PATH: "/explicit/chromium" }, message: "Executable doesn't exist" },
  ])("does not hide launch failures with fallback: $message $env", async ({ env, message }) => {
    const failure = new Error(message);
    const launch = vi.fn().mockRejectedValue(failure);
    const chromium = { launch } as Parameters<typeof launchChromiumBrowser>[0];
    await expect(launchChromiumBrowser(chromium, { env, log: vi.fn() })).rejects.toBe(failure);
    expect(launch).toHaveBeenCalledOnce();
  });

  it("runs two workers concurrently and preserves input order despite reversed completion", async () => {
    const gates = Array.from({ length: 3 }, () => Promise.withResolvers<string>());
    const thirdStarted = Promise.withResolvers<void>();
    const started: number[] = [];
    const pool = runBoundedWorkerPool(["first", "second", "third"], 2, async (_item: string, index: number) => {
      started.push(index);
      if (index === 2) thirdStarted.resolve();
      return gates[index].promise;
    });
    expect(started).toEqual([0, 1]);
    gates[1].resolve("second result");
    await thirdStarted.promise;
    expect(started).toEqual([0, 1, 2]);
    gates[2].resolve("third result");
    gates[0].resolve("first result");
    await expect(pool).resolves.toEqual(["first result", "second result", "third result"]);
    expect(started).toEqual([0, 1, 2]);
  });

  it("propagates a worker rejection", async () => {
    const failure = new Error("route failed");
    await expect(runBoundedWorkerPool(["/"], 1, async () => { throw failure; })).rejects.toBe(failure);
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

  it("aggregates route failures and screenshots and recovers transient retries", async () => {
    expect(aggregateRouteResults([
      { route: "/", failures: [], screenshotPath: null },
      { route: "/flows/", failures: ["overflow"], screenshotPath: "flows.png" },
    ])).toEqual({
      failures: ["overflow"],
      results: [
        { route: "/", failures: [], screenshotPath: null },
        { route: "/flows/", failures: ["overflow"], screenshotPath: "flows.png" },
      ],
      screenshots: ["flows.png"],
    });

    let attempts = 0;
    await expect(retrySmokeOperation(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient");
      return "recovered";
    }, { retries: 1, sleepImpl: async () => {} })).resolves.toBe("recovered");
  });
});

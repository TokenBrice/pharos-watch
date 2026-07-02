import { createServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  allocatePort,
  canListen,
  isDirectRun,
  parseBoolean,
  parseCliOptions,
  readCliValue,
  resolveStaticExportPort,
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
    const port = await allocatePort("127.0.0.1");

    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    expect(await canListen("127.0.0.1", port)).toBe(true);
  });

  it("resolves explicit and fallback static-export ports as numbers", async () => {
    expect(
      await resolveStaticExportPort("127.0.0.1", {
        env: { STATIC_EXPORT_PORT: "49231" },
      }),
    ).toBe(49231);

    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0 }, resolve);
    });
    const address = server.address();
    const preferredPort = typeof address === "object" && address ? address.port : null;
    expect(preferredPort).toBeTypeOf("number");

    const fallbackCalls = [];
    try {
      const fallbackPort = await resolveStaticExportPort("127.0.0.1", {
        env: {},
        preferredPort,
        onFallback: (event) => fallbackCalls.push(event),
      });

      expect(Number.isInteger(fallbackPort)).toBe(true);
      expect(fallbackPort).not.toBe(preferredPort);
      expect(fallbackCalls).toEqual([
        {
          host: "127.0.0.1",
          preferredPort,
          fallbackPort,
        },
      ]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

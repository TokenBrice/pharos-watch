import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkHeavyReachability, checkWorkerPackage } from "../ci/check-worker-package";

describe("check-worker-package", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "worker-package-"));
    vi.spyOn(process, "cwd").mockReturnValue(root);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });
  function emit(args: string[], source = 'export const text = "\\u20ac";') {
    const directory = args.at(-1)!;
    mkdirSync(join(directory, "chunks"), { recursive: true });
    writeFileSync(join(directory, "chunks", "worker.js"), source);
    writeFileSync(join(directory, "worker.js.map"), JSON.stringify({
      version: 3, sources: ["../../src/index.heavy.ts", "../../src/handlers/scheduled.ts"], sourcesContent: ["\u20ac"],
    }));
    return { status: 0 };
  }
  it("packages both configs into distinct directories", () => {
    const run = vi.fn((_command: string, args: string[]) => emit(args));
    expect(checkWorkerPackage({ run })).toEqual({ status: 0 });
    expect(run).toHaveBeenCalledTimes(2);
    const publicArgs = run.mock.calls[0]?.[1];
    const heavyArgs = run.mock.calls[1]?.[1];
    expect(publicArgs).toEqual(expect.arrayContaining(["--config", "wrangler.toml", "--dry-run"]));
    expect(heavyArgs).toEqual(expect.arrayContaining(["--config", "wrangler.heavy.toml", "--dry-run"]));
    expect(publicArgs?.at(-1)).not.toBe(heavyArgs?.at(-1));
  });

  it.each([0, 1])("fails when bundle %s fails", (failedIndex) => {
    let invocation = 0;
    const run = vi.fn((_command: string, args: string[]) =>
      invocation++ === failedIndex ? { status: 7 } : emit(args));
    expect(checkWorkerPackage({ run })).toEqual({ status: 7 });
    expect(run).toHaveBeenCalledTimes(failedIndex + 1);
  });

  it("fails closed on spawn errors or signal termination", () => {
    expect(checkWorkerPackage({ run: () => ({ error: new Error("spawn failed"), status: null }) })).toEqual({ status: 1 });
    expect(checkWorkerPackage({ run: () => ({ status: null }) })).toEqual({ status: 1 });
  });

  it("fails closed when the Pages artifact would publish source maps", () => {
    const run = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mkdirSync(join(root, "out", "_next", "static", "chunks"), { recursive: true });
    writeFileSync(join(root, "out", "_next", "static", "chunks", "page.js.map"), "{}");
    expect(checkWorkerPackage({ run })).toEqual({ status: 1 });
    expect(run).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("never emit source maps into Pages assets"));
  });

  it.each([
    [0, "\u0100"],
    [0, "\u2019"],
    [1, "\u20ac"],
    [1, "\u2013"],
    [1, "\u2014"],
    [1, "\ud83d\ude00"],
  ])("rejects non-Latin-1 script source in bundle %s (%s)", (failedIndex, character) => {
    let invocation = 0;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi.fn((_command: string, args: string[]) =>
      emit(args, invocation++ === failedIndex ? `export const text = "${character}";` : undefined));
    expect(checkWorkerPackage({ run })).toEqual({ status: 1 });
    expect(run).toHaveBeenCalledTimes(Number(failedIndex) + 1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Use equivalent \\uXXXX escapes"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("docs/worker-infrastructure.md#module-initialization"));
  });

  it.each([
    "../../src/api/og.tsx",
    "./.././src/api/og.tsx",
    `${"./../".repeat(10_000)}src/api/og.tsx`,
    "../../worker/src/api/telegram-webhook.ts",
    "../../worker/src/api/telegram-mini-app.ts",
    "../../worker/src/api/telegram-adoption.ts",
    "../../worker/src/api/admin-telegram-broadcast.ts",
    "../../worker/src/api/telegram-pulse.ts",
    "../../src/telegram/webhook/telegram-webhook.ts",
    "../../worker/src/telegram/webhook/telegram-pulse.ts",
    "/repo/worker/src/telegram/mini-app/telegram-mini-app.ts",
    "../../worker/src/telegram/adoption/telegram-adoption.ts",
    "../../worker/src/telegram/admin/admin-telegram-broadcast.ts",
    "..\\..\\worker\\src\\telegram\\webhook\\telegram-webhook.ts",
    "/repo/worker/src/api/og.tsx",
    "../../worker/src/handlers/http/request-dispatch.ts",
    "../../worker/src/routes/public-routes.ts",
    "../../src/handlers/http/request-dispatch.ts",
    "../../src/routes/public-routes.ts",
    "../../src/handlers/scheduled/public-runners.ts",
    "../../worker/src/router.ts",
    "../../assets/fonts/Inter.ttf",
    "../../node_modules/@resvg/resvg-wasm/index.js",
    "../../node_modules/yoga-wasm-web/dist/yoga.wasm",
    "..\\..\\worker\\src\\api\\health.ts",
  ])("rejects heavy source reachability for %s", (source) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi.fn((_command: string, args: string[]) => {
      const result = emit(args);
      if (args.includes("wrangler.heavy.toml")) {
        writeFileSync(join(args.at(-1)!, "worker.js.map"), JSON.stringify({ sources: [source] }));
      }
      return result;
    });
    expect(checkWorkerPackage({ run })).toEqual({ status: 1 });
  });

  it.each([
    "../../shared/lib/api-endpoints/definitions.ts",
    "./.././shared/lib/api-endpoints/definitions.ts",
    "../../shared/lib/api-freshness.ts",
    "../../shared/lib/api-query-history.ts",
    "../../shared/lib/api-cache-profiles.ts",
    "../../worker/src/lib/api-response.ts",
    "../../src/lib/api-schema.ts",
    "../../src/lib/api-cache-read.ts",
    "../../src/lib/api-methodology.ts",
    "../../node_modules/zod/v4/core/api.js",
    "../../node_modules/example/src/api/helpers.js",
    "../../worker/src/lib/telegram.ts",
    "../../worker/src/lib/telegram/digest-outbox.ts",
    "../../worker/src/telegram/delivery/telegram.ts",
    "../../worker/src/telegram/outbox/digest-outbox.ts",
    "../../worker/src/cron/telegram/delivery/telegram-digest-transport.ts",
  ])("permits shared primitives and Telegram transport/outbox in the heavy graph (%s)", (source) => {
    writeFileSync(join(root, "worker.js.map"), JSON.stringify({ sources: [source] }));
    expect(checkHeavyReachability(root)).toBe(true);
  });

  it.each(["font.ttf", "font.otf", "font.woff", "font.woff2", "render.wasm"])(
    "rejects heavy binary rendering asset %s", (asset) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      mkdirSync(join(root, "chunks"), { recursive: true });
      writeFileSync(join(root, "worker.js.map"), JSON.stringify({ sources: ["src/index.heavy.ts"] }));
      writeFileSync(join(root, "chunks", asset), "");
      expect(checkHeavyReachability(root)).toBe(false);
    },
  );

  it.each([null, "not JSON", "{}", '{"sources":[]}', '{"sources":[42]}'])(
    "fails closed when source-map evidence is missing or invalid (%s)", (map) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      if (map !== null) writeFileSync(join(root, "worker.js.map"), map);
      expect(checkHeavyReachability(root)).toBe(false);
    },
  );

  it("permits HTTP sources and rendering assets only in the public package", () => {
    const run = vi.fn((_command: string, args: string[]) => {
      const result = emit(args);
      if (args.includes("wrangler.toml")) {
        writeFileSync(join(args.at(-1)!, "worker.js.map"), JSON.stringify({ sources: ["../../src/api/og.tsx"] }));
        writeFileSync(join(args.at(-1)!, "font.ttf"), "");
        writeFileSync(join(args.at(-1)!, "render.wasm"), "");
      }
      return result;
    });
    expect(checkWorkerPackage({ run })).toEqual({ status: 0 });
  });

});

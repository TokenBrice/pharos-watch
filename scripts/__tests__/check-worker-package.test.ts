import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkWorkerPackage } from "../ci/check-worker-package";

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
    // Maps and binary assets are not retained JavaScript source.
    writeFileSync(join(directory, "worker.js.map"), "\u20ac");
    writeFileSync(join(directory, "font.ttf"), "\u20ac");
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

});

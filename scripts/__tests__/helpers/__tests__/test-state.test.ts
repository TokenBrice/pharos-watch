import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withEnv, withTempRepo } from "../test-state";

const envKey = "PHAROS_SCOPED_STATE_TEST";

describe("withEnv", () => {
  it("returns synchronously and restores nested overrides and synchronous errors", () => {
    const previous = process.env[envKey];
    expect(withEnv(envKey, "outer", () => {
      expect(withEnv(envKey, undefined, () => process.env[envKey])).toBeUndefined();
      expect(process.env[envKey]).toBe("outer");
      expect(() => withEnv(envKey, "inner", () => { throw new Error("sync"); })).toThrow("sync");
      expect(process.env[envKey]).toBe("outer");
      return 42;
    })).toBe(42);
    expect(process.env[envKey]).toBe(previous);
  });

  it.each([false, true])("keeps the override through asynchronous settlement (reject=%s)", async (reject) => {
    const previous = process.env[envKey];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let observed: string | undefined;
    let callback!: Promise<number>;
    const failure = new Error("async");
    const result = withEnv(envKey, "pending", () => {
      callback = (async () => {
        await gate;
        observed = process.env[envKey];
        if (reject) throw failure;
        return 42;
      })();
      // Keep the old helper's discarded rejection from leaking out of this regression.
      void callback.catch(() => {});
      return callback;
    });
    const settlement = Promise.resolve(result).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const during = process.env[envKey];
    release();
    await callback.catch(() => {});
    const outcome = await settlement;
    expect(during).toBe("pending");
    expect(observed).toBe("pending");
    expect(outcome).toEqual(reject ? { error: failure } : { value: 42 });
    expect(process.env[envKey]).toBe(previous);
  });
});

describe("withTempRepo", () => {
  it("returns synchronously and removes the directory even when the callback throws", () => {
    let root = "";
    expect(withTempRepo("state", { "nested/input.txt": "input" }, (dir) => {
      root = dir;
      return readFileSync(join(dir, "nested/input.txt"), "utf8");
    })).toBe("input");
    expect(existsSync(root)).toBe(false);
    expect(() => withTempRepo("state", {}, (dir) => {
      root = dir;
      throw new Error("sync");
    })).toThrow("sync");
    expect(existsSync(root)).toBe(false);
  });

  it.each([false, true])("keeps files until asynchronous settlement (reject=%s)", async (reject) => {
    let root = "";
    let observed: string | undefined;
    let callback!: Promise<string>;
    const failure = new Error("async");
    const result = withTempRepo("state", { "input.txt": "input" }, (dir) => {
      root = dir;
      callback = (async () => {
        await Promise.resolve();
        observed = readFileSync(join(dir, "input.txt"), "utf8");
        if (reject) throw failure;
        return observed;
      })();
      void callback.catch(() => {});
      return callback;
    });
    const outcome = await Promise.resolve(result).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await callback.catch(() => {});
    expect(observed).toBe("input");
    expect(outcome).toEqual(reject ? { error: failure } : { value: "input" });
    expect(existsSync(root)).toBe(false);
  });
});

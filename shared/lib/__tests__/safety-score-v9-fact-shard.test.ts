import { describe, expect, it, vi } from "vitest";
import { deserializeV9FactShard, serializeV9FactShard } from "../safety-score-v9/fact-shard";
import { stableJsonStringifyV1 } from "../stable-json";
import { compileNativeV3FactSet, coreFixture } from "./safety-score-v9-facts.fixture-support";
import * as factShard from "../safety-score-v9/fact-shard";
import { evaluateValidatedV9FactSetForPublication } from "../safety-score-v9/evaluate-set";
import { V9_CANDIDATE_POLICY_V1 } from "../safety-score-v9/policy";

describe("invocation-private V9 fact shards", () => {
  it("preserves admitted facts and repeated evidence references without expanding aliases", () => {
    const facts = compileNativeV3FactSet(coreFixture());
    for (const asset of facts.assets) {
      const shard = serializeV9FactShard(asset);
      expect(shard).toBeInstanceOf(Uint8Array);
      expect(shard.byteLength).toBeLessThan(new TextEncoder().encode(stableJsonStringifyV1(asset)).byteLength);
      const restored = deserializeV9FactShard(shard);
      expect(restored).toEqual(asset);
      expect(stableJsonStringifyV1(restored)).toBe(stableJsonStringifyV1(asset));
      const restoredByOriginal = new WeakMap<object, object>();
      const visit = (original: unknown, copy: unknown): void => {
        if (original === null || typeof original !== "object") return;
        expect(copy).not.toBe(original);
        const previous = restoredByOriginal.get(original);
        if (previous !== undefined) {
          expect(copy).toBe(previous);
          return;
        }
        expect(copy).not.toBeNull();
        expect(typeof copy).toBe("object");
        restoredByOriginal.set(original, copy as object);
        expect(Object.keys(copy as object)).toEqual(Object.keys(original));
        for (const key of Object.keys(original)) {
          visit((original as Record<string, unknown>)[key], (copy as Record<string, unknown>)[key]);
        }
      };
      visit(asset, restored);
    }
  });

  it("preserves an own undefined property rather than deleting it or replacing it with null", () => {
    const asset = { ...compileNativeV3FactSet(coreFixture()).assets[0]!, ownUndefined: undefined };
    const restored = deserializeV9FactShard(serializeV9FactShard(asset));
    expect(Object.hasOwn(restored, "ownUndefined")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(restored, "ownUndefined")?.value).toBeUndefined();
    expect(Object.keys(restored)).toEqual(Object.keys(asset));
  });

  it.each([
    ["Date", new Date(0)],
    ["Map", new Map([["key", "value"]])],
    ["Set", new Set(["value"])],
    ["typed array", new Uint8Array([1, 2])],
    ["class instance", new (class FactValue { value = 1; })()],
  ])("rejects nested %s values instead of flattening them", (_name, value) => {
    const asset = { ...compileNativeV3FactSet(coreFixture()).assets[0]!, invalidValue: value };
    expect(() => serializeV9FactShard(asset)).toThrow("non-plain object");
  });

  it.each(["corrupt", "truncated"] as const)(
    "aborts publication evaluation on a %s shard without projecting a partial card cohort",
    (damage) => {
      const facts = compileNativeV3FactSet(coreFixture());
      const original = serializeV9FactShard(facts.assets[0]!);
      const damaged = damage === "corrupt"
        ? new Uint8Array([0xff, 0xff, 0xff])
        : original.slice(0, Math.floor(original.length / 2));
      expect(() => deserializeV9FactShard(damaged)).toThrow();
      const project = vi.fn();
      const serialize = vi.spyOn(factShard, "serializeV9FactShard").mockReturnValue(damaged);
      try {
        expect(() => evaluateValidatedV9FactSetForPublication(
          { factSet: facts }, V9_CANDIDATE_POLICY_V1, project,
        )).toThrow();
        expect(project).not.toHaveBeenCalled();
      } finally {
        serialize.mockRestore();
      }
    },
  );
});

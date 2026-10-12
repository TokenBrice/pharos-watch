import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { DIGEST_LLM_PROFILE_CACHE_KEYS, readDigestLlmProfiles, resolveDigestLlmProfile } from "../digest-llm-profile";

function cacheDb(values: Record<string, string>): D1Database {
  return mockD1(Object.values(DIGEST_LLM_PROFILE_CACHE_KEYS).map((key) => ({
    match: "FROM cache WHERE key",
    matchBinds: [key],
    rows: values[key] === undefined ? [] : [{ value: values[key], updated_at: 1 }],
    first: values[key] === undefined ? null : { value: values[key], updated_at: 1 },
    allowUnused: true,
  })));
}

describe("digest LLM profile", () => {
  it("reads each kind independently and defaults to standard", async () => {
    const db = cacheDb({ [DIGEST_LLM_PROFILE_CACHE_KEYS.weekly]: "heavy" });
    await expect(resolveDigestLlmProfile(db, "daily")).resolves.toBe("standard");
    await expect(resolveDigestLlmProfile(db, "weekly")).resolves.toBe("heavy");
    await expect(readDigestLlmProfiles(db)).resolves.toEqual({ daily: "standard", weekly: "heavy" });
  });

  it("treats an invalid stored value as standard", async () => {
    const db = cacheDb({ [DIGEST_LLM_PROFILE_CACHE_KEYS.daily]: "turbo" });
    await expect(resolveDigestLlmProfile(db, "daily")).resolves.toBe("standard");
  });

  it("falls back to standard when the scheduled read fails, but propagates cancellation", async () => {
    const failing = { prepare: () => { throw new Error("D1 unavailable"); } } as unknown as D1Database;
    await expect(resolveDigestLlmProfile(failing, "daily")).resolves.toBe("standard");
    const controller = new AbortController();
    controller.abort();
    await expect(resolveDigestLlmProfile(failing, "daily", controller.signal)).rejects.toThrow();
    await expect(readDigestLlmProfiles(failing)).rejects.toThrow("D1 unavailable");
  });
});

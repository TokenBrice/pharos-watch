import { describe, it, expect } from "vitest";
import { mergeCronMetadataWithLease } from "../cron-metadata";

describe("mergeCronMetadataWithLease", () => {
  it("returns lease meta when cron metadata is null", () => {
    const result = mergeCronMetadataWithLease(null, { owner: "test" });
    expect(JSON.parse(result)).toEqual({ owner: "test" });
  });

  it("returns lease meta when cron metadata is undefined", () => {
    const result = mergeCronMetadataWithLease(undefined, { owner: "test" });
    expect(JSON.parse(result)).toEqual({ owner: "test" });
  });

  it("merges when cron metadata is valid JSON", () => {
    const result = mergeCronMetadataWithLease('{"items":5}', { owner: "test" });
    expect(JSON.parse(result)).toEqual({ items: 5, owner: "test" });
  });

  it("falls back to string concat when cron metadata is not JSON", () => {
    const result = mergeCronMetadataWithLease("plain text", { owner: "test" });
    expect(result).toContain("plain text");
    expect(result).toContain("lease=");
  });
});

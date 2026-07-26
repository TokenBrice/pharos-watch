import { describe, expect, it } from "vitest";
import {
  enforceDexArchiveFoundationMode,
  enforceDexArchiveMeasuredShadowMode,
  resolveDexArchiveMode,
} from "../config";

describe("DEX archive mode", () => {
  it.each(["off", "shadow", "delete"] as const)("accepts %s", (value) => {
    expect(resolveDexArchiveMode(value)).toEqual({
      configuredMode: value,
      effectiveMode: value,
      configError: null,
    });
  });

  it("forces invalid values off with an explicit configuration error", () => {
    expect(resolveDexArchiveMode("surprise")).toEqual({
      configuredMode: "invalid",
      effectiveMode: "off",
      configError: "invalid archive mode; expected off, shadow, or delete",
    });
  });

  it("keeps the foundation release incapable of shadow or delete work", () => {
    expect(enforceDexArchiveFoundationMode(resolveDexArchiveMode("delete"))).toEqual({
      configuredMode: "delete",
      effectiveMode: "off",
      configError: 'archive mode "delete" is not active in the foundation release',
    });
  });

  it("permits measured shadow while keeping delete fail-closed before Release C", () => {
    expect(enforceDexArchiveMeasuredShadowMode(resolveDexArchiveMode("shadow"))).toEqual({
      configuredMode: "shadow",
      effectiveMode: "shadow",
      configError: null,
    });
    expect(enforceDexArchiveMeasuredShadowMode(resolveDexArchiveMode("delete"))).toEqual({
      configuredMode: "delete",
      effectiveMode: "off",
      configError: 'archive mode "delete" is not active for measured execution before the delete release',
    });
  });
});

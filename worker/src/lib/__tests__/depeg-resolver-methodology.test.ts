import { describe, expect, it } from "vitest";
import {
  DDR_METHODOLOGY_CHANGELOG_PATH,
  DDR_METHODOLOGY_VERSION,
  DDR_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/depeg-resolver";
import { MethodologyEnvelopeSchema } from "@shared/types/methodology-envelope";
import { buildDdrMethodologyEnvelope } from "../depeg-resolver-methodology";

describe("buildDdrMethodologyEnvelope", () => {
  it.each([0, 1_780_358_400])("publishes a current schema-valid DDR envelope at asOf=%s", (asOf) => {
    const response = buildDdrMethodologyEnvelope(asOf);
    expect(MethodologyEnvelopeSchema.parse(response)).toEqual({
      version: DDR_METHODOLOGY_VERSION,
      versionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      currentVersion: DDR_METHODOLOGY_VERSION,
      currentVersionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      changelogPath: DDR_METHODOLOGY_CHANGELOG_PATH,
      asOf,
      isCurrent: true,
    });
  });

  it("does not overwrite the caller's observation clock or leak mutation between responses", () => {
    const old = buildDdrMethodologyEnvelope(1_700_000_000);
    old.version = "caller-mutated";
    const current = buildDdrMethodologyEnvelope(1_780_358_400);
    expect(current.version).toBe(DDR_METHODOLOGY_VERSION);
    expect(current.asOf).toBe(1_780_358_400);
    expect(old.asOf).toBe(1_700_000_000);
  });
});

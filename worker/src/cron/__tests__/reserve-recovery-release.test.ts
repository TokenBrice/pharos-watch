import { describe, expect, it } from "vitest";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { selectConfigRecoveryTargets } from "../../lib/live-reserves/config-recovery-targets";

const config: LiveReservesConfig = {
  adapter: "m0", version: 1, semantics: "collateral-mix",
  inputs: { primary: { kind: "http-json", url: "https://example.com/reserves" } },
};
const initial = computeLiveReserveConfigFingerprint(config);

describe("live reserve release recovery coverage", () => {
  it("lists a changed semantic configuration as a recovery target", () => {
    const updated = computeLiveReserveConfigFingerprint({ ...config, params: { reviewedScope: "updated" } });
    expect(selectConfigRecoveryTargets(new Map([["changed", initial]]), new Map([["changed", updated]]), () => true))
      .toEqual({ targets: ["changed"], missingFetcherIds: [] });
  });

  it("does not select unchanged semantic inputs or display-only edits", () => {
    const displayed = computeLiveReserveConfigFingerprint({ ...config, display: { label: "New display", url: "https://example.com" } });
    expect(selectConfigRecoveryTargets(new Map([["unchanged", initial]]), new Map([["unchanged", displayed]]), () => true))
      .toEqual({ targets: [], missingFetcherIds: [] });
  });

  it("excludes removed coins and new bindings without retained evidence", () => {
    expect(selectConfigRecoveryTargets(new Map([["removed", initial]]), new Map([["new", initial]]), () => true))
      .toEqual({ targets: [], missingFetcherIds: [] });
  });

  it("does not turn legacy unbound evidence into a proven semantic mismatch", () => {
    expect(selectConfigRecoveryTargets(new Map([["legacy", null]]), new Map([["legacy", initial]]), () => true))
      .toEqual({ targets: [], missingFetcherIds: [] });
  });

  it("quarantines a changed coin without a registered fetcher while keeping covered peers", () => {
    const updated = computeLiveReserveConfigFingerprint({ ...config, version: 2 });
    expect(selectConfigRecoveryTargets(
      new Map([["uncovered", initial], ["covered", initial]]),
      new Map([["uncovered", updated], ["covered", updated]]),
      (id) => id === "covered",
    )).toEqual({ targets: ["covered"], missingFetcherIds: ["uncovered"] });
  });
});

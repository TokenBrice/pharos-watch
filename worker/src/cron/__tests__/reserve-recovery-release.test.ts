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
      .toEqual(["changed"]);
  });

  it("does not select unchanged semantic inputs or display-only edits", () => {
    const displayed = computeLiveReserveConfigFingerprint({ ...config, display: { label: "New display", url: "https://example.com" } });
    expect(selectConfigRecoveryTargets(new Map([["unchanged", initial]]), new Map([["unchanged", displayed]]), () => true))
      .toEqual([]);
  });

  it("excludes removed coins and new bindings without retained evidence", () => {
    expect(selectConfigRecoveryTargets(new Map([["removed", initial]]), new Map([["new", initial]]), () => true))
      .toEqual([]);
  });

  it("does not turn legacy unbound evidence into a proven semantic mismatch", () => {
    expect(selectConfigRecoveryTargets(new Map([["legacy", null]]), new Map([["legacy", initial]]), () => true))
      .toEqual([]);
  });

  it("fails when a changed existing coin has no registered fetcher", () => {
    const updated = computeLiveReserveConfigFingerprint({ ...config, version: 2 });
    expect(() => selectConfigRecoveryTargets(new Map([["uncovered", initial]]), new Map([["uncovered", updated]]), () => false))
      .toThrow("Live reserve config recovery has no registered fetcher for uncovered");
  });
});

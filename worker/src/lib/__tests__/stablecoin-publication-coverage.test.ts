import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { evaluateStablecoinPublicationCoverage } from "../stablecoin-publication-coverage";

const CURRENT_NIGHT_WATCH_OMISSIONS = [
  "benji-franklin-templeton",
  "wtgxx-wisdomtree",
  "busd0-usual",
  "tbill-openeden",
  "rusd-royal-dollar",
  "cetes-etherfuse",
  "jusd-jusd-stable-token",
  "vndc-jade-labs",
  "sofid-sofi",
] as const;

describe("evaluateStablecoinPublicationCoverage", () => {
  const nowSec = 1_777_000_000;
  const activeIds = ACTIVE_STABLECOINS.map((stablecoin) => stablecoin.id);

  it("names all nine omissions observed during Night Watch", () => {
    const omitted = new Set<string>(CURRENT_NIGHT_WATCH_OMISSIONS);
    const coverage = evaluateStablecoinPublicationCoverage(
      activeIds.filter((id) => !omitted.has(id)),
      nowSec,
    );

    expect(coverage.complete).toBe(false);
    expect(coverage.presentActiveCount).toBe(activeIds.length - CURRENT_NIGHT_WATCH_OMISSIONS.length);
    expect([...coverage.missingActiveIds].sort()).toEqual([...CURRENT_NIGHT_WATCH_OMISSIONS].sort());
  });

  it("accepts only owned, reasoned, unexpired waivers", () => {
    const missingId = CURRENT_NIGHT_WATCH_OMISSIONS[0];
    const present = activeIds.filter((id) => id !== missingId);

    expect(evaluateStablecoinPublicationCoverage(present, nowSec, [{
      stablecoinId: missingId,
      owner: "data-operations",
      reason: "issuer endpoint maintenance",
      expiresAt: nowSec + 3600,
    }]).complete).toBe(true);

    const expired = evaluateStablecoinPublicationCoverage(present, nowSec, [{
      stablecoinId: missingId,
      owner: "data-operations",
      reason: "issuer endpoint maintenance",
      expiresAt: nowSec,
    }]);
    expect(expired.complete).toBe(false);
    expect(expired.expiredWaiverIds).toContain(missingId);

    const unowned = evaluateStablecoinPublicationCoverage(present, nowSec, [{
      stablecoinId: missingId,
      owner: "",
      reason: "issuer endpoint maintenance",
      expiresAt: nowSec + 3600,
    }]);
    expect(unowned.complete).toBe(false);
    expect(unowned.invalidWaiverIds).toContain(missingId);
  });

  it("becomes exact again as soon as a restored row is present", () => {
    expect(evaluateStablecoinPublicationCoverage(activeIds, nowSec).complete).toBe(true);
  });
});

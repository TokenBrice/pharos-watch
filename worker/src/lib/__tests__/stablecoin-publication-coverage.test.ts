import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import {
  STABLECOIN_PUBLICATION_WAIVERS,
  evaluateStablecoinPublicationCoverage,
} from "../stablecoin-publication-coverage";

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
  "gramg-token-teknoloji",
  "grams-token-teknoloji",
] as const;

const RESTORED_FROM_DEFILLAMA_ID = "rusd-royal-dollar";
const WAIVED_NIGHT_WATCH_OMISSIONS = CURRENT_NIGHT_WATCH_OMISSIONS.filter(
  (id) => id !== RESTORED_FROM_DEFILLAMA_ID,
);

describe("evaluateStablecoinPublicationCoverage", () => {
  const nowSec = Date.UTC(2026, 6, 10) / 1000;
  const activeIds = ACTIVE_STABLECOINS.map((stablecoin) => stablecoin.id);

  it("restores Royal Dollar while accounting for the audited omissions", () => {
    const omitted = new Set<string>(CURRENT_NIGHT_WATCH_OMISSIONS);
    const waived = new Set<string>(WAIVED_NIGHT_WATCH_OMISSIONS);
    const beforeRestore = evaluateStablecoinPublicationCoverage(
      activeIds.filter((id) => !omitted.has(id)),
      nowSec,
    );

    expect(beforeRestore.complete).toBe(false);
    expect(beforeRestore.missingActiveIds).toEqual([RESTORED_FROM_DEFILLAMA_ID]);
    expect([...beforeRestore.waivedActiveIds].sort()).toEqual([...WAIVED_NIGHT_WATCH_OMISSIONS].sort());

    const afterRestore = evaluateStablecoinPublicationCoverage(
      activeIds.filter((id) => !waived.has(id)),
      nowSec,
    );
    expect(afterRestore.complete).toBe(true);
    expect(afterRestore.presentActiveCount).toBe(activeIds.length - WAIVED_NIGHT_WATCH_OMISSIONS.length);
    expect(afterRestore.waivedActiveCount).toBe(WAIVED_NIGHT_WATCH_OMISSIONS.length);
  });

  it("keeps the audited waiver roster owned, reasoned, and short-lived", () => {
    expect(STABLECOIN_PUBLICATION_WAIVERS).toHaveLength(10);
    expect(STABLECOIN_PUBLICATION_WAIVERS.map((waiver) => waiver.stablecoinId).sort()).toEqual(
      [...WAIVED_NIGHT_WATCH_OMISSIONS].sort(),
    );
    expect(STABLECOIN_PUBLICATION_WAIVERS.every((waiver) => (
      waiver.owner === "data-platform"
      && waiver.reason.length > 0
      && waiver.expiresAt === Date.UTC(2026, 7, 10) / 1000
    ))).toBe(true);
  });

  it("fails exact coverage again when the audited waivers expire", () => {
    const waivedIds = new Set<string>(WAIVED_NIGHT_WATCH_OMISSIONS);
    const coverage = evaluateStablecoinPublicationCoverage(
      activeIds.filter((id) => !waivedIds.has(id)),
      Date.UTC(2026, 7, 10) / 1000,
    );

    expect(coverage.complete).toBe(false);
    expect([...coverage.missingActiveIds].sort()).toEqual([...WAIVED_NIGHT_WATCH_OMISSIONS].sort());
    expect([...coverage.expiredWaiverIds].sort()).toEqual([...WAIVED_NIGHT_WATCH_OMISSIONS].sort());
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

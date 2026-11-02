import { describe, expect, it } from "vitest";
import { makeStablecoinMeta } from "@shared/test-utils/stablecoin";
import { formatUtcDayLabel } from "@shared/lib/format";
import { TRACKED_META_BY_ID, TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { StablecoinMeta } from "@shared/types";
import { PUBLIC_DATASET_CURRENT_DATE } from "@/lib/datasets/public-dataset-current";
import {
  buildPageMetadata,
  buildStablecoinDetailMetadata,
  composeDescription,
  getLatestDatedMilestoneDate,
  hasVolatileAmount,
} from "@/lib/page-metadata";
import { getSnapshotSafetyAssessment } from "@/lib/safety-grade-snapshot";
import { isStablecoinTitleTreatment } from "@/lib/stablecoin-title-cohort";
import { formatFuzzyDate } from "@/lib/pre-launch";

// Cohort membership is frozen in stablecoin-title-cohort.json.
const TREATMENT_ID = "usdc-circle";
const CONTROL_ID = "usdt-tether";

function titleOf(coin: StablecoinMeta): string {
  return buildStablecoinDetailMetadata(coin).title as string;
}

function descriptionOf(coin: StablecoinMeta): string {
  return buildStablecoinDetailMetadata(coin).description as string;
}

function testCoin(overrides: Partial<StablecoinMeta> = {}): StablecoinMeta {
  return makeStablecoinMeta({ symbol: "TSTX", name: "Test Dollar", ...overrides });
}

describe("composeDescription", () => {
  it("appends whole sentences in priority order and skips any that do not fit", () => {
    expect(composeDescription(["Alpha one.", `${"x".repeat(40)}.`, null, "Beta."], 20)).toBe("Alpha one. Beta.");
  });

  it("takes the first alternative of a part that fits", () => {
    expect(composeDescription([["A sentence that is too long.", "Short one."], "Tail."], 16)).toBe("Short one. Tail.");
  });

  it("cuts at a word boundary without an ellipsis only when nothing fits", () => {
    const description = composeDescription(["alpha beta gamma delta"], 15);
    expect(description).toBe("alpha beta");
    expect(description.endsWith("…")).toBe(false);
  });
});

describe("hasVolatileAmount", () => {
  it.each([
    "live in an institution-only beta with ~HK$527k circulating",
    "backed by ETH and BTC, with a 5M USDC PSM",
    "holding $1.2B in reserves",
    "the fund's AUM is reported monthly",
  ])("flags %j", (text) => {
    expect(hasVolatileAmount(text)).toBe(true);
  });

  it.each([
    "NAV-pegged to $1 and backed by U.S. Treasuries",
    "redeemable 1:1 for USD",
    "each token redeemable for 1 gram of 24K physical gold",
    "an SEC-registered fund with a stable $1.00 NAV",
  ])("keeps %j", (text) => {
    expect(hasVolatileAmount(text)).toBe(false);
  });
});

describe("active profile titles", () => {
  it("splits the cohort by the frozen canonical-order id set", () => {
    expect(isStablecoinTitleTreatment(TREATMENT_ID)).toBe(true);
    expect(isStablecoinTitleTreatment(CONTROL_ID)).toBe(false);
  });

  it("treatment leads with symbol, Stablecoin and brand, and falls back when the brand does not fit", () => {
    expect(titleOf(testCoin({ id: TREATMENT_ID, brand: "Acme" }))).toBe("TSTX Stablecoin (Acme): Safety Score & Risk");
    expect(titleOf(testCoin({ id: TREATMENT_ID, name: "Test Dollar Issued By A Long Name Trust" })))
      .toBe("TSTX Stablecoin: Safety Score & Risk");
  });

  it("treatment NAV tokens drop Stablecoin and use Backing & Risk", () => {
    const nav = testCoin({ id: TREATMENT_ID, brand: "Acme", flags: { ...testCoin().flags, navToken: true } });
    expect(titleOf(nav)).toBe("TSTX (Acme): Safety Score, Backing & Risk");
  });

  it("treatment keeps the name disambiguator for tickers shared by tracked records", () => {
    const counts = new Map<string, number>();
    for (const coin of TRACKED_STABLECOINS) {
      const key = coin.symbol.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const shared = TRACKED_STABLECOINS.find((coin) => (counts.get(coin.symbol.toLowerCase()) ?? 0) >= 2);
    expect(shared).toBeDefined();
    const title = titleOf(testCoin({ id: TREATMENT_ID, symbol: shared!.symbol, name: "Test Dollar", brand: "Acme" }));
    expect(title).toContain(`${shared!.symbol} `);
    expect(title).toContain("(Test Dollar)");
  });

  it("control keeps the previous chain under the shorter budget, with brand for redundant names", () => {
    expect(titleOf(testCoin({ id: CONTROL_ID }))).toBe("TSTX (Test Dollar) Stablecoin Risk Profile");
    expect(titleOf(testCoin({ id: CONTROL_ID, name: "TSTX", brand: "Acme" })))
      .toBe("TSTX (Acme) Stablecoin Safety Score & Risk Profile");
    expect(titleOf(testCoin({ id: CONTROL_ID, name: "TSTX" }))).toBe("TSTX Stablecoin Safety Score & Risk Profile");
  });

  it("retires the September metadata pilot overrides", () => {
    const paxg = TRACKED_META_BY_ID.get("paxg-paxos");
    expect(paxg).toBeDefined();
    expect(titleOf(paxg!)).not.toBe("PAX Gold (PAXG): Gold Backing, Custody & Risk");
    expect(descriptionOf(paxg!)).not.toContain("Compare PAXG with XAUT");
  });
});

describe("active profile descriptions", () => {
  it("leads with the dated scores-latest grade, then the curated oneLiner", () => {
    const assessment = getSnapshotSafetyAssessment(TREATMENT_ID);
    expect(assessment).not.toBeNull();
    const date = formatUtcDayLabel(new Date(`${PUBLIC_DATASET_CURRENT_DATE}T00:00:00Z`));
    const description = descriptionOf(testCoin({
      id: TREATMENT_ID,
      oneLiner: "TSTX is Acme's {{term:attestation}}attested{{/term}} dollar stablecoin.",
    }));
    expect(description.startsWith(`Safety Score ${assessment!.grade} (${date}). TSTX is Acme's attested dollar stablecoin.`))
      .toBe(true);
  });

  it("uses the oneLiner alone without a grade and replaces a volatile oneLiner with the fixed sentence", () => {
    expect(descriptionOf(testCoin({ oneLiner: "TSTX is Acme's dollar stablecoin." })))
      .toBe("TSTX is Acme's dollar stablecoin.");
    const volatile = descriptionOf(testCoin({ oneLiner: "TSTX is live with ~HK$527k circulating." }));
    expect(volatile).toBe("Test Dollar (TSTX) is a centralized stablecoin backed by real-world assets, pegged to US Dollar.");
  });

  it("fixes the NAV-token fallback grammar", () => {
    const nav = testCoin({ flags: { ...testCoin().flags, navToken: true }, brand: "Acme" });
    expect(descriptionOf(nav)).toBe(
      "Test Dollar (TSTX) is Acme's centralized yield-bearing token backed by real-world assets, with US Dollar-denominated NAV.",
    );
  });
});

describe("pre-launch metadata", () => {
  const milestones = [
    { date: "2026-09-01", type: "announcement", title: "Announced" },
    { date: "2026-10-05", type: "milestone", title: "Beta opened" },
    { date: "2026-11", type: "milestone", title: "Fuzzy month" },
  ] satisfies StablecoinMeta["milestones"];

  it("uses the phase-aware title ladder", () => {
    expect(titleOf(testCoin({ status: "pre-launch", launchPhase: "beta", brand: "Acme" })))
      .toBe("TSTX Stablecoin (Acme): Beta Access & Status");
    expect(titleOf(testCoin({ status: "pre-launch", launchPhase: "announced", name: "TSTX" })))
      .toBe("TSTX Stablecoin: Launch Date & Status");
  });

  it("appends the newest dated milestone and the target without inferring dates", () => {
    const coin = testCoin({
      status: "pre-launch",
      oneLiner: "TSTX is Acme's planned dollar stablecoin.",
      milestones,
      expectedLaunchDate: "2026-Q4",
    });
    expect(getLatestDatedMilestoneDate(coin)).toBe("2026-10-05");
    expect(descriptionOf(coin)).toBe(
      "TSTX is Acme's planned dollar stablecoin. Latest milestone: Oct 5, 2026. Target: Q4 2026.",
    );
    expect(descriptionOf(testCoin({ status: "pre-launch", oneLiner: "TSTX is planned." }))).toBe("TSTX is planned.");
  });

  it("titles a launched row for status, not launch intent, and drops the target", () => {
    const launched = testCoin({
      status: "pre-launch",
      launchPhase: "launched",
      launchDate: "2026-10-05",
      expectedLaunchDate: "2026-Q3",
      oneLiner: "TSTX is Acme's dollar stablecoin.",
      milestones,
    });
    expect(titleOf(launched)).toBe("TSTX Stablecoin (Test Dollar): Status & Tracking");
    expect(descriptionOf(launched)).toBe(
      "TSTX is Acme's dollar stablecoin. Launched Oct 5, 2026; not yet tracked. Latest milestone: Oct 5, 2026.",
    );
    expect(descriptionOf(testCoin({ status: "pre-launch", launchPhase: "launched", launchDate: "2026-10-05" })))
      .not.toContain("pre-launch");
  });

  it("keeps the curated one-liner ahead of the launched caveat, which outranks any milestone, on all 12 rows", () => {
    const launchedRows = TRACKED_STABLECOINS.filter(
      (coin) => coin.status === "pre-launch" && coin.launchPhase === "launched",
    );
    expect(launchedRows).toHaveLength(12);
    for (const coin of launchedRows) {
      const description = descriptionOf(coin);
      // The curated one-liner is never shortened or displaced by the caveat.
      expect(description.startsWith(coin.oneLiner!), coin.id).toBe(true);
      expect(description.length, coin.id).toBeLessThanOrEqual(180);
      const caveatIndex = description.indexOf("not yet tracked");
      const milestoneIndex = description.indexOf("Latest milestone:");
      if (caveatIndex >= 0 && milestoneIndex >= 0) {
        expect(caveatIndex, coin.id).toBeLessThan(milestoneIndex);
      }
      if (caveatIndex < 0) {
        // Dropped only because the whole one-liner plus the caveat cannot fit.
        const caveat = coin.launchDate ? `Launched ${formatFuzzyDate(coin.launchDate)}; not yet tracked.` : "Launched; not yet tracked.";
        expect(coin.oneLiner!.length + 1 + caveat.length, coin.id).toBeGreaterThan(180);
      }
    }
  });
});

describe("inactive profile metadata", () => {
  it("uses plain listing-status copy without pipeline reasons", () => {
    const quarantined = testCoin({
      status: "quarantined",
      oneLiner: "TSTX is Acme's dollar stablecoin.",
      listingStatusReview: { changedAt: "2026-09-30", reason: "permitted runtime sources do not provide a positive circulating supply" },
    });
    expect(titleOf(quarantined)).toBe("TSTX (Test Dollar): Profile & Listing Status");
    expect(descriptionOf(quarantined)).toBe(
      "TSTX is Acme's dollar stablecoin. Not currently scored by Pharos: price or supply data under review. See history and documents.",
    );

    const delisted = testCoin({
      status: "delisted",
      name: "TSTX",
      listingStatusReview: { changedAt: "2026-09-30", reason: "Out of scope: a deal-specific ownership note." },
    });
    expect(titleOf(delisted)).toBe("TSTX: Profile & Listing Status");
    expect(descriptionOf(delisted)).toContain("Not currently scored by Pharos: outside the listing scope.");
  });
});

describe("frozen profile metadata", () => {
  it("claims no Pharos tracking window and never repeats a name as its own symbol", () => {
    for (const coin of TRACKED_STABLECOINS.filter((candidate) => candidate.status === "frozen")) {
      const description = descriptionOf(coin);
      expect(description, coin.id).not.toContain("tracked by Pharos through");
      expect(description, coin.id).not.toContain("freeze date");
      expect(description, coin.id).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      if (coin.name.trim().toLowerCase() === coin.symbol.trim().toLowerCase()) {
        expect(description, coin.id).not.toContain(`${coin.name} (${coin.symbol})`);
      }
    }
  });

  it("drops the redundant parenthetical and keeps the epitaph", () => {
    const coin = TRACKED_META_BY_ID.get("usdkg-gold-dollar")!;
    expect(descriptionOf(coin)).toBe(
      `Historical data and obituary for USDKG, a now-defunct stablecoin that died in Oct 2026. ${coin.obituary?.epitaph}`,
    );
  });
});

describe("tracked profile metadata invariants", () => {
  it("keeps every profile within the snippet budgets, in whole sentences, with no grade in the title", () => {
    for (const coin of TRACKED_STABLECOINS) {
      const title = titleOf(coin);
      const description = descriptionOf(coin);
      expect(description.endsWith("…"), coin.id).toBe(false);
      expect(description.length, coin.id).toBeLessThanOrEqual(180);
      expect(description, coin.id).not.toMatch(/Live peg score| on \d+ chains/);
      expect(title, coin.id).not.toMatch(/Safety Score [A-F]/);
      if (coin.status !== "frozen") expect(title.length, coin.id).toBeLessThanOrEqual(51);
    }
  });
});

describe("buildPageMetadata", () => {
  it.each(["website", "article"] as const)("emits the shared site identity for %s pages", (ogType) => {
    const metadata = buildPageMetadata({ title: "T", description: "D", canonical: "/x/", ogType });
    expect(metadata.openGraph).toMatchObject({ siteName: "Pharos Watch", locale: "en_US", type: ogType });
    expect(metadata.twitter).toMatchObject({ site: "@PharosWatch", creator: "@TokenBrice" });
  });
});

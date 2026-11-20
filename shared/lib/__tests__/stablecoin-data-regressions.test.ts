import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import felixMintAuthority from "../../data/stablecoins/domains/mint-authority/feusd-felix.json";
import stacReserves from "../../data/stablecoins/domains/reserves/stac-securitize.json";
import usdkgReserves from "../../data/stablecoins/domains/reserves/usdkg-gold-dollar.json";
import usdkgMetadata from "../../data/stablecoins/coins/usdkg-gold-dollar.json";
import ejpyMetadata from "../../data/stablecoins/coins/ejpy-jbfd.json";
import usdcCompliance from "../../data/stablecoins/domains/compliance/usdc-circle.json";
import ousdMetadata from "../../data/stablecoins/coins/ousd-open-standard.json";
import ousdCompliance from "../../data/stablecoins/domains/compliance/ousd-open-standard.json";
import syrupUsdcMetadata from "../../data/stablecoins/coins/syrupusdc-maple.json";
import usd1Metadata from "../../data/stablecoins/coins/usd1-world-liberty-financial.json";
import usdtMetadata from "../../data/stablecoins/coins/usdt-tether.json";
import usdtReserves from "../../data/stablecoins/domains/reserves/usdt-tether.json";
import yldsReserves from "../../data/stablecoins/domains/reserves/ylds-figure.json";
import mechanismOverlays from "../../data/safety-score-v9/mechanism-review-overlays-v1.json";
import cashMintAuthority from "../../data/stablecoins/domains/mint-authority/cash-phantom.json";
import fusdMintAuthority from "../../data/stablecoins/domains/mint-authority/fusd-finchain.json";

describe("stablecoin source-data regressions", () => {
  it.each([
    ["CASH", cashMintAuthority, "76m8dWSAYTuNWMfZS5tR1Az8sYnCGkEJ8WYWJhxAhQ5Q", ["H79WsaPgtctdpmhykRQZ91r8HNr5uqxUWEBe6DZXuhMu", "parsed upgrade authority"]],
    ["FUSD", fusdMintAuthority, "Ch1Z9TZK7hiX73HZnhGQygsZ3zr1Rjh8ifspDfAqVRgm", ["51tpgun58apNKgrk96xAVUCN5yC7cDzt3EHov9UjBh3Q", "numRequiredSigners=1"]],
  ] as const)("%s Solana renewal binds its authority reads to the execution-scope slot", (_name, data, controlAddress, rotationFacts) => {
    const control = (data.mintAuthority.controls as { address: string; observedBlock: number; evidence: string; sources: { label: string; url: string }[]; executionScope?: { pin: { position: string }; sources: { url: string }[] } }[]).find((row) => row.address === controlAddress && row.executionScope)!;
    const scope = control.executionScope!;
    const slot = scope.pin.position;
    expect(control.observedBlock, `pin slot ${slot}`).toBe(Number(slot));
    const scopeUrls = scope.sources.map((source) => source.url);
    const controlUrls = control.sources.map((source) => source.url);
    const alchemyBase = "https://solana-mainnet.g.alchemy.com/v2/";
    const alchemyUrls = (urls: string[]) => urls.filter((url) => url.includes("alchemy.com"));
    for (const urls of [scopeUrls, controlUrls]) {
      expect(urls, `${_name} exact-slot reads must cite the keyless Account Archive base`).toContain(alchemyBase);
      expect(alchemyUrls(urls), `${_name} rejects any other Alchemy URL`).toEqual([alchemyBase]);
    }
    const publicRpc = (url: string) => new URL(url).hostname === "api.mainnet-beta.solana.com";
    expect(scopeUrls.filter(publicRpc), `${_name} exact-slot reads never cite the public RPC`).toEqual([]);
    for (const source of control.sources.filter((row) => publicRpc(row.url))) {
      expect(source.label, `${_name} public RPC citation`).toMatch(/^Historical /);
    }
    const slotMarker = `slot ${slot}`;
    const slotReadAt = control.evidence.lastIndexOf(slotMarker);
    expect(slotReadAt, `${_name} renewal evidence cites slot ${slot}`).toBeGreaterThanOrEqual(0);
    expect(control.evidence[slotReadAt + slotMarker.length], `${_name} cites the complete slot ${slot}`).not.toMatch(/^\d$/);
    const renewedRead = control.evidence.slice(slotReadAt);
    for (const fact of [...rotationFacts, controlAddress]) expect(renewedRead).toContain(fact);
  });

  it("marks every Felix BorrowerOperations debt cap as admin-mutable", () => {
    const borrowerOperations = felixMintAuthority.mintAuthority.controls.filter((control) =>
      control.label.endsWith("BorrowerOperations"),
    );

    expect(borrowerOperations).toHaveLength(4);
    for (const control of borrowerOperations) {
      expect(control.canRaiseCap, control.label).toBe(true);
    }
  });

  it("keeps USDKG physical gold on the active reserve-risk rubric", () => {
    const physicalGold = usdkgReserves.reserves.find((reserve) => reserve.name.startsWith("Physical gold"));

    expect(physicalGold).toMatchObject({ pct: 100, risk: "very-low" });
    expect(physicalGold?.riskFactors).toEqual(
      expect.arrayContaining(["market", "custody", "counterparty", "legal", "liquidity", "concentration"]),
    );
    expect(usdkgReserves.reserveReview.compositionAsOf).toBe(usdkgMetadata.proofOfReserves.latestReport.periodEnd);
  });

  it("binds USDC's EBA significance designation to the exact European issuer without changing authorization", () => {
    expect(usdcCompliance.mica).toMatchObject({
      status: "authorized",
      tokenType: "EMT",
      authorizationType: "emi",
      competentAuthority: "ACPR",
      authorizedEntity: "Circle Internet Financial Europe SAS",
      significant: true,
    });
    expect(usdcCompliance.mica.references).toContainEqual({
      label: "EBA: USDC classified as a significant EMT on October 14, 2026; dual supervision announced to begin November 12, 2026 (official text via search index, accessed October 26, 2026)",
      url: "https://www.eba.europa.eu/publications-and-media/press-releases/eba-classifies-usdc-first-significant-e-money-token-european-union",
    });
  });

  it("keeps EJPY's fiscal-year target as prose instead of a calendar-year date", () => {
    expect(ejpyMetadata).toMatchObject({ status: "pre-launch", launchPhase: "announced", announcedDate: "2026-05" });
    expect("expectedLaunchDate" in ejpyMetadata).toBe(false);
    expect("dateHistory" in ejpyMetadata).toBe(false);
    expect(ejpyMetadata.launchPhaseDetail).toContain("within FY2026 (through March 2027)");
    expect(ejpyMetadata.milestones[0].sourceUrl).toBe("https://www.jbfd.org/news/joc-ejpy");
  });

  it("pins OUSD's pre-launch EY examination as scoped rather than current whole-token assurance", () => {
    const report = ousdMetadata.proofOfReserves.latestReport;
    expect(ousdMetadata.proofOfReserves.cadence).toBe("quarterly");
    expect(report).toMatchObject({
      periodEnd: "2026-08-31",
      liabilityReconciliation: "partial",
      confidence: "verified",
    });
    expect(report.reviewer).toContain("$40,690.16");
    expect(report.reviewer).toContain("0.0046%");
    expect(report.sources.map((source) => source.url)).toContain(
      "https://transparency.bridge.xyz/v0/stablecoins/ousd",
    );
    const overlay = mechanismOverlays.overlays.find((row) => row.assetId === "ousd-open-standard");
    expect(overlay?.components.assuranceAndReconciliation).toMatchObject({ quality: "limited" });
  });

  it("does not claim a published monthly attestation for OUSD's quarterly proof cadence", () => {
    // docs/genius-tracker.md: only a published attestation series supports
    // monthlyAttestationPresent; the single pre-launch EY examination and a
    // documented quarterly/optional engagement do not.
    expect(ousdMetadata.proofOfReserves.cadence).toBe("quarterly");
    expect(ousdCompliance.genius.monthlyAttestationPresent).toBe(false);
  });

  it("refreshes syrupUSDC's collateral dashboard pin and includes the third pool", () => {
    const report = syrupUsdcMetadata.proofOfReserves.latestReport;
    expect(report.reviewReference).toMatchObject({ date: "2026-10-30", reviewedAt: "2026-11-01" });
    expect(syrupUsdcMetadata.proofOfReserves.provider).toContain("syrupUSDG");
    expect(syrupUsdcMetadata.proofOfReserves.provider).toContain("$1,521.43M");
  });

  it("keeps USD1's liability-scope provenance on the same August report as its attestation pin", () => {
    const scope = usd1Metadata.liveReservesConfig.params.liabilityScope;
    expect(scope.reviewedAt).toBe("2026-10-01");
    expect(scope.evidenceRef).toContain("August 2026");
    expect(scope.evidenceRef).not.toContain("July 2026");
    expect(scope.evidenceRef).toContain("Canton");
  });

  it("pins USDT's Q3 2026 BDO composition and conserves its exact-dollar packet", () => {
    const report = usdtMetadata.proofOfReserves.latestReport;
    expect(report).toMatchObject({ periodEnd: "2026-09-30", publishedAt: "2026-10-30" });
    const packet = usdtMetadata.liveReservesConfig.params.reviewedComposition;
    expect(packet.asOf).toBe("2026-09-30");
    expect(packet.totalAssetsUsd).toBe(191451091374);
    expect(packet.rows.reduce((sum, row) => sum + row.dollars, 0)).toBe(packet.totalAssetsUsd);
    expect(usdtReserves.reserveReview.compositionAsOf).toBe("2026-09-30");
    const bitcoin = usdtReserves.reserves.find((row) => row.sourceKey === "tether:usdt:bitcoin");
    expect(bitcoin?.pct).toBe(4.370396);
    const disposition = usdtReserves.reserveReview.nonLinkDispositions.find(
      (row) => row.reserveName === "Bitcoin",
    );
    expect(disposition?.pct).toBe(bitcoin?.pct);
  });

  it("keeps YLDS's unaudited September 2026 10-Q out of the audited reserve source list", () => {
    // Compiled Backing evidence is stamped with the audited period/publication dates,
    // so an unaudited supplemental filing must live in the evidence log, not here.
    const urls = yldsReserves.reserveReview.sources.map((source) => source.url);
    expect(urls).not.toContain("https://www.sec.gov/Archives/edgar/data/1974395/000162828026073949/fcc-20260930.htm");
    expect(yldsReserves.reserveReview.compositionAsOf).toBe("2025-12-31");
  });

  it("pins every dated comparison in STAC's reserve rationale to the same Chronicle source entry", () => {
    const review = stacReserves.reserveReview;
    const CID = /Qm[1-9A-HJ-NP-Za-km-z]{44}/;
    const CID_GLOBAL = /Qm[1-9A-HJ-NP-Za-km-z]{44}/g;
    const MONTHS = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
    const sourceCids = review.sources
      .map((source) => CID.exec(source.url)?.[0])
      .filter((cid): cid is string => Boolean(cid));
    const inlineCids = [...review.rationale.matchAll(CID_GLOBAL)].map((m) => m[0]);
    expect(inlineCids.length).toBeGreaterThan(0);
    for (const cid of inlineCids) {
      expect(sourceCids, `inline CID ${cid} must be a pinned source`).toContain(cid);
    }
    const sourcePairs = review.sources.flatMap((source) => {
      const cid = CID.exec(source.url)?.[0];
      const date = /portfolio date (\d{4})-(\d{2})-(\d{2})/.exec(source.label);
      return cid && date
        ? [{ monthDay: `${MONTHS[Number(date[2]) - 1]} ${Number(date[3])}`, cid }]
        : [];
    });
    const MONTH_DAY = /\b(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}\b/g;
    for (const mention of review.rationale.matchAll(MONTH_DAY)) {
      const start = mention.index ?? 0;
      const cid = CID.exec(review.rationale.slice(start, start + 120))?.[0];
      expect(cid, `dated comparison "${mention[0]}" must cite a CID`).toBeTruthy();
      expect(
        sourcePairs.some((pair) => pair.monthDay === mention[0] && pair.cid === cid),
        `dated comparison "${mention[0]}" must match the source entry for CID ${cid}`,
      ).toBe(true);
    }
    expect(review.rationale).not.toMatch(/only market values/);
  });

  it("scopes STAC's ledger maturity rationale to the public sources actually reviewed", () => {
    const ledgerPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../.github/artifacts/safety-score-missing-data-reviewed-ledger.json",
    );
    const row = JSON.parse(readFileSync(ledgerPath, "utf8")).decisions.find(
      (decision: { claimGroupId: string; evidence?: string[] }) =>
        decision.claimGroupId === "RESERVE_SLICE:stac-securitize" &&
        (decision.evidence ?? []).some((entry) =>
          entry.includes("QmPQnDVp37aJZzTt6UCaK9UAdQv2EUseEiaxjYmfmULvBf"),
        ),
    );
    expect(row).toBeDefined();
    expect(row.rationale).not.toMatch(/no controlling (PPM|private placement memorandum)/i);
    expect(row.rationale).toMatch(/public sources reviewed/);
    expect(row.rationale).toMatch(/private placement memorandum was not available for review/);
  });
});

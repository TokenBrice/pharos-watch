import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEPEG_HUB_LOWS,
  buildSocialCardCatalog,
  socialCardViolations,
  volatileTitleReason,
} from "../lib/social-card-catalog";
import { discoverSocialPreviewPages } from "../lib/social-preview-build";
import { resolveMechanismArchetype } from "../../shared/lib/classification";
import { isDisputedAuditVerdict } from "../../shared/lib/depeg-audit";
import { formatDeathDate } from "../../shared/lib/format";
import type { SocialCardSpec } from "../../shared/lib/social-card/spec";
import { ACTIVE_STABLECOINS, FROZEN_STABLECOINS, PRE_LAUNCH_STABLECOINS, TRACKED_META_BY_ID } from "../../shared/lib/stablecoins/registry";
import { buildStablecoinUrl } from "../../shared/lib/urls";
import { readDepegEventSnapshot } from "../../src/lib/depeg-event-snapshot";
import { DIGEST_ENTRIES } from "../../src/lib/digest-registry";
import { ARCHETYPE_CONTENT } from "../../src/lib/mechanism-explainers";
import { PUBLIC_ROUTE_PATHS } from "../../src/lib/public-route-inventory";

const pages = discoverSocialPreviewPages(process.cwd());
const catalog = buildSocialCardCatalog(pages.paths);
const byPath = new Map(catalog.cards.map((card) => [card.path, card]));
const dossierFor = (id: string) => byPath.get(buildStablecoinUrl(id)) as Extract<SocialCardSpec, { template: "dossier" }>;
const ai = JSON.parse(readFileSync("data/ai-summaries.json", "utf8")) as Record<string, { title: string }>;

describe("social card catalog", () => {
  it("covers every public destination once, deterministically, and fails closed on an unknown one", () => {
    const covered = [...catalog.cards, ...catalog.authored].map((entry) => entry.path);
    expect(new Set(covered).size).toBe(covered.length);
    expect(covered).toEqual(expect.arrayContaining([...PUBLIC_ROUTE_PATHS, ...pages.paths]));
    expect(catalog.authored).toEqual(expect.arrayContaining([expect.objectContaining({ path: "/cemetery/", sourcePath: "/og-cemetery.png" })]));
    expect(buildSocialCardCatalog(pages.paths)).toEqual(catalog);
    expect(() => buildSocialCardCatalog(["/new-public-destination/"])).toThrow("no authored social preview");
  });

  it("keeps every card inside its budgets and fonts, and private tools generic", () => {
    expect(catalog.cards.flatMap((card) => socialCardViolations(card).map((issue) => `${card.path}: ${issue}`))).toEqual([]);
    const home = byPath.get("/")!;
    expect(socialCardViolations({ ...home, label: "x".repeat(29), copy: { ...home.copy, title: "Supply fell \u2014 the peg held." } }))
      .toEqual(["label exceeds 28 characters", "copy.title is empty, over 70 characters or has a clause dash"]);
    for (const path of ["/portfolio/", "/screener/picker/"]) {
      expect(JSON.stringify(byPath.get(path))).not.toMatch(/holdings|balance|wallet|address|\bgrade\b|\bscore\b|[?&]|\d+%/i);
    }
  });

  it("prints an AI title only when the volatility screen passes, else the mechanism headline", () => {
    expect(["Treasury Wall, Thin Equity Cushion", "Known renewals and stillness"].map(volatileTitleReason)).toEqual([null, null]);
    expect(["A 2019 Real", "Frozen at Sixteen Cents", "Now Mostly Cash", "Still Dollar-Backed", "Currently Paused", "New Issuer"].map(volatileTitleReason))
      .toEqual(["digit", "currency amount", 'word "now"', 'word "still"', 'word "currently"', 'word "new"']);
    for (const coin of ACTIVE_STABLECOINS) {
      const title = ai[coin.id]?.title;
      const archetype = resolveMechanismArchetype(coin, TRACKED_META_BY_ID);
      if (title && volatileTitleReason(title) && archetype) expect(dossierFor(coin.id).hook).toBe(ARCHETYPE_CONTENT[archetype].headline);
    }
  });

  it("dates frozen cards by the obituary and launched pre-launch cards by their launch", () => {
    for (const coin of FROZEN_STABLECOINS) {
      expect(dossierFor(coin.id)).toMatchObject({ lifecycle: "historical", stamp: "HISTORICAL RECORD", hook: coin.obituary!.epitaph });
      expect(dossierFor(coin.id).chips[0]).toBe(`Died ${formatDeathDate(coin.obituary!.deathDate)}`);
    }
    expect(dossierFor("aeur-anchored-coins").chips).toEqual(["Died Jul 2024", "Regulatory"]);
    for (const coin of PRE_LAUNCH_STABLECOINS) {
      const card = dossierFor(coin.id);
      expect(card.lifecycle).toBe(coin.launchPhase === "launched" ? "launched-untracked" : "pre-launch");
      expect(card.chips.some((chip) => chip.startsWith("Launched"))).toBe(coin.launchPhase === "launched");
    }
    expect(dossierFor("usd-dinari").chips).toContain("Launched Feb 2024");
  });

  it("draws only real, closed, undisputed USD lows on the depeg hub ruler", () => {
    const events = new Map(readDepegEventSnapshot({ missing: "throw" }).map((event) => [event.slug, event]));
    const ruler = (byPath.get("/depeg/") as Extract<SocialCardSpec, { template: "hub" }>).subject;
    expect(ruler).toMatchObject({ kind: "peg-ruler", peg: 1, floor: 0, currencySymbol: "$" });
    DEPEG_HUB_LOWS.forEach(({ slug }, index) => {
      const event = events.get(slug)!;
      expect(event).toMatchObject({ pegType: "peggedUSD", direction: "below", endedAt: expect.any(Number) });
      expect(isDisputedAuditVerdict(event.provenance?.auditVerdict)).toBe(false);
      expect(Math.abs(event.peakDeviationBps)).toBeLessThanOrEqual(10_000);
      expect(ruler.kind === "peg-ruler" && ruler.lows[index].price).toBeCloseTo(event.peakPrice!, 3);
    });
    expect(byPath.get("/depeg/rubt-2026-02-19/")).toMatchObject({ title: "RUBT: depeg above peg", facts: [] });
  });

  it.each([
    ["/", { template: "hub", subject: { kind: "cluster" } }],
    ["/safety-scores/", { template: "hub", subject: { kind: "grade-shield" } }],
    ["/freezewatch/", { template: "hub", headline: "Who can freeze the money?", subject: { kind: "glyph", glyph: "lock" } }],
    ["/chains/ethereum/", { template: "hub", headline: "Stablecoins on Ethereum", subject: { kind: "orbit", center: { name: "Ethereum", logoPath: "/chains/ethereum.png" } } }],
    ["/stablecoins/governance/cefi-dependent/", { template: "hub", headline: "CeFi-dependent stablecoins", subject: { kind: "cluster" } }],
    ["/stablecoin/usdc-circle/", { template: "dossier", lifecycle: "active", headline: "USDC", subline: "USD Coin · since 2018", chips: ["USD peg", "Custodial cash"] }],
    ["/stablecoin/jusd-juicedollar/", { template: "dossier", lifecycle: "review", stamp: "LISTING REVIEW", hook: "Issuer wind-down" }],
    ["/stablecoin/susde-ethena/yield/", { template: "dossier", label: "Yield source", headline: "Where sUSDe's yield comes from", chips: ["Savings", "USD peg"] }],
    ["/compare/usdt-tether-vs-usdc-circle/", { template: "versus", left: { symbol: "USDT" }, right: { symbol: "USDC" }, hook: "Same peg. Different promises.", copy: { title: "USDT vs USDC" } }],
    ["/learn/mechanisms/fiat-cash/", { template: "record", title: ARCHETYPE_CONTENT["fiat-cash"].headline }],
    ["/learn/case-studies/usdc-svb-2023/", { template: "record", identity: { symbol: "USDC" }, dateline: "March 2023", pill: { text: "Survived", tone: "positive" }, facts: ["Low $0.87"] }],
    ["/learn/case-studies/apxusd-dat-collateral/", { template: "record", dateline: "June 2026", pill: { text: "Ongoing" }, facts: [] }],
    ["/depeg/usdc-2023-03-11/", {
      template: "record", dateline: "11 Mar 2023", title: "USDC: 12.1% below peg", facts: ["Low $0.8789", "Recovered after 1.9 days"],
      ruler: { peg: 1, floor: 0.8, low: 0.8789, currencySymbol: "$" }, copy: { title: "USDC Depeg, March 11, 2023: 12.1% Below Peg" },
    }],
    ["/methodology/scoring-changelog/archive/v1/", { template: "record", dateline: "Feb 2026", facts: ["v1.0"] }],
    ["/docs/dews/", { template: "record", title: "Depeg Early Warning System (DEWS)" }],
  ])("golden %s", (path, expected) => {
    expect(byPath.get(path)).toMatchObject(expected);
  });

  it("mastheads digests with their edition number and date", () => {
    const digest = DIGEST_ENTRIES.find((entry) => entry.editionNumber > 0)!;
    expect(byPath.get(`/digest/${digest.date}/`)).toMatchObject({
      template: "record", masthead: true, title: digest.title, dateline: expect.stringContaining(`No. ${digest.editionNumber} · `),
    });
  });
});

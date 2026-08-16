import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import {
  CASE_STUDY_LIST,
  CASE_STUDY_OUTCOME_COUNTS,
  CASE_STUDIES,
  caseStudySlugForEvent,
} from "../content";
import {
  CASE_STUDY_CLIENT_BY_CEMETERY_ID,
  CASE_STUDY_CLIENT_BY_COIN_ID,
  CASE_STUDY_EVENT_WINDOWS,
  caseStudySlugForEvent as clientCaseStudySlugForEvent,
} from "@/lib/case-study-client-index";
import { resolveCaseStudySlugForEvent as resolveCaseStudySlugForEventFromWindows } from "@/lib/case-study-event-window";
import type { CaseStudy } from "../content/types";

const COINS_DIR = join(process.cwd(), "shared/data/stablecoins/coins");
const CEMETERY_PATH = join(process.cwd(), "public/datasets/stablecoin-cemetery.json");
const CONTENT_DIR = join(process.cwd(), "src/app/learn/case-studies/content");
const KNOWN_INTERNAL_ROUTES = new Set([
  "/about/",
  "/api/",
  "/cemetery/",
  "/changelog/",
  "/compare/",
  "/compliance/",
  "/coverage/",
  "/dependency-map/",
  "/depeg/",
  "/digest/",
  "/freezewatch/",
  "/learn/",
  "/learn/case-studies/",
  "/learn/glossary/",
  "/learn/mechanisms/",
  "/liquidity/",
  "/methodology/",
  "/portfolio/",
  "/screener/",
  "/stablecoins/",
  "/stability-index/",
  "/timeline/",
]);
const NON_STUDY_CONTENT_FILES = new Set([
  "client-index.ts",
  "event-window-resolver.ts",
  "index.ts",
  "types.ts",
]);

const TRACKED_COIN_IDS = new Set(
  readdirSync(COINS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, "")),
);

const CEMETERY_IDS = new Set(
  (JSON.parse(readFileSync(CEMETERY_PATH, "utf8")).rows as { id: string }[]).map(
    (r) => r.id,
  ),
);

const VALID_ARCHETYPES = new Set<string>(MECHANISM_ARCHETYPE_VALUES);
const VALID_OUTCOMES = new Set(["survived", "wounded", "died"]);
const CONTENT_MODULE_SLUGS = readdirSync(CONTENT_DIR)
  .filter((file) => file.endsWith(".ts") && !NON_STUDY_CONTENT_FILES.has(file))
  .map((file) => file.replace(/\.ts$/, ""));

const CASE_STUDY_SLUGS = new Set(CONTENT_MODULE_SLUGS);

function isSafeSlugPart(part: string): boolean {
  return part.length > 0 && [...part].every((char) =>
    (char >= "a" && char <= "z") || (char >= "0" && char <= "9")
  );
}

function isDatePart(part: string, length: number): boolean {
  return part.length === length && [...part].every((char) => char >= "0" && char <= "9");
}

function isDepegEventSlug(slug: string): boolean {
  const parts = slug.split("-");
  const direction = parts.at(-1);
  const hasDirection = direction === "up" || direction === "down";
  const dateEnd = hasDirection ? parts.length - 1 : parts.length;
  if (dateEnd < 4) return false;
  const [year, month, day] = parts.slice(dateEnd - 3, dateEnd);
  if (!year || !month || !day) return false;
  if (!isDatePart(year, 4) || !isDatePart(month, 2) || !isDatePart(day, 2)) return false;
  return parts.slice(0, dateEnd - 3).every(isSafeSlugPart);
}

function eventWindowProjection(study: CaseStudy) {
  return {
    slug: study.slug,
    primaryCoinId: study.primaryCoinId ?? null,
    relatedCoinIds: (study.relatedCoins ?? []).map((coin) => coin.coinId),
    startISO: study.eventWindow.startISO,
    endISO: study.eventWindow.endISO ?? null,
  };
}

function stripFragment(href: string): string {
  return href.split("#", 1)[0];
}

function isKnownInternalRoute(href: string): boolean {
  const path = stripFragment(href);
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  if (KNOWN_INTERNAL_ROUTES.has(path)) return true;
  if (/^\/stablecoin\/[^/]+\/$/.test(path)) {
    return TRACKED_COIN_IDS.has(path.split("/")[2]);
  }
  if (/^\/learn\/mechanisms\/[^/]+\/$/.test(path)) {
    return VALID_ARCHETYPES.has(path.split("/")[3]);
  }
  if (/^\/learn\/case-studies\/[^/]+\/$/.test(path)) {
    return CASE_STUDY_SLUGS.has(path.split("/")[3]);
  }
  if (/^\/depeg\/[^/]+\/$/.test(path)) {
    return isDepegEventSlug(path.split("/")[2] ?? "");
  }
  return false;
}

describe("case-study content", () => {
  it("derives the shared outcome totals from the canonical registry", () => {
    expect(Object.values(CASE_STUDY_OUTCOME_COUNTS).reduce((sum, count) => sum + count, 0)).toBe(CASE_STUDY_LIST.length);
    for (const outcome of VALID_OUTCOMES) {
      expect(CASE_STUDY_OUTCOME_COUNTS[outcome as keyof typeof CASE_STUDY_OUTCOME_COUNTS]).toBe(
        CASE_STUDY_LIST.filter((study) => study.outcome === outcome).length,
      );
    }
  });

  it("ships one study per content module with unique slugs", () => {
    expect(CASE_STUDY_LIST).toHaveLength(CONTENT_MODULE_SLUGS.length);
    expect(new Set(CASE_STUDY_LIST.map((study) => study.slug)).size).toBe(CASE_STUDY_LIST.length);
  });

  it("keys CASE_STUDIES by slug", () => {
    for (const study of CASE_STUDY_LIST) {
      expect(CASE_STUDIES[study.slug]).toBe(study);
    }
  });

  it("keeps reverse lookup keys unique", () => {
    const primaryCoinIds = CASE_STUDY_LIST.map((study) => study.primaryCoinId).filter(Boolean);
    const cemeteryIds = CASE_STUDY_LIST.map((study) => study.cemeteryId).filter(Boolean);
    const depegEventSlugs = CASE_STUDY_LIST.map((study) => study.depegEventSlug).filter(Boolean);

    expect(new Set(primaryCoinIds).size).toBe(primaryCoinIds.length);
    expect(new Set(cemeteryIds).size).toBe(cemeteryIds.length);
    expect(new Set(depegEventSlugs).size).toBe(depegEventSlugs.length);
  });

  it("keeps content filenames aligned with slugs", () => {
    expect([...CASE_STUDY_LIST.map((study) => study.slug)].sort()).toEqual(
      [...CONTENT_MODULE_SLUGS].sort(),
    );
  });

  it("keeps the client-safe coin lookup in sync without importing article bodies", () => {
    const expected = Object.fromEntries(
      CASE_STUDY_LIST
        .filter((study) => study.primaryCoinId)
        .map((study) => [
          study.primaryCoinId!,
          { slug: study.slug, title: study.title, outcome: study.outcome },
        ]),
    );

    expect(CASE_STUDY_CLIENT_BY_COIN_ID).toEqual(expected);
  });

  it("keeps the client-safe cemetery lookup in sync without importing article bodies", () => {
    const expected = Object.fromEntries(
      CASE_STUDY_LIST
        .filter((study) => study.cemeteryId)
        .map((study) => [
          study.cemeteryId!,
          { slug: study.slug, title: study.title, outcome: study.outcome },
        ]),
    );

    expect(CASE_STUDY_CLIENT_BY_CEMETERY_ID).toEqual(expected);
  });

  it("keeps the client-safe event-window index in sync without importing article bodies", () => {
    expect(CASE_STUDY_EVENT_WINDOWS).toEqual(CASE_STUDY_LIST.map(eventWindowProjection));
  });

  describe.each(CASE_STUDY_LIST)("$slug", (study) => {
    it("uses a valid archetype and outcome", () => {
      expect(VALID_ARCHETYPES.has(study.archetype)).toBe(true);
      expect(VALID_OUTCOMES.has(study.outcome)).toBe(true);
    });

    it("anchors to a tracked coin or a cemetery entry", () => {
      expect(Boolean(study.primaryCoinId) || Boolean(study.cemeteryId)).toBe(true);
    });

    it("references only tracked coins", () => {
      const coinIds = [
        study.primaryCoinId,
        ...(study.relatedCoins ?? []).map((c) => c.coinId),
        ...(study.dataWidgets ?? []).map((w) => w.coinId),
      ].filter((id): id is string => Boolean(id));
      for (const id of coinIds) {
        expect(TRACKED_COIN_IDS.has(id), `unknown coin id: ${id}`).toBe(true);
      }
    });

    it("references a real cemetery entry when set", () => {
      if (study.cemeteryId) {
        expect(CEMETERY_IDS.has(study.cemeteryId), `unknown cemetery id: ${study.cemeteryId}`).toBe(
          true,
        );
      }
    });

    it("has timeline, sections, watchpoints, and sources", () => {
      expect(study.eyebrow.trim()).not.toBe("");
      expect(study.title.trim()).not.toBe("");
      expect(study.subtitle.trim()).not.toBe("");
      expect(study.eventDateLabel.trim()).not.toBe("");
      expect(study.metaDescription.trim()).not.toBe("");
      expect(study.lead.length).toBeGreaterThan(0);
      expect(study.timeline.length).toBeGreaterThan(0);
      expect(study.sections.length).toBeGreaterThan(0);
      expect(study.watchpoints.length).toBeGreaterThan(0);
      expect(study.sources.length).toBeGreaterThan(0);
    });

    it("uses parseable chronological timeline and event-window dates", () => {
      const windowStart = Date.parse(study.eventWindow.startISO);
      const windowEnd = study.eventWindow.endISO ? Date.parse(study.eventWindow.endISO) : windowStart;
      expect(Number.isFinite(windowStart), `invalid eventWindow.startISO: ${study.eventWindow.startISO}`).toBe(true);
      expect(Number.isFinite(windowEnd), `invalid eventWindow.endISO: ${study.eventWindow.endISO}`).toBe(true);
      expect(windowEnd).toBeGreaterThanOrEqual(windowStart);

      let previous = Number.NEGATIVE_INFINITY;
      for (const entry of study.timeline) {
        const next = Date.parse(entry.dateISO);
        expect(Number.isFinite(next), `invalid timeline date: ${entry.dateISO}`).toBe(true);
        expect(next, `timeline out of order at ${entry.dateISO}`).toBeGreaterThanOrEqual(previous);
        previous = next;
      }

      const highSeverityAfterWindow = study.timeline
        .filter((entry) => (entry.severity ?? "low") === "high")
        .filter((entry) => Date.parse(entry.dateISO) > windowEnd)
        .map((entry) => `${entry.dateISO} ${entry.headline}`);
      expect(
        highSeverityAfterWindow,
        `high-severity timeline entries after eventWindow.endISO in ${study.slug}`,
      ).toEqual([]);
    });

    it("uses parseable publication dates that are not in the future", () => {
      const published = Date.parse(study.datePublished);
      expect(Number.isFinite(published), `invalid datePublished: ${study.datePublished}`).toBe(true);
      expect(published).toBeLessThanOrEqual(Date.now());
    });

    it("keeps the meta description within 160 chars", () => {
      expect(study.metaDescription.length).toBeLessThanOrEqual(160);
    });

    it("links to its mechanism explainer", () => {
      expect(study.crossLinks.some((l) => l.href === `/learn/mechanisms/${study.archetype}/`)).toBe(
        true,
      );
    });

    it("uses valid internal cross-links", () => {
      for (const link of study.crossLinks) {
        expect(isKnownInternalRoute(link.href), `unknown internal route: ${link.href}`).toBe(true);
      }
    });

    it("uses sane deviation metadata when provided", () => {
      if (study.eventWindow.lowPrice !== undefined) {
        expect(study.eventWindow.lowPrice, `implausible lowPrice: ${study.eventWindow.lowPrice}`).toBeGreaterThan(0.05);
        expect(study.eventWindow.lowPrice, `implausible lowPrice: ${study.eventWindow.lowPrice}`).toBeLessThanOrEqual(2);
      }
      if (study.eventWindow.peakDeviationBps !== undefined) {
        expect(
          Math.abs(study.eventWindow.peakDeviationBps),
          `implausible peakDeviationBps: ${study.eventWindow.peakDeviationBps}`,
        ).toBeLessThanOrEqual(10_000);
      }
    });

    it("keeps data widgets attached to the subject or related coins", () => {
      const allowedWidgetCoinIds = new Set([
        study.primaryCoinId,
        ...(study.relatedCoins ?? []).map((coin) => coin.coinId),
      ].filter(Boolean));
      for (const widget of study.dataWidgets ?? []) {
        expect(
          allowedWidgetCoinIds.has(widget.coinId),
          `dataWidget coinId is not attached to ${study.slug}: ${widget.coinId}`,
        ).toBe(true);
      }
    });

    it("uses a route-compatible depeg event slug when set", () => {
      if (study.depegEventSlug) {
        expect(isDepegEventSlug(study.depegEventSlug)).toBe(true);
      }
    });
  });
});

describe("caseStudySlugForEvent", () => {
  it("maps a subject coin's in-window event to its study", () => {
    expect(caseStudySlugForEvent("usdc-circle", Date.UTC(2023, 2, 11))).toBe("usdc-svb-2023");
    expect(caseStudySlugForEvent("dai-makerdao", Date.UTC(2020, 2, 12))).toBe("dai-black-thursday");
    expect(caseStudySlugForEvent("crvusd-curve", Date.UTC(2024, 5, 12))).toBe(
      "crvusd-exploit-trilogy",
    );
  });

  it("maps a contagion (relatedCoins) event to the study", () => {
    expect(caseStudySlugForEvent("usdt-tether", Date.UTC(2022, 4, 12))).toBe("terra-ust-2022");
  });

  it("prefers the subject study over a contagion match on the same date", () => {
    // 2023-03-11 is in both usdc-svb (subject usdc-circle) and dai's dual-era window
    // (usdc-circle is in dai's relatedCoins). The subject study wins.
    expect(caseStudySlugForEvent("usdc-circle", Date.UTC(2023, 2, 11))).toBe("usdc-svb-2023");
  });

  it("returns undefined for events outside any study window", () => {
    expect(caseStudySlugForEvent("usdt-tether", Date.UTC(2018, 9, 15))).toBeUndefined();
    expect(caseStudySlugForEvent("usdc-circle", Date.UTC(2024, 5, 30))).toBeUndefined();
  });

  it("matches the generated client-safe resolver", () => {
    for (const study of CASE_STUDY_LIST) {
      const ts = Date.parse(study.eventWindow.startISO);
      if (study.primaryCoinId) {
        expect(clientCaseStudySlugForEvent(study.primaryCoinId, ts)).toBe(
          caseStudySlugForEvent(study.primaryCoinId, ts),
        );
      }
      for (const related of study.relatedCoins ?? []) {
        expect(clientCaseStudySlugForEvent(related.coinId, ts)).toBe(
          caseStudySlugForEvent(related.coinId, ts),
        );
      }
    }
  });

  it("selects the closest overlapping related window independent of registry order", () => {
    const ts = Date.UTC(2026, 0, 15);
    const windows = [
      {
        slug: "wide-window",
        primaryCoinId: null,
        relatedCoinIds: ["test-coin"],
        startISO: "2026-01-01",
        endISO: "2026-01-31",
      },
      {
        slug: "near-window",
        primaryCoinId: null,
        relatedCoinIds: ["test-coin"],
        startISO: "2026-01-14",
        endISO: "2026-01-16",
      },
    ];

    expect(resolveCaseStudySlugForEventFromWindows(windows, "test-coin", ts)).toBe("near-window");
    expect(resolveCaseStudySlugForEventFromWindows([...windows].reverse(), "test-coin", ts)).toBe("near-window");
  });
});

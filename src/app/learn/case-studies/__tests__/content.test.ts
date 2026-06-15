import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import {
  CASE_STUDY_LIST,
  CASE_STUDIES,
  caseStudySlugForEvent,
} from "../content";
import {
  CASE_STUDY_CLIENT_BY_CEMETERY_ID,
  CASE_STUDY_CLIENT_BY_COIN_ID,
} from "../content/client-index";

const COINS_DIR = join(process.cwd(), "shared/data/stablecoins/coins");
const CEMETERY_PATH = join(process.cwd(), "public/datasets/stablecoin-cemetery.json");

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

describe("case-study content", () => {
  it("ships twenty-four studies with unique slugs", () => {
    expect(CASE_STUDY_LIST).toHaveLength(24);
    expect(new Set(CASE_STUDY_LIST.map((study) => study.slug)).size).toBe(CASE_STUDY_LIST.length);
  });

  it("keys CASE_STUDIES by slug", () => {
    for (const study of CASE_STUDY_LIST) {
      expect(CASE_STUDIES[study.slug]).toBe(study);
    }
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
      expect(study.timeline.length).toBeGreaterThan(0);
      expect(study.sections.length).toBeGreaterThan(0);
      expect(study.watchpoints.length).toBeGreaterThan(0);
      expect(study.sources.length).toBeGreaterThan(0);
    });

    it("keeps the meta description within 160 chars", () => {
      expect(study.metaDescription.length).toBeLessThanOrEqual(160);
    });

    it("links to its mechanism explainer", () => {
      const hasMechanismLink = study.crossLinks.some((l) =>
        l.href.startsWith("/learn/mechanisms/"),
      );
      expect(hasMechanismLink).toBe(true);
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
});

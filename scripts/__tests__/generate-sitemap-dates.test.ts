import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPerCoinStablecoinEntries } from "../lib/stablecoin-catalog-sources";
import { collectStablecoinDetailDates } from "../lib/sitemap-detail-dates";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const FLOOR_DATE = "2026-01-01T00:00:00.000Z";
const SIDECAR_EDIT_DATE = "2026-09-21T00:00:00.000Z";
const RESERVES_SIDECAR_PREFIX = "shared/data/stablecoins/domains/reserves/";

const entries = loadPerCoinStablecoinEntries(REPO_ROOT);

const reservesSidecars = new Set(
  entries.flatMap((entry) => (entry.sidecarFiles ?? []).filter((file) => file.startsWith(RESERVES_SIDECAR_PREFIX))),
);

describe("stablecoin detail sitemap dates", () => {
  it("advances exactly the pages whose reserves sidecar is the newest source", () => {
    const edited = new Set([...reservesSidecars].map((file) => join(REPO_ROOT, file)));
    const dates = collectStablecoinDetailDates(
      entries,
      (absolutePath) => (edited.has(absolutePath) ? SIDECAR_EDIT_DATE : FLOOR_DATE),
      FLOOR_DATE,
      REPO_ROOT,
    );

    const advanced = entries.filter((entry) => dates[`/stablecoin/${entry.id}/`] === SIDECAR_EDIT_DATE);
    expect(advanced.map((entry) => entry.id)).toEqual(
      entries
        .filter((entry) => (entry.sidecarFiles ?? []).some((file) => reservesSidecars.has(file)))
        .map((entry) => entry.id),
    );
    expect(advanced.length).toBeGreaterThan(0);
    expect(advanced.length).toBeLessThan(entries.length);
  });

  it("keeps one page per catalog coin, floored by the shared detail-page sources", () => {
    const dates = collectStablecoinDetailDates(entries, () => FLOOR_DATE, SIDECAR_EDIT_DATE, REPO_ROOT);

    expect(Object.keys(dates).sort()).toEqual(entries.map((entry) => `/stablecoin/${entry.id}/`).sort());
    expect(new Set(Object.values(dates))).toEqual(new Set([SIDECAR_EDIT_DATE]));
  });
});

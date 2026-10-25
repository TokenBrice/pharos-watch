import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockRegistry } from "../../../test-helpers/cron/index";

const mockGetCache = vi.fn();
const mockSetCache = vi.fn();
const TRACKED_STABLECOINS_MOCK = [
  {
    id: "usdt-tether",
    symbol: "USDT",
    name: "Tether",
    status: "active",
    flags: { yieldBearing: false },
  },
  {
    id: "usdx-example",
    symbol: "USDX",
    name: "Example USD",
    status: "active",
    flags: { yieldBearing: false },
  },
  {
    id: "eurx-example",
    symbol: "EURX",
    name: "Example Euro",
    status: "pre-launch",
    // Entering the launched phase keeps the row pre-launch: no launch announcement yet.
    launchPhase: "launched",
    flags: { yieldBearing: false },
  },
];

vi.mock("@shared/lib/dead-stablecoins", () => ({
  DEAD_STABLECOINS: [
    {
      id: "pusd-palm-usd-2026-01",
      name: "Palm USD",
      symbol: "PUSD",
      llamaId: "315",
      pegCurrency: "USD",
      causeOfDeath: "liquidity-drain",
      deathDate: "2026-01",
      peakMcap: 26_000_000,
      epitaph: "$2.8B promised. $81K left",
      obituary: "Palm USD obituary",
      sourceUrl: "https://example.com/pusd",
      sourceLabel: "Example",
    },
    {
      id: "eura-angle-eura-2026-03",
      name: "Angle EURA",
      symbol: "EURA",
      pegCurrency: "EUR",
      causeOfDeath: "abandoned",
      deathDate: "2026-03",
      peakMcap: 200_000_000,
      epitaph: "DeFi's first Euro, last out",
      obituary: "Angle EURA obituary",
      sourceUrl: "https://example.com/eura",
      sourceLabel: "Example",
    },
    {
      id: "usda-angle-usda-2026-03",
      name: "Angle USDA",
      symbol: "USDA",
      pegCurrency: "USD",
      causeOfDeath: "abandoned",
      deathDate: "2026-03",
      epitaph: "Late arrival, early exit",
      obituary: "Angle USDA obituary",
      sourceUrl: "https://example.com/usda",
      sourceLabel: "Example",
    },
  ],
}));

const FROZEN_STABLECOINS_MOCK = [
  {
    id: "dusd-fluid",
    symbol: "DUSD",
    name: "Fluid Dollar",
    status: "frozen",
    flags: { yieldBearing: false },
    obituary: { epitaph: "Bankruptcy closed the rail \u2014 redemptions halted; holders stranded" },
  },
];

vi.mock("@shared/lib/stablecoins/registry", () => mockRegistry({ stablecoins: TRACKED_STABLECOINS_MOCK, frozenStablecoins: FROZEN_STABLECOINS_MOCK }));

vi.mock("../../../lib/db-cache", () => ({
  getCache: mockGetCache,
  setCache: mockSetCache,
}));

const {
  diffFrozenIds,
  prepareTelegramDigestAppendices,
  CEMETERY_FOOTERS,
  queuePendingTrackedStablecoinAdditions,
} = await import("../digest-appendices");
const { scanTelegramDigestWrapper } = await import("../../../cron/digest/wrapper-style-gate");

function mockCachedValues(values: Record<string, string>): void {
  mockGetCache.mockImplementation(async (_db: unknown, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? { value: values[key], updatedAt: 1_778_500_000 } : null,
  );
}

describe("prepareTelegramDigestAppendices", () => {
  beforeEach(() => {
    mockGetCache.mockReset();
    mockSetCache.mockReset();
    mockSetCache.mockResolvedValue(undefined);
  });

  it("silently seeds cemetery and tracked snapshots on first run", async () => {
    mockGetCache.mockResolvedValue(null);

    const prepared = await prepareTelegramDigestAppendices({} as D1Database);

    expect(prepared.appendixHtml).toBeNull();
    expect(prepared.metadata).toMatchObject({
      hasAppendix: false,
      seededSnapshots: ["cemetery:first-run", "launched:first-run", "tracked:first-run", "frozen:first-run"],
    });
    expect(mockSetCache).toHaveBeenCalledTimes(4);
    expect(mockSetCache.mock.calls[0]).toEqual([
      {},
      "telegram:cemetery-snapshot",
      JSON.stringify([
        "pusd-palm-usd-2026-01",
        "eura-angle-eura-2026-03",
        "usda-angle-usda-2026-03",
      ]),
    ]);
    expect(mockSetCache.mock.calls[1]).toEqual([
      {},
      "telegram:prelaunch-stablecoins-snapshot",
      JSON.stringify(["eurx-example"]),
    ]);
    expect(mockSetCache.mock.calls[2]).toEqual([
      {},
      "telegram:tracked-stablecoins-snapshot",
      JSON.stringify(["usdt-tether", "usdx-example", "eurx-example"]),
    ]);
    expect(mockSetCache.mock.calls[3]).toEqual([
      {},
      "frozen_ids_snapshot",
      JSON.stringify(["dusd-fluid"]),
    ]);

    expect(prepared.successActions).toEqual([]);
  });

  it("queues newly tracked active coins from the previous stablecoins cache baseline", async () => {
    mockCachedValues({
      "telegram:tracked-stablecoins-pending": JSON.stringify(["usdt-tether"]),
    });

    const result = await queuePendingTrackedStablecoinAdditions(
      {} as D1Database,
      ["usdt-tether"],
      ["usdt-tether", "usdx-example"],
    );

    expect(result).toEqual({
      queuedIds: ["usdx-example"],
      totalPending: 2,
      baselineMissing: false,
    });
    expect(mockSetCache).toHaveBeenCalledTimes(1);
    expect(mockSetCache.mock.calls[0]).toEqual([
      {},
      "telegram:tracked-stablecoins-pending",
      JSON.stringify(["usdt-tether", "usdx-example"]),
    ]);
  });

  it("uses queued tracked additions when the tracked snapshot is missing", async () => {
    mockCachedValues({
      "telegram:cemetery-snapshot": JSON.stringify([
        "pusd-palm-usd-2026-01",
        "eura-angle-eura-2026-03",
        "usda-angle-usda-2026-03",
      ]),
      "telegram:tracked-stablecoins-pending": JSON.stringify(["usdx-example"]),
      "telegram:prelaunch-stablecoins-snapshot": JSON.stringify(["eurx-example"]),
    });

    const prepared = await prepareTelegramDigestAppendices({} as D1Database);

    expect(prepared.metadata).toMatchObject({
      hasAppendix: true,
      trackedDetected: 1,
      preLaunchDetected: 0,
      trackedSymbols: ["USDX"],
      seededSnapshots: ["tracked:first-run", "frozen:first-run"],
    });
    expect(prepared.appendixHtml).toContain("<b>Tracking Changes</b>");
    expect(prepared.appendixHtml).toContain("<blockquote expandable><code>USDX</code> Example USD</blockquote>");
    expect(prepared.appendixHtml).toContain("<code>USDX</code> Example USD");

    expect(mockSetCache).toHaveBeenCalledTimes(1);
    expect(mockSetCache.mock.calls[0]).toEqual([
      {},
      "frozen_ids_snapshot",
      JSON.stringify(["dusd-fluid"]),
    ]);

    expect(prepared.successActions).toEqual([
      {
        key: "telegram:tracked-stablecoins-snapshot",
        value: JSON.stringify(["usdt-tether", "usdx-example", "eurx-example"]),
      },
      { key: "telegram:tracked-stablecoins-pending", value: "[]" },
    ]);
  });

  it("merges a queued tracked addition even when the tracked snapshot already contains it", async () => {
    mockCachedValues({
      "telegram:cemetery-snapshot": JSON.stringify([
        "pusd-palm-usd-2026-01",
        "eura-angle-eura-2026-03",
        "usda-angle-usda-2026-03",
      ]),
      "telegram:tracked-stablecoins-snapshot": JSON.stringify(["usdt-tether", "usdx-example", "eurx-example"]),
      "telegram:tracked-stablecoins-pending": JSON.stringify(["usdx-example"]),
      "frozen_ids_snapshot": JSON.stringify(["dusd-fluid"]),
      "telegram:prelaunch-stablecoins-snapshot": JSON.stringify(["eurx-example"]),
    });

    const prepared = await prepareTelegramDigestAppendices({} as D1Database);

    expect(prepared.metadata).toMatchObject({
      trackedDetected: 1,
      trackedSymbols: ["USDX"],
    });
    expect(prepared.appendixHtml).toContain("<code>USDX</code> Example USD");
    expect(mockSetCache).not.toHaveBeenCalled();
    expect(prepared.successActions).toEqual([
      {
        key: "telegram:tracked-stablecoins-snapshot",
        value: JSON.stringify(["usdt-tether", "usdx-example", "eurx-example"]),
      },
      { key: "telegram:tracked-stablecoins-pending", value: "[]" },
    ]);
  });

  it("builds cemetery and tracking appendices with exact deferred snapshot actions", async () => {
    mockCachedValues({
      "telegram:cemetery-snapshot": JSON.stringify(["llama:315"]),
      "telegram:cemetery-footer-index": "8",
      "telegram:tracked-stablecoins-snapshot": JSON.stringify(["usdt-tether"]),
      "telegram:tracked-stablecoins-pending": JSON.stringify(["usdx-example"]),
      "telegram:prelaunch-stablecoins-snapshot": JSON.stringify(["eurx-example"]),
    });

    const prepared = await prepareTelegramDigestAppendices({} as D1Database);

    expect(prepared.metadata).toMatchObject({
      hasAppendix: true,
      cemeteryDetected: 2,
      trackedDetected: 1,
      preLaunchDetected: 1,
      cemeterySymbols: ["EURA", "USDA"],
      trackedSymbols: ["USDX"],
      preLaunchSymbols: ["EURX"],
    });
    expect(prepared.appendixHtml).toContain("<b>New Cemetery Entries</b>");
    expect(prepared.appendixHtml).toContain("<blockquote expandable><code>EURA</code> Angle EURA");
    expect(prepared.appendixHtml).toContain("<code>EURA</code> Angle EURA (2026-03; Abandoned)");
    expect(prepared.appendixHtml).toContain("<i>DeFi&#39;s first Euro, last out</i>");
    expect(prepared.appendixHtml).toContain("Peak mcap: $200.00M");
    expect(prepared.appendixHtml).toContain(CEMETERY_FOOTERS[8]);
    expect(prepared.appendixHtml).toContain("<b>Tracking Changes</b>");
    expect(prepared.appendixHtml).toContain("Newly tracked stablecoins:");
    expect(prepared.appendixHtml).toContain("<code>USDX</code> Example USD");
    expect(prepared.appendixHtml).toContain("Newly tracked pre-launch stablecoins:");
    expect(prepared.appendixHtml).toContain("<code>EURX</code> Example Euro");

    expect(mockSetCache).toHaveBeenCalledTimes(1);
    expect(mockSetCache.mock.calls[0]).toEqual([
      {},
      "frozen_ids_snapshot",
      JSON.stringify(["dusd-fluid"]),
    ]);

    expect(prepared.successActions).toEqual([
      {
        key: "telegram:cemetery-snapshot",
        value: JSON.stringify([
          "pusd-palm-usd-2026-01",
          "eura-angle-eura-2026-03",
          "usda-angle-usda-2026-03",
        ]),
      },
      { key: "telegram:cemetery-footer-index", value: "9" },
      {
        key: "telegram:tracked-stablecoins-snapshot",
        value: JSON.stringify(["usdt-tether", "usdx-example", "eurx-example"]),
      },
      { key: "telegram:tracked-stablecoins-pending", value: "[]" },
    ]);
  });

  it("treats old fallback cemetery snapshot keys as already seen and rewrites them to stable ids", async () => {
    mockCachedValues({
      "telegram:cemetery-snapshot": JSON.stringify([
        "PUSD|2026-01|palm usd",
        "EURA|2026-03|angle eura",
        "USDA|2026-03|angle usda",
      ]),
      "telegram:tracked-stablecoins-snapshot": JSON.stringify(["usdt-tether", "usdx-example", "eurx-example"]),
      "telegram:prelaunch-stablecoins-snapshot": JSON.stringify(["eurx-example"]),
    });

    const prepared = await prepareTelegramDigestAppendices({} as D1Database);

    expect(prepared.appendixHtml).toBeNull();
    expect(prepared.metadata).toMatchObject({
      hasAppendix: false,
      cemeteryDetected: 0,
    });
    expect(mockSetCache).toHaveBeenCalledTimes(2);
    expect(mockSetCache.mock.calls[0]).toEqual([
      {},
      "telegram:cemetery-snapshot",
      JSON.stringify([
        "pusd-palm-usd-2026-01",
        "eura-angle-eura-2026-03",
        "usda-angle-usda-2026-03",
      ]),
    ]);
    expect(mockSetCache.mock.calls[1]).toEqual([
      {},
      "frozen_ids_snapshot",
      JSON.stringify(["dusd-fluid"]),
    ]);
  });

  it("renders a newly frozen coin so the appendix passes the delivery-wrapper style gate", async () => {
    mockCachedValues({
      "telegram:cemetery-snapshot": JSON.stringify([
        "pusd-palm-usd-2026-01",
        "eura-angle-eura-2026-03",
        "usda-angle-usda-2026-03",
      ]),
      "telegram:tracked-stablecoins-snapshot": JSON.stringify(["usdt-tether", "usdx-example", "eurx-example"]),
      "frozen_ids_snapshot": JSON.stringify([]),
      "telegram:prelaunch-stablecoins-snapshot": JSON.stringify(["eurx-example"]),
    });

    const prepared = await prepareTelegramDigestAppendices({} as D1Database);

    expect(prepared.metadata).toMatchObject({ hasAppendix: true, frozenDetected: 1, frozenSymbols: ["DUSD"] });
    expect(prepared.appendixHtml).toContain("<code>DUSD</code> Fluid Dollar: <i>Bankruptcy closed the rail, redemptions halted; holders stranded</i>");
    expect(
      scanTelegramDigestWrapper({
        rendered: `Title\n\nBody\n\n${prepared.appendixHtml}`,
        modelTitle: "Title",
        modelExtended: "Body",
        cemeteryAppendixHtml: null,
      }),
    ).toEqual([]);

    expect(mockSetCache).not.toHaveBeenCalled();
    expect(prepared.successActions).toEqual([
      { key: "frozen_ids_snapshot", value: JSON.stringify(["dusd-fluid"]) },
    ]);
  });

  it("stays silent while a pre-launch row sits in the launched phase; only promotion to active announces", async () => {
    mockCachedValues({
      "telegram:cemetery-snapshot": JSON.stringify([
        "pusd-palm-usd-2026-01",
        "eura-angle-eura-2026-03",
        "usda-angle-usda-2026-03",
      ]),
      "telegram:tracked-stablecoins-snapshot": JSON.stringify(["usdt-tether", "usdx-example", "eurx-example"]),
      "frozen_ids_snapshot": JSON.stringify(["dusd-fluid"]),
      "telegram:prelaunch-stablecoins-snapshot": JSON.stringify(["eurx-example"]),
    });

    const prepared = await prepareTelegramDigestAppendices({} as D1Database);

    expect(prepared.metadata).toMatchObject({ hasAppendix: false, launchedDetected: 0 });
    expect(prepared.appendixHtml).toBeNull();
    expect(prepared.successActions).toEqual([]);
  });

  it("announces a pre-launch to active promotion once, as a launch rather than a tracked addition", async () => {
    mockCachedValues({
      "telegram:cemetery-snapshot": JSON.stringify([
        "pusd-palm-usd-2026-01",
        "eura-angle-eura-2026-03",
        "usda-angle-usda-2026-03",
      ]),
      "telegram:tracked-stablecoins-snapshot": JSON.stringify(["usdt-tether", "usdx-example", "eurx-example"]),
      // sync-stablecoins queued the promoted coin when it first appeared in live data.
      "telegram:tracked-stablecoins-pending": JSON.stringify(["usdx-example"]),
      "frozen_ids_snapshot": JSON.stringify(["dusd-fluid"]),
      "telegram:prelaunch-stablecoins-snapshot": JSON.stringify(["usdx-example", "eurx-example"]),
    });

    const prepared = await prepareTelegramDigestAppendices({} as D1Database);

    expect(prepared.metadata).toMatchObject({
      hasAppendix: true,
      launchedDetected: 1,
      launchedSymbols: ["USDX"],
      trackedDetected: 0,
    });
    expect(prepared.appendixHtml).toBe(
      "<b>Launched</b>\n\nNow live after pre-launch:\n\n<blockquote expandable><code>USDX</code> Example USD</blockquote>",
    );
    expect(mockSetCache).not.toHaveBeenCalled();
    expect(prepared.successActions).toEqual([
      { key: "telegram:prelaunch-stablecoins-snapshot", value: JSON.stringify(["eurx-example"]) },
      { key: "telegram:tracked-stablecoins-pending", value: "[]" },
    ]);
  });
});

describe("diffFrozenIds", () => {
  it.each([
    { name: "returns an empty set when nothing changed", current: ["usr-resolv"], previous: ["usr-resolv"] },
    { name: "ignores removals (un-freezing is out of scope)", current: [], previous: ["usr-resolv"] },
  ])("$name", ({ current, previous }) => {
    expect(diffFrozenIds(new Set(current), new Set(previous))).toEqual(new Set());
  });
});

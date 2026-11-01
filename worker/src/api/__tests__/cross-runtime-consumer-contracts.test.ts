import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { ApiMetaEnvelopeSchema } from "@pharos/contracts/api-meta";
import { BluechipRatingsMapSchema } from "@shared/types/bluechip";
import { ChainsResponseSchema } from "@shared/types/chains";
import { StablecoinListResponseSchema } from "@shared/types/market";
import { ReportCardsV9AcceptedResponseSchema, ReportCardsV9ReaderResponseSchema } from "@shared/types/report-cards-v9-accepted";
import { handleBluechipRatings, handleStablecoins } from "../cache-handlers";
import { handleChains } from "../chains";
import { handleReportCardsV9 } from "../report-cards-v9";
import { validateAndWriteStablecoinsCache } from "../../cron/sync-stablecoins/cache-publication";
import { makePeggedAsset } from "../../cron/sync-stablecoins/__tests__/_fixtures";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import {
  makeWorkerReportCardsV9Response,
  makeWorkerSafetyScoreV9Publication,
  makeWorkerV9Card,
} from "../../test-helpers/report-cards-v9";
import { currentInput, persistAndMaterialize } from "../../lib/__tests__/safety-score-v9-publication-store.test-support";
import * as activeSafetyScoreSource from "../../lib/safety-score-index";

/**
 * Producer-side cross-runtime contracts.
 *
 * The consumers that read these payloads from another isolate — the Pages
 * Functions selector snapshot (`functions/lib/selector-canonical-snapshot.ts`)
 * and the Pharosville reader (`shared/lib/pharosville-api-contract.ts`) — fail
 * closed on a schema violation, so a field or enum the producer adds looks like
 * a whole-route outage to them. Each case builds the body through the real
 * Worker producer and parses it with the consumer's exact exported schema.
 */
const SEC = 1_700_000_000;
const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  fixtures.closeAll();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Report the consumer's own issues so a drifted producer field names itself. */
function expectParses(
  schema: { safeParse: (value: unknown) => { success: boolean; error?: { issues: unknown[] } } },
  value: unknown,
  consumer: string,
): void {
  const parsed = schema.safeParse(value);
  expect(parsed.success, `${consumer}: ${parsed.success ? "" : JSON.stringify(parsed.error?.issues)}`).toBe(true);
}

describe("stablecoins publication → GET /api/stablecoins readers", () => {
  it("serves a published cohort whose body and _meta satisfy the shared reader contracts", async () => {
    const { db } = fixtures.open();
    const result = await validateAndWriteStablecoinsCache({
      assets: [makePeggedAsset({
        pegMechanism: "fiat-backed", price: 1, priceSource: "coingecko",
        circulating: { peggedUSD: 100 }, circulatingPrevDay: { peggedUSD: 90 },
        chainCirculating: { Ethereum: { chainId: "ethereum", current: 100 } }, chains: ["Ethereum"],
      })],
      db,
      syncStartSec: SEC,
      validationContext: "main",
    }, () => ({ metadata: "blocked" }));
    expect(result).toMatchObject({ written: true, quarantinedAssets: [] });

    const response = await handleStablecoins(db);
    expect(response.status).toBe(200);
    const { _meta, ...payload } = await response.json() as Record<string, unknown>;
    // Pages strips `_meta` and reads the evidence separately with ApiMetaEnvelopeSchema.
    expectParses(StablecoinListResponseSchema, payload, "frontend/Pharosville stablecoins");
    expectParses(ApiMetaEnvelopeSchema, _meta, "Pages _meta evidence");
  });
});

describe("GET /api/chains readers", () => {
  function publishedStablecoins(peggedAssets: unknown[]) {
    return {
      peggedAssets: peggedAssets.map((asset) => ({
        pegMechanism: "test-fixture",
        priceSource: "test-fixture",
        chainCirculating: {},
        chains: [],
        ...(asset as Record<string, unknown>),
      })),
    };
  }

  function asset(id: string, chainCirculating: Record<string, { current: number }>) {
    return makeAsset({
      id,
      name: id,
      symbol: id.toUpperCase(),
      circulating: { peggedUSD: Object.values(chainCirculating).reduce((sum, row) => sum + row.current, 0) },
      chainCirculating: Object.fromEntries(Object.entries(chainCirculating).map(([chain, row]) => [chain, {
        current: row.current,
        circulatingPrevDay: row.current,
        circulatingPrevWeek: row.current,
        circulatingPrevMonth: row.current,
      }])),
      chains: Object.keys(chainCirculating),
    });
  }

  it("serves the chains body the Pharosville and frontend readers parse", async () => {
    vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreIndex").mockResolvedValue({
      kind: "v9",
      snapshot: makeWorkerReportCardsV9Response({
        cards: [makeWorkerV9Card({ id: "usdt-tether", score: 90, grade: "A" })],
      }),
    });
    const db = mockD1([{
      match: "cache",
      matchBinds: ["stablecoins"],
      rows: [],
      first: {
        key: "stablecoins",
        value: JSON.stringify(publishedStablecoins([
          asset("usdt-tether", { Ethereum: { current: 500 } }),
          asset("usdc-circle", { Base: { current: 200 } }),
        ])),
        updated_at: Math.floor(Date.now() / 1000) - 60,
      },
    }]);

    const response = await handleChains(db);
    expect(response.status).toBe(200);
    const body = await response.json() as { chains: unknown[] };
    expect(body.chains.length).toBeGreaterThan(0);
    expectParses(ChainsResponseSchema, body, "Pharosville/frontend chains");
  });
});

describe("GET /api/bluechip-ratings readers", () => {
  it("serves the rating map the Pages selector snapshot parses", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const rating = {
      grade: "A",
      slug: "tether",
      lastObservedAt: nowSec - 60,
      observationState: "current",
      observationReason: null,
      collateralization: 100,
      smartContractAudit: true,
      dateOfRating: "2026-01-01",
      dateLastChange: "2026-01-01",
      smidge: {
        stability: "4", management: "4", implementation: "4",
        decentralization: "4", governance: "4", externals: "4",
      },
    };
    const db = mockD1([{
      match: "cache",
      rows: [{ key: "bluechip-ratings", value: JSON.stringify({ "usdt-tether": rating }), updated_at: nowSec - 60 }],
      first: { key: "bluechip-ratings", value: JSON.stringify({ "usdt-tether": rating }), updated_at: nowSec - 60 },
    }]);

    const response = await handleBluechipRatings(db);
    expect(response.status).toBe(200);
    const { _meta, ...payload } = await response.json() as Record<string, unknown>;
    expect(_meta).toBeDefined();
    expectParses(BluechipRatingsMapSchema, payload, "Pages/frontend bluechip ratings");
    const parsed = BluechipRatingsMapSchema.parse(payload);
    expect(parsed["usdt-tether"]?.observationState).toBe("current");
  });
});

describe("GET /api/report-cards/v9 readers", () => {
  it("serves a materialized publication the Pages and Pharosville readers accept", async () => {
    const { db } = fixtures.open();
    const publication = makeWorkerSafetyScoreV9Publication();
    await persistAndMaterialize(db, currentInput(publication));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(publication.publishedAtSec * 1000);

    const plain = await handleReportCardsV9(db);
    expect(plain.status).toBe(200);
    const legacyBody: unknown = JSON.parse(await plain.text());
    // Pages selector: ReportCardsV9ReaderResponseSchema. Pharosville: the
    // accepted union. The default route body strips the optional root
    // `pillarFreshness` metadata for older strict clients.
    expectParses(ReportCardsV9ReaderResponseSchema, legacyBody, "Pages report-cards reader");
    expectParses(ReportCardsV9AcceptedResponseSchema, legacyBody, "Pharosville report-cards reader");
    expect(legacyBody).not.toHaveProperty("pillarFreshness");

    const operands = await handleReportCardsV9(db, new URL("https://x/api/report-cards/v9?freshness=operands"));
    expect(operands.status).toBe(200);
    const operandsBody: unknown = JSON.parse(await operands.text());
    expectParses(ReportCardsV9ReaderResponseSchema, operandsBody, "Pages report-cards reader (operands)");
    expectParses(ReportCardsV9AcceptedResponseSchema, operandsBody, "Pharosville report-cards reader (operands)");
  });
});

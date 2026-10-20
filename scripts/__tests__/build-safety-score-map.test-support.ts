import { createServer } from "node:http";
import {
  makeReportCardsV9Card,
  makeReportCardsV9Response,
} from "@shared/test-utils/report-cards-v9";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";

export interface SafetyMapCardFixture {
  id: string;
  score: number | null;
  grade: string;
}

export function makeSafetyMapRatedCard(card: SafetyMapCardFixture): SafetyScoreV9CurrentCard {
  return makeReportCardsV9Card({
    id: card.id,
    score: card.score,
    grade: card.grade as SafetyScoreV9CurrentCard["grade"],
    qualityScore: card.score,
    pegMultiplier: card.score === null ? null : 1,
    pegAdjustedScore: card.score,
  });
}

export function withSafetyMapAdverseAttribution(
  ratedCard: SafetyScoreV9CurrentCard,
): SafetyScoreV9CurrentCard {
  return {
    ...ratedCard,
    scoreTrace: {
      ...ratedCard.scoreTrace,
      adverseAttribution: {
        ...ratedCard.scoreTrace.adverseAttribution,
        items: [{
          source: "pillar-score" as const,
          path: "pillar:backing:score",
          message: "Measured backing pillar score is below the C- floor.",
          responsibility: "measured-adverse" as const,
        }],
      },
    },
  };
}

export function makeSafetyMapReportCardsResponse({
  cards,
  fixtureId,
  methodologyVersion,
  defaultUpdatedAt,
  asOfSec,
}: {
  cards: SafetyScoreV9CurrentCard[];
  fixtureId: string;
  methodologyVersion: string;
  defaultUpdatedAt: number;
  asOfSec: number;
}) {
  return makeReportCardsV9Response(
    {
      safetyScoreIdentity: {
        model: "v9" as const,
        schemaVersion: 1 as const,
        methodologyVersion,
        policyId: "safety-score-v9",
        policyDigest: "a".repeat(64),
        evaluationBuildDigest: "b".repeat(64),
        baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`,
        publicationGenerationId: fixtureId,
      },
      defaultUpdatedAt,
      asOfSec,
      source: {
        candidateId: `safety-score-v9:v1:${fixtureId}`,
        factSetDigest: "c".repeat(64),
        resultDigest: "d".repeat(64),
        sourceGenerations: { reportCards: "fixture" },
      },
    },
    () => makeReportCardsV9Card(),
    { cards },
  );
}

export interface SafetyMapAssetFixture {
  id: string;
  symbol: string;
  circulating?: Record<string, number>;
}

export function makeSafetyMapStablecoinsPayload(assets: readonly SafetyMapAssetFixture[]) {
  return {
    peggedAssets: assets.map((asset) => makeStablecoin({
      id: asset.id,
      name: asset.symbol,
      symbol: asset.symbol,
      circulating: asset.circulating ?? {},
    })),
  };
}

export function makeSafetyMapPsiPayload(
  current: Record<string, unknown> | null,
  asOf = 1_777_000_000,
) {
  return {
    current: current === null
      ? null
      : {
          components: { severity: 0, breadth: 0, trend: 0 },
          methodologyVersion: "psi-v1",
          ...current,
        },
    history: [],
    methodology: {
      version: "psi-v1",
      versionLabel: "PSI v1",
      currentVersion: "psi-v1",
      currentVersionLabel: "PSI v1",
      changelogPath: "/methodology/stability-index-changelog/",
      asOf,
      isCurrent: true,
    },
  };
}

/** Serve live payload callbacks so each suite can keep its own fixture state. */
export async function startSafetyMapFixtureServer({
  reportCardsPayload,
  stablecoinsPayload,
  psiPayload,
  publicationStatus,
  stablecoinsHeaders,
}: {
  reportCardsPayload: () => unknown;
  stablecoinsPayload: () => unknown;
  psiPayload: () => unknown;
  publicationStatus: () => string;
  stablecoinsHeaders?: () => Record<string, string>;
}) {
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const body =
      path === "/api/report-cards/v9"
        ? reportCardsPayload()
        : path === "/api/stablecoins"
          ? stablecoinsPayload()
          : path === "/api/stability-index"
            ? psiPayload()
            : null;
    if (!body) {
      res.writeHead(404).end("{}");
      return;
    }
    if (path === "/api/report-cards/v9") res.setHeader("X-Safety-Score-Status", publicationStatus());
    if (path === "/api/stablecoins") {
      res.sendDate = false;
      const headers = stablecoinsHeaders?.() ?? { "X-Data-Updated-At": String(Math.floor(Date.now() / 1000) - 300) };
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (typeof address === "string" || address == null) throw new Error("fixture server did not bind a port");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

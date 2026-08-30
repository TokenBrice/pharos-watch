import type { ReactNode } from "react";
import { vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { StablecoinMeta, StablecoinObituary } from "@shared/types";

export async function createNextLinkMock() {
  const { createNextLinkMock: createLink } = await import("@/test-utils/frontend");
  return createLink();
}

export const createViewModelMock = (mock: unknown) => ({ useStablecoinDetailViewModel: mock });

export const createDepegEventsMock = () => ({ useInfiniteDepegEvents: () => ({ data: { total: 0 } }) });

export const createLogosMock = () => ({ logosById: {} });

export const createStablecoinLogoMock = () => ({ StablecoinLogo: ({ name }: { name: string }) => <span>{name}</span> });

export const createNoopComponentMock = (name: string) => ({ [name]: () => null });

export const createHeroCardMock = () => ({
  HeroCard: () => <div data-testid="hero-card" />,
  HeroDesktopIdentityToolbar: () => <div data-testid="hero-identity-toolbar" />,
});

export const createContagionSnapshotMock = () => ({
  ContagionSnapshot: ({ variantRelationshipCard }: { variantRelationshipCard?: ReactNode }) => (
    <div data-testid="contagion-snapshot-mock">{variantRelationshipCard}</div>
  ),
});

export const obituary: StablecoinObituary = {
  causeOfDeath: "abandoned",
  deathDate: "2026-04",
  epitaph: "Sunset by issuer.",
  obituary: "Wound down following protocol-level losses.",
  sourceUrl: "https://example.com/shutdown",
  sourceLabel: "Issuer announcement",
};

function makeFeatureStates() {
  return {
    liquidity: { status: "empty", dataUpdatedAt: 0, error: null },
    yield: { status: "unsupported", dataUpdatedAt: 0, error: null },
    stress: { status: "empty", dataUpdatedAt: 0, error: null },
    flows: { status: "unsupported", dataUpdatedAt: 0, error: null },
    blacklist: { status: "unsupported", dataUpdatedAt: 0, error: null },
    reserves: { status: "empty", dataUpdatedAt: 0, error: null },
  };
}

function makeViewModelBase(coin: StablecoinMeta) {
  return {
    status: "ready" as const,
    id: coin.id,
    coin,
    summary: null, logoSrc: undefined, reportCard: null, reportCardsResponse: undefined, reportCardUpdatedAt: null,
    variantParent: null, variantSiblings: [],
    coinData: {
      id: coin.id, name: coin.name, symbol: coin.symbol, pegType: "peggedUSD", price: 1,
      circulating: { peggedUSD: 100 },
      circulatingPrevDay: { peggedUSD: 99 },
      circulatingPrevWeek: { peggedUSD: 98 },
      circulatingPrevMonth: { peggedUSD: 97 },
      chainCirculating: {}, chains: ["ethereum"],
    },
    mcap: 100, supply: 100, prevDay: 99, prevWeek: 98, prevMonth: 97,
    performanceVsUsd1y: null, pegRef: 1, deviationBps: 0, gaugeDeviationBps: 0,
    isNavToken: false, pegScoreResult: null, consensusSources: [], agreeSources: [],
    dexPriceCheck: null, liquidityData: undefined, yieldRanking: null, hasYieldSection: false,
    stressSignal: null, redemptionBackstop: undefined, hasFlows: false, hasBlacklist: false,
    supplyHistory: [], earliestTrackingDate: null, reserves: null, reserveFetchError: null,
    refetchReserves: null, isFetchingReserves: false, supplyError: null, staleQueries: [],
    featureStates: makeFeatureStates(), mintAuthority: { status: "not-reviewed" as const },
    hero: { signalRailItems: [] } as never, handleRetryAll: vi.fn(),
  };
}

export function makeReadyViewModel(overrides: Record<string, unknown> = {}) {
  const coin = TRACKED_META_BY_ID.get("usds-sky")!;
  return {
    ...makeViewModelBase(coin),
    childVariants: [TRACKED_META_BY_ID.get("susds-sky")!, TRACKED_META_BY_ID.get("stusds-sky")!],
    isVariant: false,
    hasVariants: true,
    verdict: {
      archetype: "uncategorized",
      label: "Uncategorized",
    },
    ...overrides,
  };
}

export function makeFrozenViewModel(coin: StablecoinMeta) {
  const frozenCoin: StablecoinMeta = {
    ...coin,
    status: "frozen",
    frozenAt: "2026-04-27",
    obituary,
  };
  return {
    ...makeViewModelBase(frozenCoin),
    childVariants: [],
    isVariant: false,
    hasVariants: false,
    blacklistSymbol: null,
    pegReferenceUnavailable: false,
    verdict: {
      archetype: "frozen-archive",
      label: "Frozen Archive",
    },
  };
}

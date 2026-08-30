// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createContagionSnapshotMock,
  createDepegEventsMock,
  createHeroCardMock,
  createLogosMock,
  createNextLinkMock,
  createNoopComponentMock,
  createStablecoinLogoMock,
  createViewModelMock,
  makeFrozenViewModel,
  obituary,
} from "./client-test-support";
import StablecoinDetailClient from "./client";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { buildStablecoinStaticMeta } from "@/lib/stablecoin-static-meta";
import { buildStablecoinDetailMetadata } from "@/lib/page-metadata";
import type { StablecoinMeta } from "@shared/types";

const { useStablecoinDetailViewModelMock } = vi.hoisted(() => ({
  useStablecoinDetailViewModelMock: vi.fn(),
}));

vi.mock("next/dynamic", () => ({
  default: () => () => <div data-testid="dynamic-detail-section" />,
}));

vi.mock("next/link", async () => createNextLinkMock());

vi.mock("@/hooks/use-stablecoin-detail-view-model", () => createViewModelMock(useStablecoinDetailViewModelMock));

vi.mock("@/hooks/use-depeg-events", () => createDepegEventsMock());

vi.mock("@/lib/logos", () => createLogosMock());

vi.mock("@/components/stablecoin-logo", () => createStablecoinLogoMock());

vi.mock("@/components/stale-data-banner", () => createNoopComponentMock("StaleDataBanner"));

vi.mock("@/components/query-error-notice", () => createNoopComponentMock("QueryErrorNotice"));

vi.mock("@/components/longform-scrollspy-nav", () => ({
  LongformScrollspyNav: () => <nav data-testid="scrollspy" />,
}));

vi.mock("@/components/stablecoin-detail/hero-card", () => createHeroCardMock());

vi.mock("@/components/stablecoin-detail/reserve-panel", () => ({
  ReservePanel: () => null,
}));

vi.mock("@/components/ai-summary", () => ({
  AiSummary: () => <div data-testid="ai-summary" />,
}));

vi.mock("@/components/dews-detail", () => ({
  DEWSDetail: () => null,
}));

vi.mock("@/components/coin-notice", () => createNoopComponentMock("CoinNotices"));

vi.mock("@/components/tape-for-coin-teaser", () => createNoopComponentMock("TapeForCoinTeaser"));

vi.mock("@/components/feedback-modal", () => createNoopComponentMock("FeedbackModal"));

vi.mock("@/components/exploit-notice-banner", () => createNoopComponentMock("ExploitNoticeBanner"));

vi.mock("@/components/stablecoin-detail/recent-blacklist-banner", () => createNoopComponentMock("RecentBlacklistBanner"));

vi.mock("@/components/stablecoin-detail/contagion-snapshot", () => createContagionSnapshotMock());

vi.mock("@/components/report-card", () => ({
  ReportCardDetail: () => <div data-testid="report-card" />,
}));

describe("StablecoinDetailClient (frozen)", () => {
  beforeEach(() => {
    useStablecoinDetailViewModelMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the FrozenStateBanner alongside the hero when status === frozen", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue(makeFrozenViewModel(coin));
    render(<StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />);
    expect(screen.getByRole("heading", { name: /Sunset by issuer\./ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /cemetery/i })).toBeTruthy();
  });

  it("renders FrozenDataNote labels above each chart section", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue(makeFrozenViewModel(coin));
    render(<StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />);
    const notes = screen.getAllByText(/no longer collects new metrics/i);
    // Market chart, Distribution, Liquidity, History — non-flow / non-blacklist
    // sections render unconditionally for this fixture.
    expect(notes.length).toBeGreaterThanOrEqual(4);
  });

  it("renders the frozen banner before preserved AI prose", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    useStablecoinDetailViewModelMock.mockReturnValue({
      ...makeFrozenViewModel(coin),
      summary: {
        title: "Archived note",
        text: "Pre-freeze prose.",
        updatedAt: "2026-04-01",
      },
    });
    render(<StablecoinDetailClient id={coin.id} coin={coin} summary={null} staticCoin={buildStablecoinStaticMeta(coin)} />);

    const banner = screen.getByRole("heading", { name: /Sunset by issuer\./ });
    const summary = screen.getByTestId("ai-summary");
    expect(banner.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("buildStablecoinDetailMetadata (frozen)", () => {
  it("uses the archive-themed title and preserves the OG image", () => {
    const coin = TRACKED_META_BY_ID.get("usds-sky")!;
    const frozen: StablecoinMeta = { ...coin, status: "frozen", frozenAt: "2026-04-27", obituary };
    const meta = buildStablecoinDetailMetadata(frozen);
    expect(typeof meta.title === "string" ? meta.title : "").toContain("Failed Stablecoin Archive");
    const ogImages = meta.openGraph?.images;
    const firstImage = Array.isArray(ogImages) ? ogImages[0] : ogImages;
    const imageUrl = typeof firstImage === "object" && firstImage && "url" in firstImage ? firstImage.url : firstImage;
    expect(String(imageUrl)).toContain(`/api/og/stablecoin/${frozen.id}`);
  });
});

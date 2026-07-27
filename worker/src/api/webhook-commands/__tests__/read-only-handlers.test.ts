import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { mockD1, type MockD1Database } from "../../../test-helpers/__shared/mock-d1";
import type { StatusForCoin } from "../../telegram-webhook-status";
import {
  buildBriefMessage,
  buildCoverageMessage,
  buildTopMessage,
  buildWhyMessage,
} from "../../telegram-webhook-insights";
import { loadStatusForCoin } from "../../telegram-webhook-status";
import type { WebhookCommandContext } from "../context";
import { handleBrief } from "../brief";
import { handleCoverage } from "../coverage";
import { handleHelp } from "../help";
import { handlePresets } from "../presets";
import { handleSample, SAMPLE_COIN_ID } from "../sample";
import { handleStatus } from "../status";
import { handleTop } from "../top";
import { handleWhy } from "../why";

vi.mock("../../telegram-webhook-insights", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../telegram-webhook-insights")>();
  return {
    ...actual,
    buildBriefMessage: vi.fn(),
    buildCoverageMessage: vi.fn(),
    buildTopMessage: vi.fn(),
    buildWhyMessage: vi.fn(),
  };
});

vi.mock("../../telegram-webhook-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../telegram-webhook-status")>();
  return {
    ...actual,
    loadStatusForCoin: vi.fn(),
  };
});

type InlineButton = {
  text?: string;
  callback_data?: string;
  web_app?: { url?: string };
};

const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchSpy);

const statusFixture: StatusForCoin = {
  stablecoinId: "usdc-circle",
  priceUsd: 0.9997,
  priceUpdatedAt: 1_700_000_000,
  supplyUsd: 12_300_000_000,
  stablecoinsUpdatedAt: 1_700_000_000,
  dews: { band: "WATCH", score: 24, computedAt: 1_700_000_000 },
  safety: {
    grade: "A",
    score: 82,
    model: "v9",
    methodologyVersion: "9.0",
    publicationGenerationId: "report-cards:v9:1700000000",
    publishedAt: 1_700_000_000,
    recordedAt: 1_700_000_000,
  },
  liquidity: { score: 91, totalTvlUsd: 450_000_000, updatedAt: 1_700_000_000 },
  yield: null,
  flow: null,
  depeg: { status: "stable" },
};

function makeContext(overrides: Partial<WebhookCommandContext> = {}): WebhookCommandContext {
  return {
    db: mockD1(),
    chatId: "42",
    chatType: "private",
    username: "alice",
    actorUserId: "99",
    botToken: "bot-token",
    replyToChat: vi.fn().mockResolvedValue(undefined),
    replyToChatWithMarkup: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function buttonsFromMarkup(markup: unknown): InlineButton[] {
  const typed = markup as { inline_keyboard?: InlineButton[][] } | undefined;
  return (typed?.inline_keyboard ?? []).flat();
}

function expectMiniAppButton(buttons: InlineButton[], text: string, startapp: string): void {
  expect(buttons.some((button) => button.text === text && button.web_app?.url?.includes(`startapp=${startapp}`))).toBe(
    true,
  );
}

function expectCallbackButton(buttons: InlineButton[], text: string, callbackData: string): void {
  expect(buttons.some((button) => button.text === text && button.callback_data === callbackData)).toBe(true);
}

function expectNoD1Mutation(db: D1Database): void {
  const writes = (db as MockD1Database)
    .getHistory()
    .filter((entry) => /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(entry.sql));
  expect(writes).toEqual([]);
}

describe("read-only webhook command handlers", () => {
  beforeEach(() => {
    vi.mocked(buildBriefMessage).mockReset();
    vi.mocked(buildCoverageMessage).mockReset();
    vi.mocked(buildTopMessage).mockReset();
    vi.mocked(buildWhyMessage).mockReset();
    vi.mocked(loadStatusForCoin).mockReset();
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  });

  it("/help, /presets, and /sample reply through context helpers without D1 mutation", async () => {
    const privateCtx = makeContext();

    await handleHelp(privateCtx, "");
    await handlePresets(privateCtx, "");
    await handleSample(privateCtx, "");

    expect(privateCtx.replyToChatWithMarkup).toHaveBeenCalledTimes(2);
    const [helpText, helpOptions] = vi.mocked(privateCtx.replyToChatWithMarkup).mock.calls[0]!;
    expect(helpText).toContain("/subscribe");
    expectMiniAppButton(buttonsFromMarkup(helpOptions.replyMarkup), "Open control panel", "settings");

    const [presetText, presetOptions] = vi.mocked(privateCtx.replyToChatWithMarkup).mock.calls[1]!;
    expect(presetText).toContain("Preset Watchlists");
    expect(presetText).toContain("usd-top25");
    expectMiniAppButton(buttonsFromMarkup(presetOptions.replyMarkup), "Browse presets", "presets");

    expect(privateCtx.replyToChat).toHaveBeenCalledWith(expect.stringContaining("This was a sample alert"));
    expectNoD1Mutation(privateCtx.db);
    expect(fetchSpy).not.toHaveBeenCalled();

    const groupCtx = makeContext({ chatType: "supergroup" });
    await handleHelp(groupCtx, "");
    await handlePresets(groupCtx, "");
    await handleSample(groupCtx, "");

    expect(groupCtx.replyToChatWithMarkup).not.toHaveBeenCalled();
    expect(groupCtx.replyToChat).toHaveBeenCalledWith(expect.stringContaining("/subscribe"));
    expect(groupCtx.replyToChat).toHaveBeenCalledWith(expect.stringContaining("Preset Watchlists"));
    expect(groupCtx.replyToChat).toHaveBeenCalledWith("Only available in private chats.");
    expectNoD1Mutation(groupCtx.db);
  });

  it("/sample fixture coin stays registered", () => {
    expect(TRACKED_META_BY_ID.get(SAMPLE_COIN_ID)?.symbol).toBe("USDC");
  });

  it("/status resolves a coin, sends the discovery keyboard, and does not mutate state", async () => {
    vi.mocked(loadStatusForCoin).mockResolvedValue(statusFixture);
    const ctx = makeContext();

    await handleStatus(ctx, "USDC");

    expect(loadStatusForCoin).toHaveBeenCalledWith(ctx.db, "usdc-circle");
    expect(ctx.replyToChat).not.toHaveBeenCalled();
    expect(ctx.replyToChatWithMarkup).toHaveBeenCalledTimes(1);
    const [message, options] = vi.mocked(ctx.replyToChatWithMarkup).mock.calls[0]!;
    expect(message).toContain("<b>USDC</b>");
    expect(message).toContain("Price:");
    const buttons = buttonsFromMarkup(options.replyMarkup);
    expectCallbackButton(buttons, "Why?", "why:usdc-circle");
    expectCallbackButton(buttons, "Coverage", "coverage:usdc-circle");
    expectCallbackButton(buttons, "Subscribe", "quicksub:usdc-circle");
    expectMiniAppButton(buttons, "Open in app", "coin_usdc-circle");
    expectNoD1Mutation(ctx.db);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("/status usage and ambiguous/not-found paths avoid DB reads and mutations", async () => {
    const usageCtx = makeContext();
    await handleStatus(usageCtx, "");
    expect(usageCtx.replyToChat).toHaveBeenCalledWith("Usage: /status &lt;ticker&gt;");
    expect(loadStatusForCoin).not.toHaveBeenCalled();
    expectNoD1Mutation(usageCtx.db);

    const notFoundCtx = makeContext();
    await handleStatus(notFoundCtx, "NOTACOIN");
    expect(notFoundCtx.replyToChat).toHaveBeenCalledWith(expect.stringContaining("Ticker or preset"));
    expect(loadStatusForCoin).not.toHaveBeenCalled();
    expectNoD1Mutation(notFoundCtx.db);

    const ambiguousCtx = makeContext();
    await handleStatus(ambiguousCtx, "USDF");
    expect(ambiguousCtx.replyToChat).toHaveBeenCalledWith(expect.stringContaining("matches"));
    expect(ambiguousCtx.replyToChat).toHaveBeenCalledWith(expect.stringContaining("Re-run /status"));
    expect(loadStatusForCoin).not.toHaveBeenCalled();
    expectNoD1Mutation(ambiguousCtx.db);
  });

  it("/why ambiguous ticker guidance keeps the invoking command", async () => {
    const ctx = makeContext();

    await handleWhy(ctx, "USDF");

    expect(ctx.replyToChat).toHaveBeenCalledWith(expect.stringContaining("Re-run /why"));
    expect(ctx.replyToChat).toHaveBeenCalledWith(expect.not.stringContaining("Re-run /status"));
    expect(buildWhyMessage).not.toHaveBeenCalled();
    expectNoD1Mutation(ctx.db);
  });

  it("/brief and /top relay read-only builder output through plain replies", async () => {
    vi.mocked(buildBriefMessage).mockResolvedValue("<b>Brief</b>");
    vi.mocked(buildTopMessage).mockResolvedValue("Top active depegs\n1. USDC");
    const ctx = makeContext();

    await handleBrief(ctx, "");
    await handleTop(ctx, "depeg");

    expect(buildBriefMessage).toHaveBeenCalledWith(ctx.db);
    expect(buildTopMessage).toHaveBeenCalledWith(ctx.db, "depeg");
    expect(ctx.replyToChat).toHaveBeenCalledWith("<b>Brief</b>");
    expect(ctx.replyToChat).toHaveBeenCalledWith("Top active depegs\n1. USDC");
    expect(ctx.replyToChatWithMarkup).not.toHaveBeenCalled();
    expectNoD1Mutation(ctx.db);
    expect(fetchSpy).not.toHaveBeenCalled();

    const usageCtx = makeContext();
    await handleTop(usageCtx, "");
    expect(usageCtx.replyToChat).toHaveBeenCalledWith("Usage: /top depeg|dews|yield|liquidity|chains|safety");
    expect(buildTopMessage).toHaveBeenCalledTimes(1);
    expectNoD1Mutation(usageCtx.db);
  });

  it("/why and /coverage use discovery keyboards in groups and add Mini App buttons only in private chats", async () => {
    vi.mocked(buildWhyMessage).mockResolvedValue("<b>USDC Safety Score</b>");
    vi.mocked(loadStatusForCoin).mockResolvedValue(statusFixture);
    vi.mocked(buildCoverageMessage).mockReturnValue("<b>USDC coverage</b>");

    const whyCtx = makeContext();
    await handleWhy(whyCtx, "USDC");

    expect(buildWhyMessage).toHaveBeenCalledWith(whyCtx.db, "usdc-circle");
    expect(whyCtx.replyToChatWithMarkup).toHaveBeenCalledTimes(1);
    const [whyMessage, whyOptions] = vi.mocked(whyCtx.replyToChatWithMarkup).mock.calls[0]!;
    expect(whyMessage).toBe("<b>USDC Safety Score</b>");
    const whyButtons = buttonsFromMarkup(whyOptions.replyMarkup);
    expectCallbackButton(whyButtons, "Coverage", "coverage:usdc-circle");
    expectMiniAppButton(whyButtons, "Open in app", "why_usdc-circle");
    expectNoD1Mutation(whyCtx.db);

    const privateCoverageCtx = makeContext();
    await handleCoverage(privateCoverageCtx, "USDC");
    const [, coverageOptions] = vi.mocked(privateCoverageCtx.replyToChatWithMarkup).mock.calls[0]!;
    expectMiniAppButton(buttonsFromMarkup(coverageOptions.replyMarkup), "Open in app", "coverage_usdc-circle");
    expectNoD1Mutation(privateCoverageCtx.db);

    const groupWhyCtx = makeContext({ chatType: "group" });
    await handleWhy(groupWhyCtx, "USDC");
    expect(groupWhyCtx.replyToChat).not.toHaveBeenCalled();
    expect(groupWhyCtx.replyToChatWithMarkup).toHaveBeenCalledTimes(1);
    const [groupWhyMessage, groupWhyOptions] = vi.mocked(groupWhyCtx.replyToChatWithMarkup).mock.calls[0]!;
    expect(groupWhyMessage).toBe("<b>USDC Safety Score</b>");
    const groupWhyButtons = buttonsFromMarkup(groupWhyOptions.replyMarkup);
    expectCallbackButton(groupWhyButtons, "Why?", "why:usdc-circle");
    expectCallbackButton(groupWhyButtons, "Coverage", "coverage:usdc-circle");
    expectCallbackButton(groupWhyButtons, "Subscribe", "quicksub:usdc-circle");
    expect(groupWhyButtons.some((button) => button.web_app)).toBe(false);
    expectNoD1Mutation(groupWhyCtx.db);

    const coverageCtx = makeContext({ chatType: "supergroup" });
    await handleCoverage(coverageCtx, "USDC");

    expect(loadStatusForCoin).toHaveBeenCalledWith(coverageCtx.db, "usdc-circle");
    expect(buildCoverageMessage).toHaveBeenCalledWith("USDC", statusFixture);
    expect(coverageCtx.replyToChat).not.toHaveBeenCalled();
    expect(coverageCtx.replyToChatWithMarkup).toHaveBeenCalledTimes(1);
    const [groupCoverageMessage, groupCoverageOptions] = vi.mocked(coverageCtx.replyToChatWithMarkup).mock.calls[0]!;
    expect(groupCoverageMessage).toBe("<b>USDC coverage</b>");
    const groupCoverageButtons = buttonsFromMarkup(groupCoverageOptions.replyMarkup);
    expectCallbackButton(groupCoverageButtons, "Why?", "why:usdc-circle");
    expectCallbackButton(groupCoverageButtons, "Coverage", "coverage:usdc-circle");
    expectCallbackButton(groupCoverageButtons, "Subscribe", "quicksub:usdc-circle");
    expect(groupCoverageButtons.some((button) => button.web_app)).toBe(false);
    expectNoD1Mutation(coverageCtx.db);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

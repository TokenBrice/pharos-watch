import { describe, expect, it, vi } from "vitest";
import searchableCoinsAsset from "@shared/data/stablecoins/coins.telegram-mini-app.generated.json";
import { mockD1 as baseMockD1 } from "@shared/test-utils/mock-d1";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { splitMessage } from "../../common/alerts-formatting";
import { TELEGRAM_MESSAGE_CHUNK_LIMIT } from "../../common/constants";
import { packWatchlistDirectState } from "../../mini-app/watchlist-token";
import type { ConfirmBulkPayload } from "../../webhook/telegram-webhook-shared";
import type { WebhookCommandContext } from "../context";
import { buildV2PreviewMessageForTest, handleImport, persistImportPreviewForTest } from "../import";
import { makeCommandContext } from "./webhook-commands.test-support.ts";
import { buildBulkConfirmReplyMarkup } from "../action-runner";
import { sendAuditedTelegramReply } from "../../webhook/telegram-webhook-replies";

const payload: ConfirmBulkPayload = {
  kind: "subscribe",
  alertTypes: ["dews"],
  presetIds: [],
  coinIds: ["usdc-circle"],
  subscribeAll: false,
};

function mockD1(
  tables: Parameters<typeof baseMockD1>[0] = [],
  options: Parameters<typeof baseMockD1>[1] = {},
) {
  return baseMockD1([
    ...tables,
    { match: "UPDATE cache SET updated_at = updated_at", rows: [] },
  ], options);
}

function context(db: D1Database, overrides: Partial<WebhookCommandContext> = {}): WebhookCommandContext {
  return makeCommandContext(db, {
    chatId: "123",
    actorUserId: "42",
    botToken: "token",
    operationNowSec: 1_783_680_000,
    planIntent: async () => undefined,
    preparePendingMutationAppliedStatement: () => db.prepare("UPDATE cache SET updated_at = updated_at"),
    confirmAtomicMutationApplied: vi.fn(),
    replyToChat: async () => undefined,
    replyToChatWithMarkup: async () => undefined,
    ...overrides,
  });
}

describe("watchlist import preview effect fencing", () => {
  it("preserves the stored import flow identity and bounded callback bytes during preview recovery", async () => {
    const db = mockD1([{ match: "INSERT INTO telegram_usage_daily", rows: [] }]);
    const replyToChatWithMarkup = vi.fn().mockResolvedValue(undefined);
    const flowId = "ffffffffffffffff";
    const ctx = context(db, {
      wasMutationApplied: true,
      replyToChatWithMarkup,
      storedIntent: { version: 1, kind: "command:import", mutation: "required",
        payload: { stage: "bulk-confirm-prompt", expiresAt: 1_783_680_300, payload: { ...payload, flowId } } },
    });
    await handleImport(ctx, "the already-normalized token need not be decoded");
    const data = replyToChatWithMarkup.mock.calls[0]?.[1].replyMarkup.inline_keyboard.flat()
      .map((button: { callback_data: string }) => button.callback_data);
    expect(data).toEqual([`confirm:bulk:${flowId}`, `cancel:bulk:${flowId}`]);
    for (const callback of data) {
      expect(new TextEncoder().encode(callback).length).toBeGreaterThanOrEqual(1);
      expect(new TextEncoder().encode(callback).length).toBeLessThanOrEqual(64);
    }
  });
  it("lists every changed registry id across bounded deterministic preview messages with confirmation only last", async () => {
    const ids = searchableCoinsAsset.map((coin) => coin.stablecoinId);
    const first = Math.floor(ids.length / 3);
    const second = first * 2;
    const entry = (stablecoinId: string, enabled: boolean) => packWatchlistDirectState({
      stablecoinId,
      alertDews: enabled,
      alertDepeg: true,
      alertSafety: false,
      alertLaunch: false,
      alertReserve: false,
      overrideDews: true,
      overrideDepeg: false,
      overrideSafety: true,
      overrideLaunch: false,
      overrideReserve: false,
      dewsMinBand: enabled ? "WARNING" : null,
      safetyMode: null,
      depegWorseningBpsStep: 250,
    });
    const message = buildV2PreviewMessageForTest({
      kind: "watchlist-import-v2",
      registryVersion: "catalog-test",
      directEntries: [...ids.slice(0, first), ...ids.slice(second)].map((id) => entry(id, true)),
      presetEntries: [],
      expectedPreferenceGeneration: 0,
      generationLease: 4_100_000_000_000_000,
      preview: {
        directAdds: ids.slice(0, first),
        directRemoves: ids.slice(first, second),
        directChanges: ids.slice(second),
        directChangeBefore: ids.slice(second).map((id) => entry(id, false)),
        presetAdds: [],
        presetRemoves: [],
        presetChanges: [],
        presetChangeBefore: [],
      },
    });
    expect(message).not.toContain("more)");
    for (const id of ids) expect(message).toContain(`[${id}]`);
    const chunks = splitMessage(message);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.every((chunk) => chunk.length <= TELEGRAM_MESSAGE_CHUNK_LIMIT)).toBe(true);
    expect(chunks[chunks.length - 1]).toContain("Confirm only if");
    expect(buildBulkConfirmReplyMarkup("0123456789abcdef").inline_keyboard.flat().map((button) => button.callback_data)).toEqual([
      "confirm:bulk:0123456789abcdef",
      "cancel:bulk:0123456789abcdef",
    ]);
    expect(chunks.map((chunk) => chunk.replace(/<[^>]*>/g, "")).join(""))
      .toBe(message.replace(/<[^>]*>/g, ""));
    const replyMarkup = buildBulkConfirmReplyMarkup("0123456789abcdef");
    const fetchSpy = mockFetch([{ match: () => true, body: { ok: true } }]);
    try {
      expect(await sendAuditedTelegramReply(mockD1(), "123", message, "token", {
        replyMarkup, recordReplyOutcome: false,
      })).toEqual({ ok: true, errorClass: null });
      const sent = fetchSpy.mock.calls.map((call) =>
        JSON.parse(String((call[1] as RequestInit).body)) as { text: string; reply_markup?: unknown });
      expect(sent.map((chunk) => chunk.text)).toEqual(chunks);
      expect(sent.slice(0, -1).every((chunk) => chunk.reply_markup == null)).toBe(true);
      expect(sent[sent.length - 1]?.reply_markup).toEqual(replyMarkup);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("never confirms the in-memory mutation fence when another owner wins, including retry", async () => {
    const db = mockD1([{
      match: "INSERT INTO telegram_pending_disambiguation",
      rows: [],
      runMeta: { changes: 0 },
    }]);
    const ctx = context(db);
    await expect(persistImportPreviewForTest(ctx, payload, 1_783_680_300, false)).resolves.toBe(false);
    await expect(persistImportPreviewForTest(ctx, payload, 1_783_680_300, false)).resolves.toBe(false);
    expect(ctx.confirmAtomicMutationApplied).not.toHaveBeenCalled();
  });

  it("does not recreate pending state after the durable webhook marker is already applied", async () => {
    const db = mockD1([]);
    const ctx = context(db, { wasMutationApplied: true });
    await expect(persistImportPreviewForTest(ctx, payload, 1_783_680_300, false)).resolves.toBe(true);
    expect((db as ReturnType<typeof mockD1>).getHistory()).toEqual([]);
    expect(ctx.confirmAtomicMutationApplied).not.toHaveBeenCalled();
  });
});

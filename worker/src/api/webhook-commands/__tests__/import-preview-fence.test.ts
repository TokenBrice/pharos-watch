import { describe, expect, it, vi } from "vitest";
import searchableCoinsAsset from "@shared/data/stablecoins/coins.telegram-mini-app.generated.json";
import { mockD1 as baseMockD1 } from "@shared/test-utils/mock-d1";
import { splitMessage } from "../../../lib/telegram/alerts";
import { TELEGRAM_MESSAGE_CHUNK_LIMIT } from "../../../lib/telegram/constants";
import { packWatchlistDirectState } from "../../../lib/telegram/watchlist-token";
import type { ConfirmBulkPayload } from "../../telegram-webhook-shared";
import type { WebhookCommandContext } from "../context";
import { buildV2PreviewMessageForTest, persistImportPreviewForTest } from "../import";
import { BULK_CONFIRM_REPLY_MARKUP } from "../action-runner";
import { sendAuditedTelegramReply } from "../../telegram-webhook-replies";
import { mockFetch } from "@shared/test-utils/mock-fetch";

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
  return {
    db,
    chatId: "123",
    chatType: "private",
    username: "alice",
    actorUserId: "42",
    botToken: "token",
    operationNowSec: 1_783_680_000,
    planIntent: async () => undefined,
    preparePendingMutationAppliedStatement: () => db.prepare("UPDATE cache SET updated_at = updated_at"),
    confirmAtomicMutationApplied: vi.fn(),
    replyToChat: async () => undefined,
    replyToChatWithMarkup: async () => undefined,
    ...overrides,
  };
}

describe("watchlist import preview effect fencing", () => {
  it("lists every changed registry id across bounded deterministic preview messages", () => {
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
    expect(BULK_CONFIRM_REPLY_MARKUP.inline_keyboard.flat().map((button) => button.callback_data)).toEqual([
      "confirm:bulk",
      "cancel:bulk",
    ]);
  });

  it("attaches the confirmation keyboard only to the final exact-preview chunk", async () => {
    const requests: Array<Record<string, unknown>> = [];
    mockFetch([{
      match: "https://api.telegram.org/bottoken/sendMessage",
      respond: async (request) => {
        requests.push(await request.clone().json() as Record<string, unknown>);
        return { body: "ok" };
      },
    }], { requireMatch: true });
    try {
      const db = mockD1([]);
      await sendAuditedTelegramReply(db, "123", `first\n\n${"x".repeat(9_000)}`, "token", {
        replyMarkup: BULK_CONFIRM_REPLY_MARKUP,
      });
      expect(requests.length).toBeGreaterThanOrEqual(3);
      expect(requests.slice(0, -1).every((request) => request.reply_markup == null)).toBe(true);
      expect(requests[requests.length - 1]?.reply_markup).toEqual(BULK_CONFIRM_REPLY_MARKUP);
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

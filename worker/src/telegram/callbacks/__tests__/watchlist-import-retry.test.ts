import { afterEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { packWatchlistDirectState } from "../../mini-app/watchlist-token";
import type { ConfirmBulkPayload } from "../../webhook/telegram-webhook-shared";
import type { TelegramWebhookOperationIntent } from "../../store/telegram-webhook-store";
import { handleBulkActionCallback } from "../confirm";

afterEach(() => vi.unstubAllGlobals());

describe("watchlist import confirmation retry", () => {
  it("does not replay replacement after the webhook mutation marker and reports current stale truth", async () => {
    const desiredEntry = packWatchlistDirectState({
      stablecoinId: "usdc-circle",
      alertDews: true,
      alertDepeg: true,
      alertSafety: false,
      alertLaunch: false,
      alertReserve: false,
      overrideDews: true,
      overrideDepeg: true,
      overrideSafety: false,
      overrideLaunch: false,
      overrideReserve: false,
      dewsMinBand: "WARNING",
      safetyMode: null,
      depegWorseningBpsStep: 250,
    });
    const payload: Extract<ConfirmBulkPayload, { kind: "watchlist-import-v2" }> = {
      kind: "watchlist-import-v2",
      flowId: "0123456789abcdef",
      registryVersion: "catalog-test",
      directEntries: [desiredEntry],
      presetEntries: [],
      expectedPreferenceGeneration: 5,
      generationLease: 4_100_000_000_000_010,
      preview: {
        directAdds: ["usdc-circle"],
        directRemoves: [],
        directChanges: [],
        directChangeBefore: [],
        presetAdds: [],
        presetRemoves: [],
        presetChanges: [],
        presetChangeBefore: [],
      },
    };
    const storedIntent: TelegramWebhookOperationIntent = {
      version: 1,
      kind: "callback:confirm",
      mutation: "required",
      payload: { action: "confirm", kind: "bulk", flowId: "0123456789abcdef", expiresAt: 1_783_680_300, payload },
    };
    const db = mockD1([{
      match: "WITH subscriber AS",
      rows: [{ row_kind: null, preference_generation: 6 }],
    }]);
    const requests: Array<Record<string, unknown>> = [];
    mockFetch([{
      match: "https://api.telegram.org/bottoken/sendMessage",
      respond: async (request) => {
        requests.push(await request.clone().json() as Record<string, unknown>);
        return { body: "ok" };
      },
    }], { requireMatch: true });
    const answerCallback = vi.fn(async () => undefined);
    const confirmAtomicMutationApplied = vi.fn();
    await handleBulkActionCallback({
      db,
      botToken: "token",
      chatId: "123",
      cb: {
        id: "callback-id",
        data: "confirm:bulk:0123456789abcdef",
        from: { id: 42, username: "alice" },
        message: { chat: { id: 123, type: "private" }, message_id: 10 },
      },
      parsed: { action: "confirm", arg: "bulk", parts: ["confirm", "bulk", "0123456789abcdef"] },
      beforeIrreversibleEffect: async () => undefined,
      answerCallback,
      markMutationApplied: async () => undefined,
      planIntent: async () => undefined,
      confirmAtomicMutationApplied,
      storedIntent,
      wasMutationApplied: true,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.text).toContain("settings changed after this preview");
    expect(answerCallback).toHaveBeenCalledWith({ text: "Preview stale. Nothing replaced." });
    expect(confirmAtomicMutationApplied).not.toHaveBeenCalled();
    const sql = (db as ReturnType<typeof mockD1>).getHistory().map((entry) => entry.sql).join("\n");
    expect(sql).not.toContain("generationLease");
    expect(sql).not.toContain("DELETE FROM telegram_pending_disambiguation");
    expect(sql).not.toContain("INSERT INTO telegram_subscriptions");
  });
});

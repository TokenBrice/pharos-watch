import { afterEach, describe, expect, it, vi } from "vitest";
import { mockD1, type MockD1Database } from "@shared/test-utils/mock-d1";
import { handleForget } from "../forget";
import type { WebhookCommandContext } from "../context";
import { makeCommandContext } from "./webhook-commands.test-support";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { prepareTelegramProcessedUpdatePendingMutationApplied } from "../../../lib/telegram/processed-updates";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

function makeContext(overrides: Partial<WebhookCommandContext> = {}): WebhookCommandContext {
  return makeCommandContext(mockD1(), { actorUserId: "42", ...overrides });
}

describe("forget durable retries", () => {
  it("does not recreate pending confirmation or confirm a fence on an applied retry", async () => {
    const { sqlite, db } = fixtures.open();
    const confirm = vi.fn();
    const ctx = makeContext({ db, wasMutationApplied: true, confirmAtomicMutationApplied: confirm,
      preparePendingMutationAppliedStatement: () => db.prepare("DELETE FROM telegram_subscribers") });
    await handleForget(ctx, "");
    expect(sqlite.prepare("SELECT * FROM telegram_pending_disambiguation").all()).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
    expect(ctx.replyToChatWithMarkup).toHaveBeenCalledOnce();
  });

  it("commits pending and its marker together and rolls both back on lost claim", async () => {
    for (const claimOwner of ["owner", "lost"]) {
      const { sqlite, db } = fixtures.open();
      sqlite.exec(`INSERT INTO telegram_processed_updates
        (update_id, received_at, update_type, chat_id, status, effect_state, claim_owner, claim_generation, intent_mutates)
        VALUES (7001, 100, 'message', '42', 'processing', 'planned', 'owner', 1, 1)`);
      const confirm = vi.fn();
      const ctx = makeContext({ db, operationNowSec: 1_800_000_000, confirmAtomicMutationApplied: confirm,
        preparePendingMutationAppliedStatement: (input) => prepareTelegramProcessedUpdatePendingMutationApplied(db, {
          ...input, updateId: 7001, nowSec: 1_800_000_000, claimOwner, claimGeneration: 1,
        }),
      });
      if (claimOwner === "lost") {
        await expect(handleForget(ctx, "")).rejects.toThrow();
        expect(sqlite.prepare("SELECT * FROM telegram_pending_disambiguation").all()).toEqual([]);
        expect(sqlite.prepare("SELECT * FROM telegram_webhook_operation_mutations").all()).toEqual([]);
        expect(confirm).not.toHaveBeenCalled();
      } else {
        await handleForget(ctx, "");
        expect(sqlite.prepare("SELECT action_type, initiator_user_id FROM telegram_pending_disambiguation").get())
          .toEqual({ action_type: "forget-confirm", initiator_user_id: "42" });
        expect(sqlite.prepare("SELECT update_id, applied_at FROM telegram_webhook_operation_mutations").get())
          .toEqual({ update_id: 7001, applied_at: 1_800_000_000 });
        expect(confirm).toHaveBeenCalledOnce();
      }
    }
  });
});

describe("handleForget", () => {
  it("rejects group chats with a private-chat-only message and records a not_private failure", async () => {
    const replyToChat = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({ chatType: "group", replyToChat });

    await handleForget(ctx, "");

    expect(replyToChat).toHaveBeenCalledWith(
      expect.stringContaining("Open a private chat"),
    );
    expect((ctx.db as MockD1Database).getHistory().some((entry) =>
      entry.sql.includes("INSERT INTO telegram_pending_disambiguation"),
    )).toBe(false);
  });

  it("rejects supergroups with the private-chat-only message", async () => {
    const replyToChat = vi.fn().mockResolvedValue(undefined);
    const ctx = makeContext({ chatType: "supergroup", replyToChat });

    await handleForget(ctx, "");

    expect(replyToChat).toHaveBeenCalledTimes(1);
    expect((ctx.db as MockD1Database).getHistory().some((entry) =>
      entry.sql.includes("INSERT INTO telegram_pending_disambiguation"),
    )).toBe(false);
  });

  it("persists a forget-confirm pending row and offers an inline keyboard in private chats", async () => {
    const replyToChatWithMarkup = vi.fn().mockResolvedValue(undefined);
    const db = mockD1([{ match: "INSERT INTO telegram_pending_disambiguation", rows: [], runMeta: { changes: 1 } }]);
    const ctx = makeContext({ db, replyToChatWithMarkup });

    await handleForget(ctx, "");

    expect(replyToChatWithMarkup).toHaveBeenCalledTimes(1);
    const [, options] = replyToChatWithMarkup.mock.calls[0];
    expect(options).toEqual({
      replyMarkup: {
        inline_keyboard: [
          [
            {
              text: "Open control panel",
              web_app: { url: "https://pharos.watch/pharoswatchbot/app/?startapp=forget" },
            },
          ],
          [
            { text: "Confirm", callback_data: "confirm:forget" },
            { text: "Cancel", callback_data: "cancel:forget" },
          ],
        ],
      },
    });
    const writes = db.getHistory().filter((entry) =>
      entry.sql.includes("INSERT INTO telegram_pending_disambiguation"),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.binds).toContain("forget-confirm");
  });

  it("warns when another pending action already owns the chat", async () => {
    const replyToChat = vi.fn().mockResolvedValue(undefined);
    const { sqlite, db } = fixtures.open();
    sqlite.exec(`INSERT INTO telegram_pending_disambiguation
      (chat_id, action_type, action_payload, alert_types, resolved_ids, ambiguous_ticker, candidates, remaining_tickers, expires_at, initiator_user_id)
      VALUES ('42', 'forget-confirm', '{}', '[]', '[]', '', '[]', '[]', 4000000000, 'other')`);
    const before = sqlite.prepare("SELECT * FROM telegram_pending_disambiguation").all();
    const confirm = vi.fn();
    const ctx = makeContext({ db, replyToChat, confirmAtomicMutationApplied: confirm,
      preparePendingMutationAppliedStatement: () => db.prepare("UPDATE cache SET updated_at = updated_at") });

    await handleForget(ctx, "");
    expect(confirm).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT * FROM telegram_pending_disambiguation").all()).toEqual(before);

    expect(replyToChat).toHaveBeenCalledWith(
      expect.stringContaining("Another user has a pending"),
    );
  });
});

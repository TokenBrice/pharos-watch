import { answerCallbackQuery } from "../lib/telegram";
import {
  handleMyChatMember,
  isBotRemovedTransition,
} from "./telegram-webhook-group-welcome";
import {
  migrateTelegramChatId,
  unixNow,
} from "./telegram-webhook-store";
import { withErrorHandler } from "../lib/api-utils";
import { classifyTelegramLogError, logTelegramEvent } from "../lib/telegram-log";
import { validateTelegramWebhookSecret } from "./telegram-webhook-auth";
import {
  TelegramWebhookEffectFence,
  buildMutationOperations,
  createTelegramWebhookIntent,
  establishTelegramWebhookEffectFence,
} from "./telegram-webhook-effect-fence";
import {
  resolveChatMigration,
  type TelegramWebhookUpdateWithChatMember,
} from "./telegram-webhook-update-normalization";
import {
  handleTelegramCallbackQueryUpdate,
  handleTelegramMessageUpdate,
} from "./telegram-webhook-update-dispatch";
import {
  handleTelegramChosenInlineResultUpdate,
  handleTelegramInlineQueryUpdate,
} from "./telegram-inline-queries";
import {
  TELEGRAM_RECAP_PUBLIC_ROLLOUT_POLICY,
  type TelegramRecapRolloutPolicy,
} from "@shared/lib/telegram-recap-rollout";

/**
 * Group admin gating mode for group-wide mutating commands in
 * group/supergroup chats. "hard" refuses the command for non-admins (default).
 * "soft" is kept as an emergency rollback path for operators: it warns the
 * non-admin and still runs the command. The exported wrapper is mutable so
 * tests can flip the mode; production code should keep the default.
 */
export { TELEGRAM_GROUP_ADMIN_GATING, type TelegramGroupAdminGating } from "./telegram-webhook-ingress-policy";

export const handleTelegramWebhook = withErrorHandler(
  "telegram-webhook",
  async (
    db: D1Database,
    request: Request,
    webhookSecret?: string,
    botToken?: string,
    previousWebhookSecret?: string,
    recapRollout: TelegramRecapRolloutPolicy = TELEGRAM_RECAP_PUBLIC_ROLLOUT_POLICY,
  ): Promise<Response> => {
    const ok = () => new Response("ok", { status: 200 });

    const authResult = await validateTelegramWebhookSecret(
      request,
      webhookSecret,
      previousWebhookSecret,
    );
    if (authResult !== "valid") {
      return ok();
    }
    if (!botToken) return ok();

    let update: TelegramWebhookUpdateWithChatMember;
    try {
      update = await request.json();
    } catch {
      return ok();
    }

    const nowSec = unixNow();
    const claimOutcome = await establishTelegramWebhookEffectFence(db, update, nowSec);
    if (claimOutcome.kind === "respond") {
      return claimOutcome.response;
    }
    const effectFence: TelegramWebhookEffectFence | null = claimOutcome.effectFence;

    const finishOk = async (errorClass: string | null = null): Promise<Response> => {
      await effectFence?.finish(errorClass);
      return ok();
    };

    const beforeIrreversibleEffect = async (kind: string): Promise<void> => {
      await effectFence?.beforeIrreversibleEffect(kind);
    };

    const answerWebhookCallback = async (
      callbackQueryId: string,
      options?: { text?: string },
    ): Promise<void> => {
      await beforeIrreversibleEffect("callback-ack");
      await answerCallbackQuery(callbackQueryId, botToken, options);
    };

    try {
      if (update.inline_query) {
        await handleTelegramInlineQueryUpdate({
          db,
          botToken,
          inlineQuery: update.inline_query,
          effectFence,
        });
        return finishOk();
      }

      if (update.chosen_inline_result) {
        await handleTelegramChosenInlineResultUpdate(db);
        return finishOk();
      }

      if (update.callback_query) {
        return await handleTelegramCallbackQueryUpdate({
          db,
          botToken,
          callbackQuery: update.callback_query,
          nowSec,
          finishOk,
          effectFence,
          beforeIrreversibleEffect,
          answerWebhookCallback,
          recapRollout,
        });
      }

      if (update.my_chat_member) {
        const lifecycleRemoval = isBotRemovedTransition(
          update.my_chat_member.old_chat_member?.status,
          update.my_chat_member.new_chat_member?.status,
        );
        await effectFence?.plan(createTelegramWebhookIntent("member:lifecycle", {
          oldStatus: update.my_chat_member.old_chat_member?.status ?? null,
          newStatus: update.my_chat_member.new_chat_member?.status ?? null,
          chatType: update.my_chat_member.chat?.type ?? null,
          transition: lifecycleRemoval ? "removal" : "other",
        }, lifecycleRemoval ? "required" : "none"));
        let myChatMemberErrorClass: string | null = null;
        try {
          await handleMyChatMember(db, botToken, update.my_chat_member, {
            ...buildMutationOperations(effectFence, { beforeIrreversibleEffect }),
          });
        } catch (err) {
          logTelegramEvent({
            message: "my_chat_member failed",
            action: "my_chat_member",
            errorClass: classifyTelegramLogError(err),
          });
          if (effectFence?.hasStartedEffect) throw err;
          myChatMemberErrorClass = "my_chat_member";
        }
        return finishOk(myChatMemberErrorClass);
      }

      const migration = resolveChatMigration(update.message);
      if (migration) {
        await effectFence?.plan(createTelegramWebhookIntent("chat:migration", migration, "required"));
        let migrationErrorClass: string | null = null;
        try {
          if (!effectFence?.wasMutationApplied) {
            const operationStatements = effectFence
              ? [effectFence.prepareMutationAppliedStatement()]
              : [];
            await migrateTelegramChatId(db, migration.oldChatId, migration.newChatId, { operationStatements });
            effectFence?.confirmAtomicMutationApplied();
          }
          logTelegramEvent({
            level: "info",
            message: "telegram chat id migrated",
            action: "chat-migration",
          });
        } catch (err) {
          logTelegramEvent({
            message: "telegram chat migration failed",
            action: "chat-migration",
            errorClass: classifyTelegramLogError(err),
          });
          migrationErrorClass = "chat-migration";
        }
        return finishOk(migrationErrorClass);
      }

      return await handleTelegramMessageUpdate({
        db,
        update,
        botToken,
        finishOk,
        effectFence,
        beforeIrreversibleEffect,
        operationNowSec: nowSec,
        recapRollout,
      });
    } catch (err) {
      await effectFence?.fail(classifyWebhookError(err));
      throw err;
    }
  },
);

function classifyWebhookError(err: unknown): string {
  if (err instanceof Error && err.name) return err.name;
  return "unknown";
}

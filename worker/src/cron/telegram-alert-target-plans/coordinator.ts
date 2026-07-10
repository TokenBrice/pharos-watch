import { throwIfAborted } from "../../lib/abort";
import { enqueueTelegramAuthoritativeTargets, finalizeTelegramTargetPlanning, openTelegramTargetPlanDelivery } from "./delivery";
import { captureTelegramPlanningSubscriberPage, loadTelegramPlanningSubscriberPage } from "./horizon";
import {
  materializeTelegramTargetPlanPage,
  reconcileIncompleteTelegramTargetPlanPage,
} from "./materialization";
import { claimTelegramTargetPlanning, releaseTelegramTargetPlanningClaim } from "./source-state";
import {
  TELEGRAM_TARGET_PLAN_ENQUEUE_PAGE_SIZE,
  TELEGRAM_TARGET_PLAN_HORIZON_PAGE_SIZE,
} from "./types";
import type {
  TelegramPlanningDecision,
  TelegramPlanningSubscriber,
  TelegramTargetPlanningClaim,
} from "./types";

export interface TelegramTargetPlanCoordinatorCallbacks {
  resolveInitialEligibility: (
    subscribers: readonly Omit<TelegramPlanningSubscriber, "initiallyEligible">[],
  ) => Promise<ReadonlyMap<string, { eligible: boolean; observedPreferenceGeneration: number }>>;
  planSubscribers: (
    subscribers: readonly TelegramPlanningSubscriber[],
    claim: TelegramTargetPlanningClaim,
  ) => Promise<readonly TelegramPlanningDecision[]>;
}

export interface TelegramTargetPlanCoordinatorResult {
  state: TelegramTargetPlanningClaim["state"] | "expired";
  generation: number;
  steps: number;
  enqueued: number;
  remainingTargets: number;
  expiryComplete: boolean;
}

export function estimateTelegramTargetPlanCoordinatorBound(input: {
  subscriberCount: number;
  targetCount: number;
  maxSteps: number;
}): { steps: number; runs: number } {
  const subscribers = Math.max(0, Math.floor(input.subscriberCount));
  const targets = Math.max(0, Math.floor(input.targetCount));
  const maxSteps = Math.max(1, Math.floor(input.maxSteps));
  const captureSteps = Math.floor(subscribers / TELEGRAM_TARGET_PLAN_HORIZON_PAGE_SIZE) + 1;
  const planningSteps = Math.ceil(subscribers / TELEGRAM_TARGET_PLAN_HORIZON_PAGE_SIZE) + 1;
  const openDeliverySteps = 1;
  const enqueueSteps = Math.max(1, Math.ceil(targets / TELEGRAM_TARGET_PLAN_ENQUEUE_PAGE_SIZE));
  const steps = captureSteps + planningSteps + openDeliverySteps + enqueueSteps;
  return { steps, runs: Math.ceil(steps / maxSteps) };
}

async function nextPageIndex(
  db: D1Database,
  claim: TelegramTargetPlanningClaim,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(MAX(page_index), -1) + 1 AS page_index
         FROM telegram_alert_target_plan_pages
        WHERE source_event_id = ? AND plan_generation = ?`,
    )
    .bind(claim.sourceEventId, claim.generation)
    .first<{ page_index: number }>();
  return Number(row?.page_index ?? 0);
}

/**
 * Advance one source through bounded, durable state transitions. Each loop
 * crosses at most one crash boundary; callers bound total work with maxSteps.
 */
export async function runTelegramTargetPlanCoordinator(args: {
  db: D1Database;
  sourceEventId: string;
  nowSec: number;
  callbacks: TelegramTargetPlanCoordinatorCallbacks;
  maxSteps?: number;
  signal?: AbortSignal;
}): Promise<TelegramTargetPlanCoordinatorResult> {
  const maxSteps = Math.max(1, Math.min(32, Math.floor(args.maxSteps ?? 16)));
  let claim = await claimTelegramTargetPlanning(args.db, args.sourceEventId, args.nowSec);
  if (!claim) {
    const source = await args.db
      .prepare(
        `SELECT target_plan_state, target_plan_generation
           FROM telegram_alert_source_events WHERE source_event_id = ?`,
      )
      .bind(args.sourceEventId)
      .first<{ target_plan_state: string; target_plan_generation: number }>();
    if (source?.target_plan_state === "expired" || source?.target_plan_state === "degraded") {
      const expiry = source.target_plan_state === "expired"
        ? await args.db
          .prepare(
            `SELECT state FROM telegram_alert_target_expiry_progress
              WHERE source_event_id = ? AND plan_generation = ?`,
          )
          .bind(args.sourceEventId, source.target_plan_generation)
          .first<{ state: string }>()
        : null;
      return {
        state: source.target_plan_state,
        generation: Number(source.target_plan_generation),
        steps: 0,
        enqueued: 0,
        remainingTargets: 0,
        expiryComplete: expiry?.state === "complete",
      };
    }
    throw new Error("Telegram target plan source is owned by another worker");
  }
  let enqueued = 0;
  let remainingTargets = 0;
  let steps = 0;

  while (steps < maxSteps) {
    throwIfAborted(args.signal);
    steps += 1;
    if (claim.state === "degraded") break;
    if (claim.state === "capturing") {
      await captureTelegramPlanningSubscriberPage(
        args.db,
        claim,
        args.nowSec,
        args.callbacks.resolveInitialEligibility,
      );
    } else if (claim.state === "planning" || claim.state === "materializing") {
      const incompletePage = await reconcileIncompleteTelegramTargetPlanPage(args.db, claim, args.nowSec);
      if (incompletePage.complete) {
        const refreshed = await claimTelegramTargetPlanning(
          args.db,
          claim.sourceEventId,
          args.nowSec,
          claim.owner,
        );
        if (!refreshed) throw new Error("Telegram target plan ownership changed during page recovery");
        claim = refreshed;
        continue;
      }
      const subscribers = await loadTelegramPlanningSubscriberPage(
        args.db,
        claim,
        undefined,
        incompletePage.found && incompletePage.firstChatId && incompletePage.lastChatId
          ? {
              firstChatId: incompletePage.firstChatId,
              lastChatId: incompletePage.lastChatId,
            }
          : undefined,
      );
      if (subscribers.length === 0) {
        await finalizeTelegramTargetPlanning(args.db, claim, args.nowSec);
      } else {
        const decisions = await args.callbacks.planSubscribers(subscribers, claim);
        if (decisions.length !== subscribers.length) {
          throw new Error("Telegram target planner did not return one decision per captured subscriber");
        }
        await materializeTelegramTargetPlanPage(
          args.db,
          claim,
          incompletePage.pageIndex ?? await nextPageIndex(args.db, claim),
          decisions,
          args.nowSec,
        );
      }
    } else if (claim.state === "ready") {
      if (!await openTelegramTargetPlanDelivery(args.db, claim, args.nowSec)) {
        throw new Error("Telegram target plan delivery-open CAS was not confirmed");
      }
    } else if (claim.state === "delivery_open") {
      const result = await enqueueTelegramAuthoritativeTargets(
        args.db,
        claim.sourceEventId,
        claim.generation,
        args.nowSec,
      );
      enqueued += result.enqueued;
      remainingTargets = result.remaining;
      if (result.remaining === 0) break;
    }

    const refreshed = await claimTelegramTargetPlanning(
      args.db,
      claim.sourceEventId,
      args.nowSec,
      claim.owner,
    );
    if (!refreshed) throw new Error("Telegram target plan ownership changed while advancing");
    claim = refreshed;
  }
  if (claim.state === "delivery_open" && remainingTargets === 0) {
    const row = await args.db
      .prepare(
        `SELECT COUNT(*) AS count FROM telegram_alert_job_targets
          WHERE source_event_id = ? AND plan_generation = ? AND status = 'planned'`,
      )
      .bind(claim.sourceEventId, claim.generation)
      .first<{ count: number }>();
    remainingTargets = Number(row?.count ?? 0);
  }
  if (
    steps === maxSteps &&
    (claim.state === "capturing" || claim.state === "planning" ||
      claim.state === "materializing" || claim.state === "ready") &&
    !await releaseTelegramTargetPlanningClaim(args.db, claim)
  ) {
    throw new Error("Telegram target plan bounded handoff release was not confirmed");
  }
  return {
    state: claim.state,
    generation: claim.generation,
    steps,
    enqueued,
    remainingTargets,
    expiryComplete: false,
  };
}

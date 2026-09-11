import { expect } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import type { StatusCause } from "@shared/types/status";
import { handlePublicStatusHistory } from "../public-status-history";

type TransitionSeed = {
  id: number;
  previous_status: "healthy" | "degraded" | "stale" | null;
  next_status: "healthy" | "degraded" | "stale";
  raw_status: "healthy" | "degraded" | "stale";
  transition_type: "degrade" | "recover" | "init";
  reason: string;
  causes: StatusCause[];
  created_at: number;
};

export function makeDb(params: {
  transitions: TransitionSeed[];
  stateStatus?: "healthy" | "degraded" | "stale";
  stateLastChangedAt?: number | null;
}) {
  const stateRow = params.stateStatus
    ? {
        scope: "global",
        current_status: params.stateStatus,
        raw_status: params.stateStatus,
        last_evaluated_at: Math.floor(Date.now() / 1000),
        last_changed_at: params.stateLastChangedAt ?? Math.floor(Date.now() / 1000) - 3600,
        consecutive_healthy: 0,
        consecutive_degraded: 0,
        consecutive_stale: 0,
        confidence: 0.9,
        causes_json: "[]",
      }
    : null;
  return mockD1([
    {
      match: "FROM status_state",
      rows: stateRow ? [stateRow] : [],
      first: stateRow,
    },
    {
      match: "FROM status_transitions",
      rows: params.transitions.map((t) => ({
        id: t.id,
        scope: "global",
        previous_status: t.previous_status,
        next_status: t.next_status,
        raw_status: t.raw_status,
        transition_type: t.transition_type,
        reason: t.reason,
        confidence: 0.9,
        causes_json: JSON.stringify(t.causes),
        created_at: t.created_at,
      })),
    },
  ]);
}

export function transition(
  seed: Pick<TransitionSeed, "id" | "next_status" | "created_at" | "causes"> & Partial<TransitionSeed>,
): TransitionSeed {
  return {
    previous_status: "healthy", raw_status: seed.next_status,
    transition_type: "degrade", reason: "raw-degraded-consecutive-threshold",
    ...seed,
  };
}

export async function readHistory(db: D1Database) {
  const response = await handlePublicStatusHistory(db, new Request("https://pharos.watch/api/public-status-history?window=24h"));
  expect(response.status).toBe(200);
  return await response.json() as {
    currentStatus: string;
    lastChangedAt: number | null;
    transitions: Array<{ id: number; from: string | null; to: string }>;
  };
}

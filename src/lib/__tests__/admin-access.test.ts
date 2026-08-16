import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminMutationError, adminMutation } from "@/lib/admin-access";
import { mockFetch } from "@shared/test-utils/mock-fetch";

describe("adminMutation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns idempotency and execution metadata from response headers", async () => {
    mockFetch([{
      match: "/api/admin/trigger-digest",
      body: { accepted: true },
      status: 202,
      headers: {
        "Idempotency-Key": "intent-123",
        "X-Idempotent-Replay": "true",
        "X-Execution-Certainty": "accepted",
        Warning: "199 - queued for background execution",
      },
    }], { requireMatch: true });

    const result = await adminMutation("/api/trigger-digest", {
      idempotencyKey: "intent-123",
    });

    expect(result).toMatchObject({
      status: 202,
      idempotencyKey: "intent-123",
      idempotentReplay: true,
      executionCertainty: "accepted",
      warning: "199 - queued for background execution",
    });
  });

  it("preserves raw response and replay metadata on HTTP failures", async () => {
    mockFetch([{
      match: "/api/admin/backfill-supply-history",
      body: { error: "execution_unknown", message: "Reconcile downstream state." },
      status: 503,
      headers: {
        "Idempotency-Key": "intent-unknown",
        "X-Idempotent-Replay": "false",
      },
    }], { requireMatch: true });

    const error = await adminMutation("/api/backfill-supply-history", {
      idempotencyKey: "intent-unknown",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AdminMutationError);
    expect((error as AdminMutationError).result).toMatchObject({
      status: 503,
      idempotencyKey: "intent-unknown",
      idempotentReplay: false,
      formattedBody: expect.stringContaining("execution_unknown"),
    });
  });
});

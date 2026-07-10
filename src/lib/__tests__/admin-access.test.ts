import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminMutationError, adminMutation } from "@/lib/admin-access";

describe("adminMutation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns idempotency and execution metadata from response headers", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ accepted: true }), {
        status: 202,
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "intent-123",
          "X-Idempotent-Replay": "true",
          "X-Execution-Certainty": "accepted",
          Warning: "199 - queued for background execution",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

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
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "execution_unknown", message: "Reconcile downstream state." }), {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "intent-unknown",
          "X-Idempotent-Replay": "false",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

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

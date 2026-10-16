import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminMutationError, adminMutation } from "@/lib/admin-access";
import { RequestFailure } from "@/lib/request";
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
      match: "/api/admin/remediate-blacklist-amount-gaps",
      body: { error: "execution_unknown", message: "Reconcile downstream state." },
      status: 503,
      headers: {
        "Idempotency-Key": "intent-unknown",
        "X-Idempotent-Replay": "false",
      },
    }], { requireMatch: true });

    const error = await adminMutation("/api/remediate-blacklist-amount-gaps", {
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

  it("sends the admin marker, caller idempotency key, and a serialized JSON body", async () => {
    const fetchSpy = mockFetch([{
      match: "/api/admin/trigger-digest",
      // Routing itself requires the outgoing safety headers to be present.
      matchHeaders: { "X-Pharos-Admin": "1", "Idempotency-Key": "intent-42" },
      body: { accepted: true },
      status: 202,
    }], { requireMatch: true });

    const result = await adminMutation("/api/trigger-digest", {
      idempotencyKey: "intent-42",
      body: { target: "usdc-circle", days: 90 },
    });

    expect(result.status).toBe(202);
    const [request] = fetchSpy.getHistory();
    expect(request.method).toBe("POST");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.body).toBe(JSON.stringify({ target: "usdc-circle", days: 90 }));
  });

  it("keeps the raw non-JSON body on an HTTP error result", async () => {
    mockFetch([{
      match: "/api/admin/reload-config",
      body: "upstream exploded",
      status: 500,
      headers: { "Content-Type": "text/plain" },
    }], { requireMatch: true });

    const error = await adminMutation("/api/reload-config")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AdminMutationError);
    expect((error as AdminMutationError).message).toBe("500: upstream exploded");
    expect((error as AdminMutationError).result).toMatchObject({
      status: 500,
      data: "upstream exploded",
      formattedBody: "upstream exploded",
    });
  });

  it("rejects an aborted pending mutation without reporting acceptance", async () => {
    mockFetch([{
      match: "/api/admin/trigger-digest",
      respond: () => ({ stall: true }),
    }], { requireMatch: true });
    const controller = new AbortController();

    const pending = adminMutation("/api/trigger-digest", { signal: controller.signal });
    controller.abort();
    const error = await pending.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RequestFailure);
    expect((error as RequestFailure).kind).toBe("aborted");
  });
});

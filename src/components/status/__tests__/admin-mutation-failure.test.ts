import { describe, expect, it } from "vitest";
import { classifyAdminMutationFailure } from "../admin-mutation-failure";
import { AdminMutationError, type AdminMutationResult } from "@/lib/admin-access";
import { RequestFailure } from "@/lib/request";

const KEY = "intent-key-1";

function result(overrides: Partial<AdminMutationResult<unknown>> = {}): AdminMutationResult<unknown> {
  return {
    data: null,
    text: "",
    formattedBody: "",
    status: 500,
    idempotencyKey: null,
    idempotentReplay: false,
    executionCertainty: null,
    warning: null,
    ...overrides,
  } as AdminMutationResult<unknown>;
}

function mutationError(overrides: Partial<AdminMutationResult<unknown>> = {}): AdminMutationError {
  return new AdminMutationError("boom", result(overrides));
}

/**
 * These are the certainty semantics both admin write lanes now share. Every
 * `"unknown"` case means the write may already have landed, so the UI must
 * offer a same-key retry rather than presenting the operation as undone.
 */
describe("classifyAdminMutationFailure", () => {
  it("treats an execution_unknown body as unknown", () => {
    expect(classifyAdminMutationFailure(mutationError({ status: 200, data: { error: "execution_unknown" } }), KEY)).toBe(
      "unknown",
    );
  });

  it("treats any 5xx as unknown", () => {
    expect(classifyAdminMutationFailure(mutationError({ status: 503 }), KEY)).toBe("unknown");
  });

  it("honours an explicit unknown execution-certainty header regardless of case or padding", () => {
    expect(classifyAdminMutationFailure(mutationError({ status: 400, executionCertainty: " UNKNOWN " }), KEY)).toBe(
      "unknown",
    );
  });

  it("treats a 409 naming this execution's own reservation as unknown", () => {
    const error = mutationError({
      status: 409,
      data: { error: "Idempotency key is currently reserved" },
      idempotencyKey: KEY,
    });
    expect(classifyAdminMutationFailure(error, KEY)).toBe("unknown");
  });

  it("treats a reservation-ownership loss reported as a replay as unknown", () => {
    const error = mutationError({
      status: 409,
      data: { error: "idempotency reservation ownership was lost" },
      idempotencyKey: "someone-elses-key",
      idempotentReplay: true,
    });
    expect(classifyAdminMutationFailure(error, KEY)).toBe("unknown");
  });

  it("treats a 409 for a different key as a plain failure", () => {
    const error = mutationError({
      status: 409,
      data: { error: "Idempotency key is currently reserved" },
      idempotencyKey: "someone-elses-key",
    });
    expect(classifyAdminMutationFailure(error, KEY)).toBe("failed");
  });

  it("treats an unrelated 409 as a plain failure", () => {
    const error = mutationError({ status: 409, data: { error: "name already exists" }, idempotencyKey: KEY });
    expect(classifyAdminMutationFailure(error, KEY)).toBe("failed");
  });

  it("treats an ordinary 4xx as a plain failure", () => {
    expect(classifyAdminMutationFailure(mutationError({ status: 400 }), KEY)).toBe("failed");
  });

  it("treats network, timeout and aborted transport failures as unknown", () => {
    for (const kind of ["network", "timeout", "aborted"] as const) {
      expect(classifyAdminMutationFailure(new RequestFailure(kind, "/api/admin", "transport"), KEY)).toBe("unknown");
    }
  });

  it("treats a parse-class transport failure and a plain Error as failures", () => {
    expect(classifyAdminMutationFailure(new RequestFailure("parse", "/api/admin", "bad json"), KEY)).toBe("failed");
    expect(classifyAdminMutationFailure(new Error("nope"), KEY)).toBe("failed");
    expect(classifyAdminMutationFailure("nope", KEY)).toBe("failed");
  });
});

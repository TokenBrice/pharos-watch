import { describe, expect, it } from "vitest";
import { describeError, toErrorMessage } from "../error-utils";
import { ErrorDescriptorSchema } from "../../types/error";

describe("toErrorMessage", () => {
  it("preserves ordinary Error and platform accessor messages", () => {
    expect(toErrorMessage(new Error("error message"))).toBe("error message");
    expect(describeError(new DOMException("request timed out", "TimeoutError"))).toMatchObject({
      name: "TimeoutError",
      message: "request timed out",
    });
  });

  it("preserves cause messages without reading a lazy stack", () => {
    let stackReads = 0;
    const error = new Error("outer", { cause: new Error("inner") });
    Object.defineProperty(error, "stack", {
      get() { stackReads++; return "diagnostic stack"; },
    });

    expect(toErrorMessage(error)).toBe("outer; cause: inner");
    expect(stackReads).toBe(0);
    expect(describeError(error)).toMatchObject({
      message: "outer; cause: inner",
      stack: "diagnostic stack",
    });
    expect(stackReads).toBe(1);
  });

  it("preserves own codes on Error subclasses", () => {
    class NetworkError extends Error {
      readonly code = "NETWORK_DOWN";
    }
    expect(describeError(new NetworkError("network down"))).toMatchObject({
      name: "Error",
      message: "network down",
      code: "NETWORK_DOWN",
    });
  });

  it("describes primitives and only error-shaped object fields", () => {
    expect(toErrorMessage("string message")).toBe("string message");
    expect(toErrorMessage(null)).toBe("null");
    expect(toErrorMessage({ message: "object message" })).toBe("object message");
    expect(toErrorMessage({})).toBe("Non-error value thrown");
  });

  it("summarizes blank errors, causes, nested and empty aggregates", () => {
    expect(toErrorMessage(new Error("   "))).toBe("Error (no message)");
    const error = new Error("D1 failed", { cause: new Error("constraint violation") });
    expect(describeError(error)).toMatchObject({
      message: "D1 failed; cause: constraint violation",
      cause: { message: "constraint violation" },
    });
    const aggregate = new AggregateError([error, new AggregateError([], "")], "batch failed");
    const descriptor = describeError(aggregate);
    expect(descriptor.message).toContain("constraint violation");
    expect(descriptor.errors?.[1].message).toBe("AggregateError (no message)");
    expect(descriptor.errors?.[0].stack).toBeUndefined();
    expect(ErrorDescriptorSchema.safeParse(descriptor).success).toBe(true);
  });

  it("never executes non-Error getters, coercion or serialization hooks", () => {
    let calls = 0;
    const hostile = {
      get message() { calls++; throw new Error("getter"); },
      toString() { calls++; throw new Error("coercion"); },
      toJSON() { calls++; throw new Error("json"); },
    };
    expect(describeError(hostile).message).toBe("Non-error value thrown");
    expect(describeError(Object.create({ message: "inherited message" })).message).toBe("Non-error value thrown");
    expect(describeError(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("proxy"); } })).message).toBeTruthy();
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(describeError(proxy).message).toBeTruthy();
    expect(calls).toBe(0);
    expect(toErrorMessage(undefined)).toBe("undefined");
    expect(toErrorMessage(12n)).toBe("12");
    expect(toErrorMessage(Symbol("failure"))).toBe("Symbol(failure)");
  });

  it("guards cycles and shares the node/depth/aggregate budget", () => {
    const cycle: { message: string; cause?: unknown } = { message: "cycle" };
    cycle.cause = cycle;
    expect(describeError(cycle).cause).toMatchObject({ message: "Circular error", truncated: true });
    const branch = new AggregateError(Array.from({ length: 8 }, () => new AggregateError([new Error("leaf")], "branch")), "root");
    const descriptor = describeError(branch);
    let count = 0;
    const walk = (node: typeof descriptor, depth: number) => {
      count++;
      expect(depth).toBeLessThanOrEqual(3);
      expect(node.errors?.length ?? 0).toBeLessThanOrEqual(5);
      if (node.cause) walk(node.cause, depth + 1);
      node.errors?.forEach((child) => walk(child, depth + 1));
    };
    walk(descriptor, 0);
    expect(count).toBeLessThanOrEqual(12);
    expect(descriptor.truncated).toBe(true);
  });

  it("sanitizes every string before applying output bounds", () => {
    const error = {
      name: "secret".repeat(100), code: "secret".repeat(100),
      message: "secret".repeat(1000), stack: "secret".repeat(1000),
      cause: { message: "secret child" },
    };
    const descriptor = describeError(error, (text) => text.replaceAll("secret", "[redacted]"));
    expect(JSON.stringify(descriptor)).not.toContain("secret");
    expect(descriptor.message).toHaveLength(500);
    expect(descriptor.stack).toHaveLength(800);
    expect(descriptor.name).toHaveLength(100);
    expect(descriptor.code).toHaveLength(100);
    expect(descriptor.cause?.message).toBe("[redacted] child");
    expect(descriptor.truncated).toBe(true);
  });
});

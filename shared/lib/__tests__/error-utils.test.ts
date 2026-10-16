import { describe, expect, it } from "vitest";
import { describeError, toErrorMessage } from "../error-utils";

describe("toErrorMessage", () => {
  it("leaves lazy stacks untouched for message-only extraction but preserves full diagnostics", () => {
    let stackReads = 0;
    const error = new Error("request failed", { cause: new Error("secret detail") });
    Object.defineProperty(error, "stack", {
      get() {
        stackReads++;
        return "Error: request failed\n    at publication";
      },
    });
    expect(toErrorMessage(error, (text) => text.replaceAll("secret", "[redacted]")))
      .toBe("request failed; cause: [redacted] detail");
    expect(stackReads).toBe(0);
    expect(describeError(error)).toMatchObject({
      message: "request failed; cause: secret detail",
      stack: "Error: request failed\n    at publication",
    });
    expect(stackReads).toBe(1);
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

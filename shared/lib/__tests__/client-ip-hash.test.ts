import { describe, expect, it } from "vitest";
import { hashClientIp } from "../client-ip-hash";

describe("hashClientIp", () => {
  it("is deterministic for one IP and pepper", async () => {
    const first = await hashClientIp("203.0.113.42", "pepper-a");
    const second = await hashClientIp("203.0.113.42", "pepper-a");

    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
  });

  it("separates the same IP across peppers", async () => {
    const first = await hashClientIp("203.0.113.42", "pepper-a");
    const second = await hashClientIp("203.0.113.42", "pepper-b");

    expect(second).not.toBe(first);
  });
});

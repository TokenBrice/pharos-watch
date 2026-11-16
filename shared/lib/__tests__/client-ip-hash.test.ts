import { describe, expect, it } from "vitest";
import { clientAddressLimiterSubject, hashClientIp } from "../client-ip-hash";

describe("hashClientIp", () => {
  it.each([
    ["203.0.113.42", "203.0.113.42"],
    ["2001:db8:abcd:12::1", "2001:db8:abcd:12::/64"],
    ["2001:0DB8:ABCD:0012:ffff:ffff:ffff:ffff", "2001:db8:abcd:12::/64"],
    ["2001:db8:abcd:13::1", "2001:db8:abcd:13::/64"],
    ["::1", "::/64"], ["::", "::/64"],
    ["::ffff:192.0.2.128", "192.0.2.128"], ["0:0:0:0:0:FFFF:c000:0280", "192.0.2.128"],
    ["garbage", null], ["256.1.2.3", null], ["012.1.2.3", null], ["1.2.3", null],
    ["2001::db8::1", null], ["fe80::1%eth0", null], ["[::1]", null], ["::1/path", null], [null, null],
  ])("normalizes limiter subject %s", (input, subject) => {
    expect(clientAddressLimiterSubject(input)).toBe(subject);
  });
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

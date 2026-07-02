import { describe, expect, it } from "vitest";

import { isChromelessPath } from "@/lib/chromeless-routes";

describe("isChromelessPath", () => {
  it("matches the Telegram Mini App route family only", () => {
    expect(isChromelessPath("/pharoswatchbot/app")).toBe(true);
    expect(isChromelessPath("/pharoswatchbot/app/")).toBe(true);
    expect(isChromelessPath("/pharoswatchbot/app/settings")).toBe(true);
    expect(isChromelessPath("/pharoswatchbot")).toBe(false);
    expect(isChromelessPath("/pharoswatchbot/application")).toBe(false);
    expect(isChromelessPath("/")).toBe(false);
    expect(isChromelessPath(null)).toBe(false);
  });
});

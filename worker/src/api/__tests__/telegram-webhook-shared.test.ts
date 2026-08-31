import { describe, expect, it } from "vitest";
import { HELP_MESSAGE, START_MESSAGE } from "../telegram-webhook-shared";

describe("HELP_MESSAGE", () => {
  it("advertises /forget so users can discover the deletion command", () => {
    expect(HELP_MESSAGE).toContain("/forget");
  });

  it("still lists /set as the canonical tuning command (sanity)", () => {
    expect(HELP_MESSAGE).toContain("/set");
  });

  it("advertises the private daily recap controls", () => {
    expect(HELP_MESSAGE).toContain("/recap");
    expect(HELP_MESSAGE).toContain("private daily watchlist recap");
  });
});

describe("START_MESSAGE", () => {
  it("mentions /forget so first-time users discover the deletion command", () => {
    expect(START_MESSAGE).toContain("/forget");
  });
});

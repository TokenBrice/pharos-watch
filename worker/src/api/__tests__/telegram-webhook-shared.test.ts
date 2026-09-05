import { describe, expect, it } from "vitest";
import { TELEGRAM_ALERT_FAMILIES } from "@shared/lib/telegram-alert-families";
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

  it("advertises the pause and watchlist portability commands", () => {
    expect(HELP_MESSAGE).toContain("/pause");
    expect(HELP_MESSAGE).toContain("/export");
    expect(HELP_MESSAGE).toContain("/import");
  });

  it("enumerates every registered alert family in the subscribe row", () => {
    // The canonical family manifest has six families; the subscribe help row
    // derives its token list from it, so a new family cannot be omitted.
    const subscribeRow = HELP_MESSAGE.split("\n").find((line) =>
      line.startsWith("Enable alert types ("),
    );
    expect(subscribeRow).toBeDefined();
    for (const family of TELEGRAM_ALERT_FAMILIES) {
      expect(subscribeRow).toContain(family.key);
    }
  });
  it("escapes syntax placeholders for Telegram HTML parse mode", () => {
    expect(HELP_MESSAGE).toContain("/subscribe &lt;types&gt; &lt;targets&gt;");
    expect(HELP_MESSAGE).not.toContain("<types>");
    expect(HELP_MESSAGE).not.toContain("<targets>");
    expect(HELP_MESSAGE).not.toContain("<ticker>");
  });

  it("stays within Telegram's 4096-character message limit", () => {
    const visible = HELP_MESSAGE.replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
    expect(visible.length).toBeLessThanOrEqual(4096);
    expect(HELP_MESSAGE.length).toBeLessThanOrEqual(4096);
  });
});

describe("START_MESSAGE", () => {
  it("mentions /forget so first-time users discover the deletion command", () => {
    expect(START_MESSAGE).toContain("/forget");
  });

  it("lists every registered alert family in the onboarding copy", () => {
    // Derived from the canonical family manifest; reserve and freeze must not
    // silently disappear from onboarding again.
    for (const family of TELEGRAM_ALERT_FAMILIES) {
      expect(START_MESSAGE).toContain(`- <b>${family.key}</b>`);
    }
  });
});

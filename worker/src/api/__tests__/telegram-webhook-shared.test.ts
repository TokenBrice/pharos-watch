import { describe, expect, it } from "vitest";
import { HELP_MESSAGE } from "../telegram-webhook-shared";

describe("HELP_MESSAGE", () => {
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

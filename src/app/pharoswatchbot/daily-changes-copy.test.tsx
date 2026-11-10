import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AlertControls } from "./landing-sections";
import { DAILY_CHANGES_TIME, TELEGRAM_FAQ } from "./telegram-content";
import { buildTelegramPageJsonLd } from "./telegram-json-ld";

const QUALIFIED_TIME = `${DAILY_CHANGES_TIME} UTC unless you set a time zone`;

describe("daily Changes timing copy", () => {
  it("names the UTC default on the landing alert controls", () => {
    const html = renderToStaticMarkup(<AlertControls />);
    expect(html).toContain(QUALIFIED_TIME);
  });

  it("keeps the same qualifier on the FAQ answer and structured data", () => {
    const copy = JSON.stringify([TELEGRAM_FAQ, buildTelegramPageJsonLd("https://pharos.watch")]);
    expect(copy).toContain(QUALIFIED_TIME);
    expect(copy).not.toMatch(/local time|your time/i);
  });
});

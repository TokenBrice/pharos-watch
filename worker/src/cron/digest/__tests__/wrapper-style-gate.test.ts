import { describe, expect, it } from "vitest";
import { buildTelegramMessage } from "../../../telegram/delivery/telegram";
import { scanTelegramDigestWrapper } from "../wrapper-style-gate";

describe("scanTelegramDigestWrapper", () => {
  it("masks a model-owned Standing paragraph lifted into the blockquote", () => {
    const extended = "Standing: USDT has been off peg for three weeks.\n\n"
      + "USDT is a safe haven claim the desk will not repeat.";
    const rendered = buildTelegramMessage("Calm Drift", extended, "2026-11-01", 179, null, null);

    expect(scanTelegramDigestWrapper({
      rendered,
      modelTitle: "Calm Drift",
      modelExtended: extended,
      cemeteryAppendixHtml: null,
    })).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  shouldRecordTelegramDispatchFailure,
} from "../dispatch-telegram-result";
import { TelegramSendOriginatedError } from "../../lib/telegram/transport-errors";

describe("shouldRecordTelegramDispatchFailure", () => {
  it("does not attribute a snapshot write failure after a successful drain to Telegram", () => {
    expect(shouldRecordTelegramDispatchFailure(
      new Error("snapshot write failed"),
      undefined,
      true,
    )).toBe(false);
  });

  it("records only errors thrown by the Telegram send call", () => {
    expect(shouldRecordTelegramDispatchFailure(
      new TelegramSendOriginatedError("send threw"),
      undefined,
      true,
    )).toBe(true);
  });
});

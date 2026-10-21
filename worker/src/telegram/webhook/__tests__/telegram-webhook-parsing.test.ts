import { describe, expect, it } from "vitest";
import { parseCommand, parseStartPayload } from "../telegram-webhook-parsing";

describe("parseCommand", () => {
  it("normalizes addressed group commands while preserving the bot mention", () => {
    expect(parseCommand("/subscribe@PharosWatchBot dews usd-top25")).toEqual({
      command: "/subscribe",
      args: "dews usd-top25",
      botMention: "pharoswatchbot",
    });
  });

  it.each(["\n", "\t", "   ", "\r\n"])("splits the command at whitespace %j", (separator) => {
    for (const mention of ["", "@PharosWatchBot", "@OtherBot", "@Pharos_Watch"]) {
      expect(parseCommand(`/subscribe${mention}${separator}dews USDC`)).toEqual({
        command: "/subscribe",
        args: "dews USDC",
        botMention: mention ? mention.slice(1).toLowerCase() : null,
      });
    }
  });

  it("does not join command or bot-name fragments across whitespace", () => {
    expect(parseCommand("/sub\tscribe dews USDC")).toEqual({
      command: "/sub", args: "scribe dews USDC", botMention: null,
    });
    expect(parseCommand("/subscribe@Pharos\tWatchBot dews USDC")).toEqual({
      command: "/subscribe", args: "WatchBot dews USDC", botMention: "pharos",
    });
  });

  it("keeps unaddressed commands distinguishable from addressed commands", () => {
    expect(parseCommand("/help")).toEqual({
      command: "/help",
      args: "",
      botMention: null,
    });
  });
});

describe("parseStartPayload", () => {
  it("returns none for empty payload", () => {
    expect(parseStartPayload("")).toEqual({ kind: "none" });
    expect(parseStartPayload("   ")).toEqual({ kind: "none" });
  });

  it("returns setup for the setup keyword", () => {
    expect(parseStartPayload("setup")).toEqual({ kind: "setup" });
    expect(parseStartPayload("SETUP")).toEqual({ kind: "setup" });
  });

  it("treats retired pw1 landing tokens as a plain /start", () => {
    expect(parseStartPayload("pw1_landing_hero")).toEqual({ kind: "none" });
    expect(parseStartPayload("pw1_landing_miniapp_home")).toEqual({ kind: "none" });
    expect(parseStartPayload("pw1_landing_arbitrary")).toEqual({ kind: "none" });
  });

  it("returns sample for the sample keyword (case-insensitive) only", () => {
    expect(parseStartPayload("sample")).toEqual({ kind: "sample" });
    expect(parseStartPayload("SAMPLE")).toEqual({ kind: "sample" });
    expect(parseStartPayload("sampleX")).toEqual({ kind: "none" });
    expect(parseStartPayload("sample_")).toEqual({ kind: "none" });
  });

  it("translates sub_<types>_<targets> into subscribe args", () => {
    expect(parseStartPayload("sub_dews-depeg_usd-top25")).toEqual({
      kind: "subscribe",
      args: "dews depeg usd-top25",
    });
    expect(parseStartPayload("sub_dews_USDC")).toEqual({
      kind: "subscribe",
      args: "dews usdc",
    });
  });

  it("returns status/why/coverage payloads with their coin id", () => {
    expect(parseStartPayload("status_usdc-circle")).toEqual({
      kind: "status",
      coinId: "usdc-circle",
    });
    expect(parseStartPayload("why_dai-makerdao")).toEqual({
      kind: "why",
      coinId: "dai-makerdao",
    });
    expect(parseStartPayload("coverage_usdt-tether")).toEqual({
      kind: "coverage",
      coinId: "usdt-tether",
    });
  });

  it("rejects payloads with disallowed characters", () => {
    expect(parseStartPayload("status_usdc circle")).toEqual({ kind: "none" });
    expect(parseStartPayload("status_usdc.circle")).toEqual({ kind: "none" });
    expect(parseStartPayload("status_usdc/circle")).toEqual({ kind: "none" });
  });

  it("rejects payloads longer than 64 characters", () => {
    const long = `status_${"a".repeat(60)}`;
    expect(parseStartPayload(long)).toEqual({ kind: "none" });
  });

  it("returns none for unknown prefixes or malformed sub payloads", () => {
    expect(parseStartPayload("foo_bar")).toEqual({ kind: "none" });
    expect(parseStartPayload("sub_usdc")).toEqual({ kind: "none" });
    expect(parseStartPayload("sub_dews")).toEqual({ kind: "none" });
    expect(parseStartPayload("sub__usd-top25")).toEqual({ kind: "none" });
    expect(parseStartPayload("status_")).toEqual({ kind: "none" });
  });
});

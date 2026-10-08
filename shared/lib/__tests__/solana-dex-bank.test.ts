import { describe, expect, it } from "vitest";

import { SolanaDexBankCaptureSchema } from "../../types/solana-dex-bank";

function captureWithData(dataBase64: string) {
  return {
    schemaVersion: "solana-dex-bank-v1",
    chain: "solana",
    profileId: "orca-whirlpool-exact-v1",
    poolAddress: "A".repeat(32),
    slot: 1,
    scoreEligible: false,
    programClosureComplete: false,
    independentExecution: false,
    accounts: ["A", "B", "C"].map((character) => ({
      address: character.repeat(32),
      account: { owner: "D".repeat(32), dataBase64 },
    })),
  };
}

describe("Solana bank receipt base64 data", () => {
  it.each([
    ["empty", ""], ["unpadded", "AAAA"], ["two padding characters", "AQ=="],
    ["one padding character", "AQI="], ["full alphabet", "+/8="], ["multiple groups", "AAAAAQ=="],
    ["size boundary", "A".repeat(21848)],
  ])("accepts valid base64 (%s)", (_label, data) => {
    expect(SolanaDexBankCaptureSchema.safeParse(captureWithData(data)).success).toBe(true);
  });

  it.each([
    ["one character", "A"], ["incomplete group", "AAA"], ["too much padding", "A==="],
    ["padding alone", "===="], ["short padded group", "AA="], ["extra padding", "AAAA="],
    ["interior padding", "AA=A"], ["URL-safe alphabet", "AA-_"], ["whitespace", "AA A"],
    ["oversized", "A".repeat(21852)], ["large invalid suffix", `${"A".repeat(21847)}!`],
    ["incomplete before newline", "AAA\n"], ["embedded newline", "AA\nAA"],
    ["terminal newline", "AAAA\n"], ["terminal CRLF", "AQ==\r\n"],
    ["terminal Unicode line separator", "AQI=\u2028"],
  ])("rejects invalid base64 (%s)", (_label, data) => {
    expect(SolanaDexBankCaptureSchema.safeParse(captureWithData(data)).success).toBe(false);
  });
});

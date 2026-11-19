import { readFileSync } from "node:fs";
import { assertDonationCreditContinuity, TransferDonationsFileSchema } from "../../shared/lib/funding/schema";
import { runDirectCli } from "../lib/cli-args.mjs";

runDirectCli(import.meta.url, () => {
  const previous = TransferDonationsFileSchema.parse(JSON.parse(readFileSync(0, "utf8")));
  const next = TransferDonationsFileSchema.parse(JSON.parse(readFileSync("shared/data/funding/donations.json", "utf8")));
  assertDonationCreditContinuity(previous, next);
});

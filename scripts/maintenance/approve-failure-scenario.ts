import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  FailureScenariosByIdSchema,
  computeFailureScenarioContentHash,
} from "@shared/lib/failure-scenarios";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  assertCliUsage, parseStrictCliArgs, requireCliString, runDirectCli, writeCliHelpIfRequested,
} from "../lib/cli-args.mjs";

const USAGE = "Usage: npm run scenarios:approve -- <coinId> --reviewer <name> [--yes]\nMaintainer only: approve the exact scenario content once. Agents must never run this command.";

runDirectCli(import.meta.url, async () => {
  const { values, positionals } = parseStrictCliArgs(process.argv.slice(2), {
    allowPositionals: true,
    options: { reviewer: { type: "string" }, yes: { type: "boolean" } },
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  assertCliUsage(positionals.length === 1, "Exactly one coinId is required");
  const coinId = positionals[0]!;
  const reviewer = requireCliString(values.reviewer, "--reviewer");
  assertCliUsage(reviewer === reviewer.trim(), "Reviewer must not have surrounding whitespace");
  const path = resolve("data/failure-scenarios.json");
  const original = readFileSync(path, "utf8");
  const all = FailureScenariosByIdSchema.parse(JSON.parse(original));
  assertCliUsage(Object.hasOwn(all, coinId), `No scenario for ${coinId}`);
  const scenario = all[coinId]!;
  if (scenario.falsifiers.some((falsifier) => falsifier.status === "met")) {
    throw new Error("Cannot approve a scenario with a met falsifier; revise and verify the scenario first");
  }
  const { review: _review, ...content } = scenario;
  const contentSha256 = computeFailureScenarioContentHash(scenario);
  console.log(`Scenario: ${coinId}\nReviewer: ${reviewer}\nCanonical content (review excluded):`);
  console.log(stableJsonStringifyV1(content));
  console.log(`SHA-256: ${contentSha256}`);
  if (values.yes !== true) {
    assertCliUsage(process.stdin.isTTY === true && process.stdout.isTTY === true, "Interactive confirmation requires a TTY; use --yes only for intentional maintainer approval");
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    let answer: string;
    try {
      answer = await prompt.question(`Type "approve ${coinId}" to approve this exact content: `);
    } finally {
      prompt.close();
    }
    if (answer !== `approve ${coinId}`) throw new Error("Approval cancelled; no file changed");
  }
  if (readFileSync(path, "utf8") !== original) {
    throw new Error("Scenario file changed during confirmation; review the new content and run approval again");
  }
  const now = new Date();
  scenario.review = {
    status: "approved",
    reviewedBy: reviewer,
    reviewedAt: now.toISOString(),
    contentSha256,
  };
  writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`);
  console.log(`Approved ${coinId}; reviewed at ${scenario.review.reviewedAt}.`);
}, { label: "scenarios:approve", usage: USAGE });

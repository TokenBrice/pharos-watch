import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FailureScenariosByIdSchema, failureScenarioApprovalIssues } from "@shared/lib/failure-scenarios";
import { parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";

const USAGE = "Usage: npm run check:failure-scenarios\nValidate scenario schemas, references, and current approvals (drafts allowed).";

export function checkFailureScenarios(input: unknown, now: Date): string[] {
  const parsed = FailureScenariosByIdSchema.safeParse(input);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  }
  return Object.entries(parsed.data).flatMap(([coinId, scenario]) =>
    scenario.review.status === "approved"
      ? failureScenarioApprovalIssues(scenario, now).map((issue) => `${coinId}: ${issue}`)
      : [],
  );
}

runDirectCli(import.meta.url, () => {
  const { values } = parseStrictCliArgs(process.argv.slice(2));
  if (writeCliHelpIfRequested(values, USAGE)) return;
  const data: unknown = JSON.parse(readFileSync(resolve("data/failure-scenarios.json"), "utf8"));
  const issues = checkFailureScenarios(data, new Date());
  if (issues.length > 0) throw new Error(`Failure scenario validation failed:\n${issues.join("\n")}`);
  console.log("Failure scenarios validated (drafts permitted; approved records current and content-bound).");
}, { label: "check:failure-scenarios", usage: USAGE });

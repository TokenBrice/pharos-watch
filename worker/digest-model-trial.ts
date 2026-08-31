/**
 * Offline model/effort trial for the digest LLM call.
 *
 * Measures the two quantities that decide whether a model+effort configuration
 * holds the daily cost ceiling, neither of which is observable in production
 * today because no token usage is persisted anywhere:
 *
 *   1. Total output tokens per edition (thinking + text). Thinking bills as
 *      output, so this is the whole cost story.
 *   2. The corrective-retry rate `p`. A retried edition is two full billable
 *      calls, which moves the break-even ceiling by more than 2x.
 *
 * Production equivalence matters here, because the retry rate is only
 * meaningful if the prompt and the validator see what production would give
 * them. So this replays REAL archived inputs through the REAL prompt builders,
 * the REAL critical-lead requirement builder, and the REAL quality validator:
 *
 *   - recent-edition variety context comes from the FULL public archive
 *     (7 predecessors by generatedAt), not from the trial slice, so the oldest
 *     trial edition still gets 7 predecessors;
 *   - `buildCriticalDailyLeadRequirements` runs with the archived
 *     `prevInputData` and a production-width 14-entry lead-signal history;
 *   - the validation profile carries depeg facts, previous depeg facts, and the
 *     trailing 30 titles, so the numeric-consistency and title-dedupe lints are
 *     live rather than dormant;
 *   - the weekly recap is built and called SEPARATELY via
 *     `buildWeeklyInputData` / `buildWeeklyPrompt`, never estimated as daily.
 *
 * It never writes to D1, never posts to any channel, and never publishes.
 *
 * Usage, from the `worker/` directory:
 *   bun run digest-model-trial.ts --dry-run
 *   bun run digest-model-trial.ts --model claude-fable-5 --effort medium \
 *     --max-tokens 12000 --editions 6
 *
 * ANTHROPIC_API_KEY and PHAROS_API_KEY are read from the environment or from
 * ../.env.local. Neither is ever logged.
 */

import { readFile } from "node:fs/promises";
import { buildUserPrompt, SYSTEM_PROMPT } from "./src/cron/daily-digest/prompt";
import { buildCriticalDailyLeadRequirements } from "./src/cron/daily-digest/critical-lead-requirements";
import {
	formatDigestValidationIssues,
	parseDigestModelResponse,
	validateDigestModelOutput,
	type DigestValidationIssue,
	type DigestValidationProfile,
} from "./src/cron/daily-digest/response";
import { tryParseJson } from "./src/lib/json-parse";
import { buildWeeklyInputData } from "./src/cron/weekly-recap/input-data";
import {
	buildWeeklyLeadRequirements,
	buildWeeklyPrompt,
	WEEKLY_SYSTEM_PROMPT,
} from "./src/cron/weekly-recap/prompt";
import type { DigestInputData } from "@shared/types/digest";
import type { DailyDigestSourceRow } from "./src/cron/weekly-recap/types";

const PRICES: Record<string, { input: number; output: number }> = {
	"claude-fable-5": { input: 10, output: 50 },
	"claude-mythos-5": { input: 10, output: 50 },
	"claude-opus-5": { input: 5, output: 25 },
	"claude-opus-4-8": { input: 5, output: 25 },
	"claude-sonnet-5": { input: 2, output: 10 },
};

/** Production passes 14 prior lead-signal ids; the public archive omits digest_meta. */
const LEAD_HISTORY_WIDTH = 14;
/** Production's long-window title-dedupe bound. */
const TITLE_WINDOW = 30;

interface Options {
	model: string;
	effort: string;
	maxTokens: number;
	editions: number;
	/** Explicit edition dates; overrides `editions` when non-empty. */
	dates: string[];
	dryRun: boolean;
	skipWeekly: boolean;
	/** Suppress the real corrective retry (retry cost stays modelled, not measured). */
	noRetry: boolean;
}

/**
 * `/api/digest-archive` shape. Note it carries no `date`: the edition date is
 * the UTC day of `generatedAt` (generation runs at 08:05 UTC).
 */
interface ArchiveEntry {
	digestTitle: string | null;
	digestText: string;
	digestExtended: string | null;
	generatedAt: number;
	digestType: string;
	editionNumber: number | null;
}

const utcDate = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

interface Snapshot {
	inputData?: DigestInputData;
	prevInputData?: DigestInputData;
}

interface RetryOutcome {
	inputTokens: number;
	outputTokens: number;
	resolved: boolean;
	remainingHardIssues: string[];
	costUsd: number;
}

interface CallOutcome {
	label: string;
	inputTokens: number;
	outputTokens: number;
	stopReason: string | null;
	refusalCategory: string | null;
	hardIssues: DigestValidationIssue[];
	softIssues: DigestValidationIssue[];
	costUsd: number;
	seconds: number;
	/** Populated only when hard issues fired and the real corrective retry ran. */
	retry: RetryOutcome | null;
	text: string;
}

function parseArgs(argv: readonly string[]): Options {
	const read = (flag: string): string | undefined => {
		const index = argv.indexOf(flag);
		return index >= 0 ? argv[index + 1] : undefined;
	};
	return {
		model: read("--model") ?? "claude-fable-5",
		effort: read("--effort") ?? "medium",
		maxTokens: Number(read("--max-tokens") ?? 12000),
		// Default to exactly ONE paid call: one daily, no weekly. Every edition
		// and the weekly are real billed generations, so widen deliberately with
		// --editions N / --dates and --include-weekly after reading the result.
		editions: Number(read("--editions") ?? 1),
		// Explicit worst-case-first selection beats recent-first: see
		// digest-difficulty-rank.ts. Overrides --editions when present.
		dates: (read("--dates") ?? "").split(",").map((part) => part.trim()).filter(Boolean),
		dryRun: argv.includes("--dry-run"),
		skipWeekly: !argv.includes("--include-weekly"),
		noRetry: argv.includes("--no-retry"),
	};
}

async function readTextOrNull(path: "../.env.local" | ".dev.vars"): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

/**
 * Reads a secret from the environment, then from the two known dotenv files.
 * Parsed line-by-line rather than with a constructed RegExp so the lookup name
 * is never interpolated into a pattern, and the two candidate paths are fixed
 * literals rather than caller-supplied.
 */
async function resolveSecret(name: string): Promise<string | null> {
	const fromEnv = process.env[name];
	if (fromEnv && fromEnv.trim()) return fromEnv.trim();
	for (const contents of [await readTextOrNull("../.env.local"), await readTextOrNull(".dev.vars")]) {
		if (contents == null) continue;
		for (const line of contents.split("\n")) {
			const separator = line.indexOf("=");
			if (separator < 0) continue;
			if (line.slice(0, separator).trim() !== name) continue;
			const value = line.slice(separator + 1).trim().replace(/^"|"$/g, "");
			if (value) return value;
		}
	}
	return null;
}

interface StreamResult {
	inputTokens: number | null;
	outputTokens: number | null;
	stopReason: string | null;
	refusalCategory: string | null;
	text: string;
}

/**
 * Mirrors the production accumulator (`src/cron/digest/anthropic-stream.ts`)
 * but retains the usage counters production parses and discards, plus the
 * refusal fields production does not yet handle at all.
 */
async function streamMessage(response: Response): Promise<StreamResult> {
	const result: StreamResult = {
		inputTokens: null,
		outputTokens: null,
		stopReason: null,
		refusalCategory: null,
		text: "",
	};
	const reader = response.body?.getReader();
	if (!reader) throw new Error("trial: response had no body");
	const decoder = new TextDecoder();
	let buffered = "";

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffered += decoder.decode(value, { stream: true });
		const frames = buffered.split("\n\n");
		buffered = frames.pop() ?? "";
		for (const frame of frames) {
			const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
			if (!dataLine) continue;
			const payload = dataLine.slice(5).trim();
			if (!payload || payload === "[DONE]") continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(payload);
			} catch {
				continue;
			}
			if (!parsed || typeof parsed !== "object") continue;
			const frameObject = parsed as Record<string, unknown>;

			const readUsage = (candidate: unknown): void => {
				if (!candidate || typeof candidate !== "object") return;
				const usage = candidate as Record<string, unknown>;
				if (typeof usage.input_tokens === "number") result.inputTokens = usage.input_tokens;
				if (typeof usage.output_tokens === "number") result.outputTokens = usage.output_tokens;
			};
			const message = frameObject.message;
			if (message && typeof message === "object") {
				readUsage((message as Record<string, unknown>).usage);
				const stop = (message as Record<string, unknown>).stop_reason;
				if (typeof stop === "string") result.stopReason = stop;
				const details = (message as Record<string, unknown>).stop_details;
				if (details && typeof details === "object") {
					const category = (details as Record<string, unknown>).category;
					result.refusalCategory = typeof category === "string" ? category : null;
				}
			}
			readUsage(frameObject.usage);

			const delta = frameObject.delta;
			if (delta && typeof delta === "object") {
				const deltaObject = delta as Record<string, unknown>;
				if (typeof deltaObject.text === "string") result.text += deltaObject.text;
				if (typeof deltaObject.stop_reason === "string") result.stopReason = deltaObject.stop_reason;
			}
			const stopDetails = frameObject.stop_details;
			if (stopDetails && typeof stopDetails === "object") {
				const category = (stopDetails as Record<string, unknown>).category;
				if (typeof category === "string") result.refusalCategory = category;
			}
		}
	}
	return result;
}

const options = parseArgs(process.argv.slice(2));
const price = PRICES[options.model];
if (!price) throw new Error(`trial: no price table entry for ${options.model}`);

const pharosKey = await resolveSecret("PHAROS_API_KEY");
if (!pharosKey) throw new Error("trial: PHAROS_API_KEY not found (env or ../.env.local)");
const anthropicKey = await resolveSecret("ANTHROPIC_API_KEY");
if (!anthropicKey && !options.dryRun) {
	console.error(
		"trial: ANTHROPIC_API_KEY not found (env, ../.env.local, .dev.vars). Re-run with --dry-run for prompt assembly only.",
	);
	process.exit(2);
}
// Identity-linked keys (sk-ant-api03-...) reject requests without a workspace
// id. Organisation endpoints that would reveal it need an admin key, so it has
// to be supplied.
const workspaceId = await resolveSecret("ANTHROPIC_WORKSPACE_ID");

interface SingleCall {
	inputTokens: number;
	outputTokens: number;
	stopReason: string | null;
	refusalCategory: string | null;
	text: string;
	seconds: number;
}

async function callOnce(systemPrompt: string, userPrompt: string): Promise<SingleCall | { error: string }> {
	const started = Date.now();
	const response = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": anthropicKey ?? "",
			"anthropic-version": "2023-06-01",
			Accept: "text/event-stream",
			...(workspaceId ? { "anthropic-workspace-id": workspaceId } : {}),
		},
		body: JSON.stringify({
			model: options.model,
			max_tokens: options.maxTokens,
			thinking: { type: "adaptive" },
			output_config: { effort: options.effort },
			system: systemPrompt,
			messages: [{ role: "user", content: userPrompt }],
			stream: true,
		}),
		signal: AbortSignal.timeout(12 * 60_000),
	});
	if (!response.ok) return { error: `HTTP ${response.status} ${(await response.text()).slice(0, 200)}` };
	const stream = await streamMessage(response);
	return {
		inputTokens: stream.inputTokens ?? 0,
		outputTokens: stream.outputTokens ?? 0,
		stopReason: stream.stopReason,
		refusalCategory: stream.refusalCategory,
		text: stream.text,
		seconds: (Date.now() - started) / 1000,
	};
}

async function callModel(
	systemPrompt: string,
	userPrompt: string,
	profile: DigestValidationProfile,
	label: string,
): Promise<CallOutcome | null> {
	const first = await callOnce(systemPrompt, userPrompt);
	if ("error" in first) {
		console.log(`  ${label}: ${first.error}`);
		return null;
	}
	const parsed = parseDigestModelResponse(first.text);
	const issues = validateDigestModelOutput(parsed, profile);
	const hardIssues = issues.filter((issue) => issue.severity === "hard");
	const softIssues = issues.filter((issue) => issue.severity !== "hard");

	const outcome: CallOutcome = {
		label,
		inputTokens: first.inputTokens,
		outputTokens: first.outputTokens,
		stopReason: first.stopReason,
		refusalCategory: first.refusalCategory,
		hardIssues,
		softIssues,
		costUsd: (first.inputTokens * price.input + first.outputTokens * price.output) / 1e6,
		seconds: first.seconds,
		retry: null,
		text: first.text,
	};
	console.log(
		`  ${label}: in=${first.inputTokens.toLocaleString()} out=${first.outputTokens.toLocaleString()} ` +
			`stop=${outcome.stopReason ?? "null"}${outcome.refusalCategory ? ` refusal=${outcome.refusalCategory}` : ""} ` +
			`hard=${hardIssues.length}${hardIssues.length ? `(${hardIssues.map((issue) => issue.code).join(",")})` : ""} ` +
			`soft=${softIssues.length}${softIssues.length ? `(${softIssues.map((issue) => issue.code).join(",")})` : ""} ` +
			`$${outcome.costUsd.toFixed(4)} ${first.seconds.toFixed(0)}s`,
	);

	// Production fires exactly one corrective retry on hard issues, resending the
	// original prompt plus the failed response (platform.ts:256-275). Replaying it
	// converts the retry multiplier from arithmetic into measurement.
	if (hardIssues.length > 0 && !options.noRetry) {
		const retryPrompt = [
			userPrompt,
			"",
			"REVISION REQUIRED:",
			"Your previous response (below) failed these quality checks:",
			formatDigestValidationIssues(hardIssues),
			"",
			"PREVIOUS RESPONSE:",
			JSON.stringify({
				title: parsed.digestTitle,
				text: parsed.digestText,
				extended: parsed.digestExtended,
				meta: parsed.digestMeta ? tryParseJson(parsed.digestMeta, { onFailure: () => undefined }) : null,
			}),
			"",
			"Fix ONLY what the quality checks flag; keep everything else. Return ONLY corrected JSON with the same schema. Do not add markdown fences or commentary.",
		].join("\n");
		const second = await callOnce(systemPrompt, retryPrompt);
		if ("error" in second) {
			console.log(`    retry: ${second.error}`);
		} else {
			const retryParsed = parseDigestModelResponse(second.text);
			const retryHard = validateDigestModelOutput(retryParsed, profile).filter(
				(issue) => issue.severity === "hard",
			);
			const retryCost = (second.inputTokens * price.input + second.outputTokens * price.output) / 1e6;
			outcome.retry = {
				inputTokens: second.inputTokens,
				outputTokens: second.outputTokens,
				resolved: retryHard.length === 0,
				remainingHardIssues: retryHard.map((issue) => issue.code),
				costUsd: retryCost,
			};
			outcome.costUsd += retryCost;
			console.log(
				`    retry: in=${second.inputTokens.toLocaleString()} out=${second.outputTokens.toLocaleString()} ` +
					`inputGrowth=${(second.inputTokens / first.inputTokens).toFixed(3)}x ` +
					`${retryHard.length === 0 ? "RESOLVED" : `STILL BLOCKED (${retryHard.map((i) => i.code).join(",")})`} ` +
					`+$${retryCost.toFixed(4)} ${second.seconds.toFixed(0)}s`,
			);
		}
	}
	return outcome;
}

const archive = (await (
	await fetch("https://api.pharos.watch/api/digest-archive", { headers: { "X-API-Key": pharosKey } })
).json()) as { digests: ArchiveEntry[] };
const archiveDaily = archive.digests
	.filter((entry) => entry.digestType === "daily")
	.sort((a, b) => b.generatedAt - a.generatedAt);
const archiveWeekly = archive.digests.filter((entry) => entry.digestType === "weekly");

console.log(
	`trial: model=${options.model} effort=${options.effort} max_tokens=${options.maxTokens} ` +
		`dailyEditions=${options.editions}${options.dryRun ? " (DRY RUN)" : ""}`,
);
console.log(`archive: ${archiveDaily.length} daily, ${archiveWeekly.length} weekly`);

// ---------- Daily ----------
// Selection: explicit --dates (worst-case-first, from digest-difficulty-rank.ts)
// takes precedence over recent-first --editions. Requested dates that are not in
// the archive are reported, never silently replaced by recent easy editions.
let selected: ArchiveEntry[];
if (options.dates.length > 0) {
	const byDate: Record<string, ArchiveEntry> = {};
	for (const entry of archiveDaily) byDate[utcDate(entry.generatedAt)] = entry;
	selected = [];
	const missing: string[] = [];
	for (const date of options.dates) {
		const entry = byDate[date];
		if (entry) selected.push(entry);
		else missing.push(date);
	}
	console.log(`selection: ${selected.length} of ${options.dates.length} requested dates found in archive`);
	if (missing.length > 0) console.log(`  MISSING (not run): ${missing.join(", ")}`);
	if (selected.length === 0) {
		console.error("selection: none of the requested dates exist in the archive; refusing to fall back to recent editions");
		process.exit(3);
	}
} else {
	selected = archiveDaily.slice(0, options.editions);
	console.log(`selection: ${selected.length} most recent daily edition(s)`);
}

const dailyOutcomes: CallOutcome[] = [];
for (const target of selected) {
	const targetDate = utcDate(target.generatedAt);
	const snapshot = (await (
		await fetch(`https://api.pharos.watch/api/digest-snapshot?date=${targetDate}`, {
			headers: { "X-API-Key": pharosKey },
		})
	).json()) as Snapshot;
	if (!snapshot?.inputData) {
		console.log(`  ${targetDate}: no archived inputData, skipped`);
		continue;
	}

	// Variety context from the FULL archive, so trial-set size cannot starve it.
	const predecessors = archiveDaily.filter((entry) => entry.generatedAt < target.generatedAt).slice(0, 7);
	const recentMeta = predecessors.map((entry) => ({
		// The public archive intentionally omits digest_meta; this is exactly the
		// buildRecentDigestMeta fallback shape when digest_meta is unavailable.
		meta: null,
		rawText: entry.digestTitle ? `${entry.digestTitle}: ${entry.digestText}` : entry.digestText,
		title: entry.digestTitle,
	}));
	const recentLeadSignalIds = new Array<string | null>(LEAD_HISTORY_WIDTH).fill(null);
	const leadRequirements = buildCriticalDailyLeadRequirements(snapshot.inputData, {
		previousInputData: snapshot.prevInputData,
		recentLeadSignalIds,
	});
	const userPrompt = buildUserPrompt(snapshot.inputData, recentMeta, {
		leadRequirements,
		recentLeadSignalIds,
	});
	const profile: DigestValidationProfile = {
		kind: "daily",
		recentMeta,
		leadRequirements,
		depegFacts: snapshot.inputData.topDepegs,
		prevDepegFacts: snapshot.prevInputData?.topDepegs ?? [],
		recentTitles: archiveDaily
			.filter((entry) => entry.generatedAt < target.generatedAt)
			.slice(0, TITLE_WINDOW)
			.map((entry) => entry.digestTitle ?? "")
			.filter(Boolean),
		forbidSafetyClaims: snapshot.inputData.safetyContext?.status === "unavailable",
	};

	if (options.dryRun) {
		console.log(
			`  ${targetDate}: prompt ${(SYSTEM_PROMPT.length + userPrompt.length).toLocaleString()} chars ` +
				`(system ${SYSTEM_PROMPT.length.toLocaleString()} + user ${userPrompt.length.toLocaleString()}), ` +
				`recent=${recentMeta.length}, leadReqs=${leadRequirements?.length ?? 0}, ` +
				`titles=${profile.recentTitles?.length ?? 0}, depegFacts=${profile.depegFacts?.length ?? 0}`,
		);
		continue;
	}
	const outcome = await callModel(SYSTEM_PROMPT, userPrompt, profile, targetDate);
	if (outcome) dailyOutcomes.push(outcome);
}

// ---------- Weekly (built and called separately, never estimated as daily) ----------
let weeklyOutcome: CallOutcome | null = null;
if (!options.skipWeekly) {
	const latestWeekly = archiveWeekly.slice().sort((a, b) => b.generatedAt - a.generatedAt)[0];
	if (!latestWeekly) {
		console.log("weekly: no weekly edition in archive, skipped");
	} else {
		const weeklyTs = latestWeekly.generatedAt;
		const weeklyDayStart = Math.floor(weeklyTs / 86_400) * 86_400;
		const weekBoundary = weeklyDayStart - 6 * 86_400;
		const cutoff = weeklyTs - 15 * 86_400;
		// Source rows are reconstructed from the archive, which carries the
		// published title/text/extended alongside generatedAt. All four fields
		// matter: buildWeeklyInputData and buildWeeklyPrompt read the copy, not
		// just the input data, so a partial row silently degrades the weekly
		// prompt (and previously crashed on digest.text).
		const rows: DailyDigestSourceRow[] = [];
		for (const entry of archiveDaily
			.filter((row) => row.generatedAt >= cutoff && row.generatedAt < weeklyDayStart + 86_400)
			.sort((a, b) => a.generatedAt - b.generatedAt)) {
			const snapshot = (await (
				await fetch(`https://api.pharos.watch/api/digest-snapshot?date=${utcDate(entry.generatedAt)}`, {
					headers: { "X-API-Key": pharosKey },
				})
			).json()) as Snapshot;
			if (!snapshot?.inputData) continue;
			rows.push({
				generated_at: entry.generatedAt,
				digest_title: entry.digestTitle,
				digest_text: entry.digestText,
				digest_extended: entry.digestExtended,
				input_data: JSON.stringify(snapshot.inputData),
			});
		}
		const currentRows = rows.filter((row) => row.generated_at >= weekBoundary);
		const priorRows = rows.filter((row) => row.generated_at < weekBoundary);
		const safetyContext =
			currentRows.length > 0
				? (JSON.parse(currentRows[currentRows.length - 1].input_data) as DigestInputData).safetyContext
				: undefined;
		const weeklyData = buildWeeklyInputData(currentRows, priorRows, safetyContext);
		if (!weeklyData) {
			console.log(`weekly: input unavailable (current=${currentRows.length}, prior=${priorRows.length})`);
		} else {
			const recentWeeklyMeta = archiveWeekly
				.filter((entry) => entry.generatedAt < weeklyTs)
				.sort((a, b) => b.generatedAt - a.generatedAt)
				.slice(0, 4)
				.map((entry) => ({
					meta: null,
					rawText: entry.digestTitle ? `${entry.digestTitle}: ${entry.digestText}` : entry.digestText,
					title: entry.digestTitle,
				}));
			const weeklyPrompt = buildWeeklyPrompt(weeklyData, recentWeeklyMeta);
			const weeklyRequirements = buildWeeklyLeadRequirements(weeklyData);
			const weeklyProfile: DigestValidationProfile = {
				kind: "weekly",
				recentMeta: recentWeeklyMeta,
				leadRequirements: weeklyRequirements,
			};
			if (options.dryRun) {
				console.log(
					`  weekly ${utcDate(weeklyTs)}: prompt ${(WEEKLY_SYSTEM_PROMPT.length + weeklyPrompt.length).toLocaleString()} chars ` +
						`(system ${WEEKLY_SYSTEM_PROMPT.length.toLocaleString()} + user ${weeklyPrompt.length.toLocaleString()}), ` +
						`currentRows=${currentRows.length}, priorRows=${priorRows.length}, leadReqs=${weeklyRequirements?.length ?? 0}`,
				);
			} else {
				weeklyOutcome = await callModel(
					WEEKLY_SYSTEM_PROMPT,
					weeklyPrompt,
					weeklyProfile,
					`weekly ${utcDate(weeklyTs)}`,
				);
			}
		}
	}
}

if (options.dryRun || dailyOutcomes.length === 0) process.exit(0);

const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const outputs = dailyOutcomes.map((outcome) => outcome.outputTokens).sort((a, b) => a - b);
const percentile = (fraction: number) =>
	outputs[Math.min(outputs.length - 1, Math.floor(outputs.length * fraction))];
const retried = dailyOutcomes.filter((outcome) => outcome.hardIssues.length > 0).length;
const retryRate = retried / dailyOutcomes.length;
const truncated = dailyOutcomes.filter((outcome) => outcome.stopReason === "max_tokens").length;
const refused = dailyOutcomes.filter((outcome) => outcome.stopReason === "refusal").length;
const meanDailyInput = mean(dailyOutcomes.map((outcome) => outcome.inputTokens));

// Retry cost: use MEASURED second-call usage where a real retry ran, and fall
// back to the modelled 1.06x-input / 1x-output shape only where it did not.
const measuredRetries = dailyOutcomes.filter((outcome) => outcome.retry !== null);
const meanRetryCost =
	measuredRetries.length > 0
		? mean(measuredRetries.map((outcome) => outcome.retry?.costUsd ?? 0))
		: null;
const editionCost = (inputTokens: number, outputTokens: number, p: number) => {
	const base = (inputTokens * price.input + outputTokens * price.output) / 1e6;
	const retry =
		meanRetryCost ??
		(inputTokens * 1.06 * price.input + outputTokens * price.output) / 1e6;
	return base + p * retry;
};

console.log("\n=== DAILY ===");
console.log(`editions measured:       ${dailyOutcomes.length}`);
console.log(`input tokens (mean):     ${Math.round(meanDailyInput).toLocaleString()}`);
console.log(
	`output tokens:           mean ${Math.round(mean(outputs)).toLocaleString()}  p50 ${percentile(0.5).toLocaleString()}  p95 ${percentile(0.95).toLocaleString()}  max ${outputs[outputs.length - 1].toLocaleString()}`,
);
console.log(`hard-issue (retry) rate: ${retried}/${dailyOutcomes.length} = ${(retryRate * 100).toFixed(1)}%`);
if (retried > 0) {
	const codes = dailyOutcomes.flatMap((outcome) => outcome.hardIssues.map((issue) => issue.code));
	console.log(`  hard issue codes:      ${codes.join(", ")}`);
}
if (measuredRetries.length > 0) {
	console.log(`  MEASURED retries:      ${measuredRetries.length}`);
	for (const outcome of measuredRetries) {
		const retry = outcome.retry;
		if (!retry) continue;
		console.log(
			`    ${outcome.label}: retry in=${retry.inputTokens.toLocaleString()} out=${retry.outputTokens.toLocaleString()} ` +
				`inputGrowth=${(retry.inputTokens / outcome.inputTokens).toFixed(3)}x cost=$${retry.costUsd.toFixed(4)} ` +
				`${retry.resolved ? "resolved" : `still blocked (${retry.remainingHardIssues.join(",")})`}`,
		);
	}
	console.log(`  mean measured retry cost: $${(meanRetryCost ?? 0).toFixed(4)} (used in the projections below)`);
} else {
	console.log(`  no hard issues fired, so retry cost remains MODELLED (1.06x input + 1x output), not measured`);
}
const allSoft = dailyOutcomes.flatMap((outcome) => outcome.softIssues.map((issue) => issue.code));
if (allSoft.length > 0) {
	const softCounts: Record<string, number> = {};
	for (const code of allSoft) softCounts[code] = (softCounts[code] ?? 0) + 1;
	console.log(
		`soft issue codes:        ${Object.entries(softCounts).sort((a, b) => b[1] - a[1]).map(([code, count]) => `${code}x${count}`).join("  ")}`,
	);
}
console.log(`truncated at max_tokens: ${truncated}/${dailyOutcomes.length}`);
console.log(`refusals:                ${refused}/${dailyOutcomes.length}`);
console.log(`observed spend on trial: $${dailyOutcomes.reduce((sum, o) => sum + o.costUsd, 0).toFixed(4)}`);

// Weekly cost must scale with the SAME p as the daily leg, otherwise a
// "p=100%" row silently leaves the weekly at the observed rate and the word
// "unconditional" excludes weekly retries entirely.
const weeklyMeasuredRetryCost = weeklyOutcome?.retry?.costUsd ?? null;
const weeklyCostAtP = (p: number): number => {
	if (!weeklyOutcome) return 0;
	const base =
		(weeklyOutcome.inputTokens * price.input + weeklyOutcome.outputTokens * price.output) / 1e6;
	const retry =
		weeklyMeasuredRetryCost ??
		(weeklyOutcome.inputTokens * 1.06 * price.input + weeklyOutcome.outputTokens * price.output) / 1e6;
	return base + p * retry;
};

if (weeklyOutcome) {
	console.log("\n=== WEEKLY (measured) ===");
	console.log(
		`input=${weeklyOutcome.inputTokens.toLocaleString()} output=${weeklyOutcome.outputTokens.toLocaleString()} ` +
			`stop=${weeklyOutcome.stopReason ?? "null"} hard=${weeklyOutcome.hardIssues.length} ` +
			`soft=${weeklyOutcome.softIssues.length} $${weeklyOutcome.costUsd.toFixed(4)}`,
	);
	console.log(
		`retry cost basis: ${weeklyMeasuredRetryCost !== null ? `MEASURED $${weeklyMeasuredRetryCost.toFixed(4)}` : "MODELLED (no hard issues fired)"}`,
	);
} else {
	console.log(
		"\n=== WEEKLY ===\nNOT MEASURED (skipped or unavailable). Figures below are DAILY-ONLY; no daily+weekly claim is supported.",
	);
}

const scope = weeklyOutcome ? "daily + weekly/7" : "DAILY ONLY";
console.log(`\n=== BLENDED $/DAY (${scope}) ===`);
for (const [label, outputTokens, p] of [
	["measured retry rate, p50 output", percentile(0.5), retryRate],
	["measured retry rate, p95 output", percentile(0.95), retryRate],
	["measured retry rate, max output", outputs[outputs.length - 1], retryRate],
	["worst case p=100%, p95 output", percentile(0.95), 1],
	["worst case p=100%, max output", outputs[outputs.length - 1], 1],
] as const) {
	const total = editionCost(meanDailyInput, outputTokens, p) + weeklyCostAtP(p) / 7;
	console.log(`${label.padEnd(34)} $${total.toFixed(3)}${total <= 1.15 ? "" : "  BREACH"}`);
}

const worstOutput = outputs[outputs.length - 1];
const verdictWorst = editionCost(meanDailyInput, worstOutput, 1) + weeklyCostAtP(1) / 7;
const verdictMeasured = editionCost(meanDailyInput, worstOutput, retryRate) + weeklyCostAtP(retryRate) / 7;
console.log(
	`\nVERDICT vs $1.15/day (${scope}, worst observed output ${worstOutput.toLocaleString()} tok): ${
		verdictWorst <= 1.15
			? "HOLDS UNCONDITIONALLY (every daily AND the weekly retrying)"
			: verdictMeasured <= 1.15
				? `HOLDS ONLY AT THE MEASURED RETRY RATE (${(retryRate * 100).toFixed(0)}%) — a bet on p, not a bound`
				: "BREACHES"
	}`,
);
if (truncated > 0) {
	console.log(
		`WARNING: ${truncated} edition(s) hit max_tokens. Output was truncated, so token figures are floors and that copy would have failed the production gate.`,
	);
}
if (dailyOutcomes.length < 5) {
	console.log(`CAVEAT: ${dailyOutcomes.length} editions is a small sample; p95 is not meaningful below ~20.`);
}

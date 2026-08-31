/**
 * Ranks every archived daily edition by *editorial difficulty*, so a paid model
 * trial can spend its budget on the cases most likely to breach a token ceiling
 * rather than on whichever editions happen to be most recent.
 *
 * Rationale: thinking volume should scale with how hard the edition is to write,
 * not with the calendar. The first Fable trial landed on 2026-08-30 — a CALM,
 * BEDROCK, zero-lead-requirement day, i.e. close to the easiest edition in the
 * corpus. A margin measured there says little about a CRISIS day carrying a
 * hard critical-depeg lead requirement and a degraded collector set.
 *
 * Every input is free: archived snapshots plus the real prompt/lead builders.
 * No API call, no spend.
 *
 * Usage, from `worker/`:  bun run digest-difficulty-rank.ts [--limit N]
 */

import { readFile } from "node:fs/promises";
import { buildUserPrompt, SYSTEM_PROMPT } from "./src/cron/daily-digest/prompt";
import { buildCriticalDailyLeadRequirements } from "./src/cron/daily-digest/critical-lead-requirements";
import { classifyRegime } from "./src/cron/daily-digest/prompt/regime";
import type { DigestInputData } from "@shared/types/digest";

const LEAD_HISTORY_WIDTH = 14;
const REGIME_WEIGHT = { CRISIS: 3, TENSION: 2, WATCHFUL: 1, CALM: 0 } as const;

interface ArchiveEntry {
	digestTitle: string | null;
	digestText: string;
	digestExtended: string | null;
	generatedAt: number;
	digestType: string;
}

interface Row {
	date: string;
	regime: "CRISIS" | "TENSION" | "WATCHFUL" | "CALM";
	promptChars: number;
	leadReqs: number;
	hardLeadReqs: number;
	activeDepegs: number;
	degraded: number;
	paragraphs: number;
	safetyUnavailable: boolean;
	difficulty: number;
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

const limitFlag = process.argv.indexOf("--limit");
const limit = limitFlag >= 0 ? Number(process.argv[limitFlag + 1]) : Number.POSITIVE_INFINITY;

const pharosKey = await resolveSecret("PHAROS_API_KEY");
if (!pharosKey) throw new Error("rank: PHAROS_API_KEY not found");
const headers = { "X-API-Key": pharosKey };
const utcDate = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

const archive = (await (
	await fetch("https://api.pharos.watch/api/digest-archive", { headers })
).json()) as { digests: ArchiveEntry[] };
const daily = archive.digests
	.filter((entry) => entry.digestType === "daily")
	.sort((a, b) => b.generatedAt - a.generatedAt);
const targets = daily.slice(0, Math.min(daily.length, limit));

const rows: Row[] = [];
const failures: { date: string; reason: string }[] = [];
// Low concurrency with a retry: an earlier 8-way run silently lost 137 of 188
// editions to transient errors and reported the survivors as if complete, which
// biased the regime distribution. Failures are now recorded, never swallowed.
const CONCURRENCY = 3;

async function fetchSnapshot(
	date: string,
): Promise<{ inputData?: DigestInputData; prevInputData?: DigestInputData } | { error: string }> {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const response = await fetch(`https://api.pharos.watch/api/digest-snapshot?date=${date}`, { headers });
			if (!response.ok) {
				if (attempt < 2) {
					await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
					continue;
				}
				return { error: `HTTP ${response.status}` };
			}
			return (await response.json()) as { inputData?: DigestInputData; prevInputData?: DigestInputData };
		} catch (error) {
			if (attempt < 2) {
				await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
				continue;
			}
			return { error: String(error).slice(0, 80) };
		}
	}
	return { error: "exhausted" };
}

for (let offset = 0; offset < targets.length; offset += CONCURRENCY) {
	const batch = await Promise.all(
		targets.slice(offset, offset + CONCURRENCY).map(async (target) => {
			const date = utcDate(target.generatedAt);
			{
				const snapshot = await fetchSnapshot(date);
				if ("error" in snapshot) {
					failures.push({ date, reason: snapshot.error });
					return null;
				}
				if (!snapshot.inputData) {
					failures.push({ date, reason: "no inputData" });
					return null;
				}
				const recentLeadSignalIds = new Array<string | null>(LEAD_HISTORY_WIDTH).fill(null);
				const leadRequirements = buildCriticalDailyLeadRequirements(snapshot.inputData, {
					previousInputData: snapshot.prevInputData,
					recentLeadSignalIds,
				});
				const recent = daily
					.filter((entry) => entry.generatedAt < target.generatedAt)
					.slice(0, 7)
					.map((entry) => ({
						meta: null,
						rawText: entry.digestTitle ? `${entry.digestTitle}: ${entry.digestText}` : entry.digestText,
						title: entry.digestTitle,
					}));
				// Older archived input_data predates `safetyScores.provenance`, and
				// buildUserPrompt dereferences it unguarded (prompt.ts:278). That is a
				// replay-only limitation — production always builds from fresh input,
				// and the weekly looks back only 15 days — but it must be recorded
				// rather than silently dropping the edition from the distribution.
				let promptChars: number;
				try {
					promptChars =
						SYSTEM_PROMPT.length +
						buildUserPrompt(snapshot.inputData, recent, { leadRequirements, recentLeadSignalIds }).length;
				} catch (error) {
					failures.push({ date, reason: `prompt build: ${String(error).slice(0, 60)}` });
					return null;
				}
				const regime = classifyRegime(snapshot.inputData);
				const hardLeadReqs = leadRequirements?.filter((entry) => entry.severity === "hard").length ?? 0;
				const degraded = snapshot.inputData.degradedSources?.length ?? 0;
				const activeDepegs = snapshot.inputData.activeDepegCount ?? 0;
				const paragraphs = (target.digestExtended ?? "").split(/\n\n+/).filter((part) => part.trim()).length;
				const safetyUnavailable = snapshot.inputData.safetyContext?.status === "unavailable";
				// Difficulty proxies the deliberation the model must do: regime
				// severity, forced-lead constraints, evidence volume, degraded
				// inputs it must reason around, prompt length, and whether the
				// published edition needed a fourth paragraph.
				const difficulty =
					REGIME_WEIGHT[regime] * 100 +
					hardLeadReqs * 80 +
					(leadRequirements?.length ?? 0) * 30 +
					Math.min(activeDepegs, 30) * 6 +
					degraded * 25 +
					(safetyUnavailable ? 60 : 0) +
					(paragraphs >= 4 ? 40 : 0) +
					Math.round(promptChars / 500);
				return {
					date,
					regime,
					promptChars,
					leadReqs: leadRequirements?.length ?? 0,
					hardLeadReqs,
					activeDepegs,
					degraded,
					paragraphs,
					safetyUnavailable,
					difficulty,
				} satisfies Row;
			}
		}),
	);
	for (const row of batch) if (row) rows.push(row);
}

rows.sort((a, b) => b.difficulty - a.difficulty);
console.log(`scored ${rows.length} of ${targets.length} archived daily editions`);
if (failures.length > 0) {
	const byReason: Record<string, number> = {};
	for (const failure of failures) byReason[failure.reason] = (byReason[failure.reason] ?? 0) + 1;
	console.log(
		`UNSCORED ${failures.length}: ${Object.entries(byReason).map(([reason, count]) => `${reason}=${count}`).join("  ")}`,
	);
	console.log("  (an unscored edition is excluded from every distribution below — treat them as unknown, not absent)");
}
console.log("");

const regimeCounts = new Map<string, number>();
for (const row of rows) regimeCounts.set(row.regime, (regimeCounts.get(row.regime) ?? 0) + 1);
console.log(
	"regime distribution:",
	[...regimeCounts].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v} (${((100 * v) / rows.length).toFixed(0)}%)`).join("  "),
);
const withHard = rows.filter((row) => row.hardLeadReqs > 0).length;
const withDegraded = rows.filter((row) => row.degraded > 0).length;
const fourPara = rows.filter((row) => row.paragraphs >= 4).length;
console.log(
	`hard lead requirement: ${withHard} (${((100 * withHard) / rows.length).toFixed(0)}%)   ` +
		`degraded sources: ${withDegraded} (${((100 * withDegraded) / rows.length).toFixed(0)}%)   ` +
		`4-paragraph editions: ${fourPara} (${((100 * fourPara) / rows.length).toFixed(0)}%)`,
);
const chars = rows.map((row) => row.promptChars).sort((a, b) => a - b);
console.log(
	`prompt chars: min ${chars[0].toLocaleString()}  p50 ${chars[Math.floor(chars.length / 2)].toLocaleString()}  max ${chars[chars.length - 1].toLocaleString()}`,
);

const header = "date        regime    diff  chars   leadReq(hard)  depegs  degr  para  safety";
console.log(`\n=== HARDEST 12 (spend trial budget here) ===\n${header}`);
for (const row of rows.slice(0, 12)) {
	console.log(
		`${row.date}  ${row.regime.padEnd(8)} ${String(row.difficulty).padStart(4)}  ${String(row.promptChars).padStart(6)}  ` +
			`${String(row.leadReqs).padStart(3)}(${row.hardLeadReqs})        ${String(row.activeDepegs).padStart(3)}    ${String(row.degraded).padStart(2)}    ${row.paragraphs}    ${row.safetyUnavailable ? "UNAVAIL" : "ok"}`,
	);
}
console.log(`\n=== EASIEST 3 (for contrast) ===\n${header}`);
for (const row of rows.slice(-3)) {
	console.log(
		`${row.date}  ${row.regime.padEnd(8)} ${String(row.difficulty).padStart(4)}  ${String(row.promptChars).padStart(6)}  ` +
			`${String(row.leadReqs).padStart(3)}(${row.hardLeadReqs})        ${String(row.activeDepegs).padStart(3)}    ${String(row.degraded).padStart(2)}    ${row.paragraphs}    ${row.safetyUnavailable ? "UNAVAIL" : "ok"}`,
	);
}

// Where did the already-trialled edition land?
const trialled = rows.findIndex((row) => row.date === "2026-08-30");
if (trialled >= 0) {
	const row = rows[trialled];
	console.log(
		`\n2026-08-30 (already trialled) ranks ${trialled + 1} of ${rows.length} by difficulty ` +
			`(${(((rows.length - trialled) / rows.length) * 100).toFixed(0)}th percentile from the easy end): ` +
			`${row.regime}, diff=${row.difficulty}, leadReqs=${row.leadReqs}(${row.hardLeadReqs}), degraded=${row.degraded}`,
	);
}

// A regime-diverse, worst-case-weighted trial set.
const pick: Row[] = [];
for (const regime of ["CRISIS", "TENSION", "WATCHFUL", "CALM"] as const) {
	const hardest = rows.find((row) => row.regime === regime);
	if (hardest) pick.push(hardest);
}
for (const row of rows) {
	if (pick.length >= 6) break;
	if (!pick.includes(row)) pick.push(row);
}
console.log(`\n=== RECOMMENDED TRIAL SET (regime-diverse, worst-case weighted) ===`);
for (const row of pick) {
	console.log(`  ${row.date}  ${row.regime.padEnd(8)} diff=${String(row.difficulty).padStart(4)}  leadReqs=${row.leadReqs}(${row.hardLeadReqs})  degraded=${row.degraded}`);
}
console.log(`\n  --dates ${pick.map((row) => row.date).join(",")}`);

import { formatIsoDate } from "@shared/lib/format";
import { toErrorMessage } from "@shared/lib/error-utils";
import { throwIfAborted } from "../lib/abort";
import type { BudgetSurfaceOutcome } from "../lib/budget-surface-telemetry";
import { getCache, setCache } from "../lib/db-cache";
import { readSafetyMapManifestDate } from "../lib/digest-safety-map";
import { GITHUB_OWNER, GITHUB_REPO } from "../lib/github-repo";
import { cancelResponseBodyQuietly, readResponseSnippetWithTimeout } from "../lib/response-body";

/**
 * Pre-digest producer kick for the Safety Score map.
 *
 * The map is rendered by `.github/workflows/safety-map-refresh.yml`, whose
 * `schedule` triggers GitHub starts five to eight hours late — routinely after
 * the 08:05 UTC digest. Inside a bounded pre-digest window this asks GitHub
 * for an on-demand `workflow_dispatch` in `ensure` mode whenever the live
 * manifest is not today's. `ensure` makes the workflow skip when today's map
 * is already live, so a dispatch racing a late scheduled run cannot re-render
 * the dated archive the digest embeds.
 */

const DAY_SEC = 86_400;
/** First poll allowed to dispatch: 1h45m ahead of the 08:05 UTC digest. */
const SAFETY_MAP_KICK_WINDOW_START_SEC = 6 * 3600 + 20 * 60;
/** No dispatch at or after this time: a render could no longer beat the digest. */
const SAFETY_MAP_KICK_WINDOW_END_SEC = 8 * 3600;
/** Minimum spacing between dispatches; a render takes about three minutes. */
const SAFETY_MAP_KICK_RETRY_AFTER_SEC = 15 * 60;
/** Dispatches per UTC day; a persistent render failure needs an operator. */
export const SAFETY_MAP_KICK_MAX_DISPATCHES = 3;
/**
 * The operator producer-lag advisory fires once the whole dispatch budget has
 * been spent plus one render of slack (07:15 UTC), leaving the operator time
 * to intervene before the digest.
 */
export const SAFETY_MAP_READY_AFTER_SEC = SAFETY_MAP_KICK_WINDOW_START_SEC
  + SAFETY_MAP_KICK_MAX_DISPATCHES * SAFETY_MAP_KICK_RETRY_AFTER_SEC
  + 10 * 60;

const KICK_STATE_KEY = "safety-map:producer-kick:v1";
const WORKFLOW_FILE = "safety-map-refresh.yml";
const WORKFLOW_REF = "main";
const DISPATCH_URL =
  `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
const DISPATCH_TIMEOUT_MS = 10_000;
const DISPATCH_ERROR_SNIPPET = { timeoutMs: 2_000, maxBytes: 1_024, maxChars: 160 } as const;

export type SafetyMapProducerKickAction =
  | "outside-window"
  | "current"
  | "token-missing"
  | "awaiting-render"
  | "attempts-exhausted"
  | "dispatched"
  | "dispatch-failed";

export interface SafetyMapProducerKickResult {
  action: SafetyMapProducerKickAction;
  /** Null only outside the window, where nothing was read and nothing is reported. */
  outcome: BudgetSurfaceOutcome | null;
  date: string;
  manifestDate: string | null;
  manifestReason: string | null;
  /** Dispatches claimed for `date`, including one made by this call. */
  dispatches: number;
  error: string | null;
}

interface KickState {
  date: string;
  dispatches: number;
  lastDispatchAt: number;
}

function parseKickState(value: string | null | undefined): KickState | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (!("date" in parsed) || !("dispatches" in parsed) || !("lastDispatchAt" in parsed)) return null;
  const { date, dispatches, lastDispatchAt } = parsed;
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (typeof dispatches !== "number" || !Number.isSafeInteger(dispatches) || dispatches < 0) return null;
  if (typeof lastDispatchAt !== "number" || !Number.isFinite(lastDispatchAt)) return null;
  return { date, dispatches, lastDispatchAt };
}

async function dispatchSafetyMapWorkflow(
  token: string,
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const timeoutSignal = AbortSignal.timeout(DISPATCH_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetch(DISPATCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "pharos-worker-safety-map-kick/1.0",
      },
      body: JSON.stringify({ ref: WORKFLOW_REF, inputs: { mode: "ensure" } }),
      signal: requestSignal,
    });
  } catch (error) {
    throwIfAborted(signal);
    return { ok: false, reason: `dispatch-failed:${toErrorMessage(error).slice(0, 80)}` };
  }
  if (response.ok) {
    await cancelResponseBodyQuietly(response);
    return { ok: true };
  }
  const snippet = await readResponseSnippetWithTimeout(response, DISPATCH_ERROR_SNIPPET, signal);
  await cancelResponseBodyQuietly(response);
  return { ok: false, reason: `dispatch-http-${response.status}${snippet ? `: ${snippet}` : ""}` };
}

/**
 * Evaluates one pre-digest poll. Only a manifest dated today suppresses a
 * dispatch: an unreadable manifest is not proof the map exists, and the
 * workflow's own KV plan re-checks before rendering. Each dispatch is claimed
 * in D1 before the request is sent, so a lost response can at worst cost one
 * of the day's bounded attempts, never an unbounded dispatch loop.
 */
export async function runSafetyMapProducerKick({
  db,
  nowSec,
  githubToken,
  signal,
}: {
  db: D1Database;
  nowSec: number;
  githubToken: string | null | undefined;
  signal?: AbortSignal;
}): Promise<SafetyMapProducerKickResult> {
  const date = formatIsoDate(nowSec);
  const secondsIntoDay = nowSec - Math.floor(nowSec / DAY_SEC) * DAY_SEC;
  const base = { date, manifestDate: null, manifestReason: null, dispatches: 0, error: null };
  if (secondsIntoDay < SAFETY_MAP_KICK_WINDOW_START_SEC || secondsIntoDay >= SAFETY_MAP_KICK_WINDOW_END_SEC) {
    return { ...base, action: "outside-window", outcome: null };
  }

  const manifest = await readSafetyMapManifestDate(signal);
  const cached = await getCache(db, KICK_STATE_KEY, signal);
  const state = parseKickState(cached?.value);
  const dispatches = state?.date === date ? state.dispatches : 0;
  const observed = { ...base, manifestDate: manifest.date, manifestReason: manifest.reason, dispatches };

  if (manifest.date === date) {
    return { ...observed, action: "current", outcome: "ok" };
  }
  const token = githubToken?.trim();
  if (!token) {
    return { ...observed, action: "token-missing", outcome: "degraded", error: "GITHUB_PAT is not configured" };
  }
  if (dispatches >= SAFETY_MAP_KICK_MAX_DISPATCHES) {
    return {
      ...observed,
      action: "attempts-exhausted",
      outcome: "degraded",
      error: `map for ${date} still unpublished after ${dispatches} dispatches`,
    };
  }
  if (state?.date === date && nowSec - state.lastDispatchAt < SAFETY_MAP_KICK_RETRY_AFTER_SEC) {
    return { ...observed, action: "awaiting-render", outcome: "skipped" };
  }

  const claimed: KickState = { date, dispatches: dispatches + 1, lastDispatchAt: nowSec };
  await setCache(db, KICK_STATE_KEY, JSON.stringify(claimed), signal);
  const dispatch = await dispatchSafetyMapWorkflow(token, signal);
  if (!dispatch.ok) {
    return {
      ...observed,
      dispatches: claimed.dispatches,
      action: "dispatch-failed",
      outcome: "degraded",
      error: dispatch.reason,
    };
  }
  return { ...observed, dispatches: claimed.dispatches, action: "dispatched", outcome: "ok" };
}

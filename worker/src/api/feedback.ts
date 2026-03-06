// worker/src/api/feedback.ts

import { getCache } from "../lib/db";
import { errorResponse, jsonResponse } from "../lib/api-utils";
import { resolveStablecoinId } from "@shared/lib/stablecoin-id-registry";

// ── Types ──────────────────────────────────────────────────────────────────

interface FeedbackBody {
  type: "bug" | "data-correction" | "feature-request";
  title?: string;
  description: string;
  expectedValue?: string;
  stablecoinId?: string;
  stablecoinName?: string;
  pageUrl: string;
  pegValue?: string;
  website?: string; // honeypot
}

export interface FeedbackEnv {
  GITHUB_PAT?: string;
  GITHUB_REPO_NODE_ID?: string;
  GITHUB_DISCUSSION_CATEGORY_ID?: string;
  FEEDBACK_IP_SALT?: string;
}

const GITHUB_OWNER = "TokenBrice";
const GITHUB_REPO = "stablecoin-dashboard";
const FEEDBACK_RATE_LIMIT_WINDOW_SEC = 600;
const FEEDBACK_RATE_LIMIT_MAX_SUBMISSIONS = 3;

// ── Rate limiting ─────────────────────────────────────────────────────────

async function checkRateLimit(
  db: D1Database,
  ip: string,
  salt: string
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const data = encoder.encode(ip + salt);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const ipHash = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);

  // Single-statement insert gate avoids race from check-then-insert under concurrency.
  const insertResult = await db
    .prepare(
      `INSERT INTO feedback_rate_limit (ip_hash, submitted_at)
       SELECT ?, ?
       WHERE (
         SELECT COUNT(*) FROM feedback_rate_limit
         WHERE ip_hash = ? AND submitted_at > ?
       ) < ?`,
    )
    .bind(
      ipHash,
      now,
      ipHash,
      now - FEEDBACK_RATE_LIMIT_WINDOW_SEC,
      FEEDBACK_RATE_LIMIT_MAX_SUBMISSIONS,
    )
    .run();
  if ((insertResult.meta?.changes ?? 0) === 0) {
    return false;
  }

  // Prune rows older than 1 hour (non-blocking, best-effort)
  db.prepare("DELETE FROM feedback_rate_limit WHERE submitted_at < ?")
    .bind(now - 3600)
    .run()
    .catch((e) => console.warn("[feedback] rate-limit prune failed:", e));

  return true;
}

// ── Auto-verification ─────────────────────────────────────────────────────

interface VerificationResult {
  block: string;
  verifiedLabel: "verified: confirmed" | "verified: unconfirmed" | "verified: pending";
}

async function verifyDataCorrection(
  db: D1Database,
  stablecoinId: string
): Promise<VerificationResult> {
  try {
    const cached = await getCache(db, "stablecoins");
    if (!cached) throw new Error("stablecoins cache empty");

    const parsed = JSON.parse(cached.value) as {
      peggedAssets?: Array<{ id: string; price?: number | null; circulating?: Record<string, number> }>;
    };
    const assets = parsed.peggedAssets ?? [];
    const coin = assets.find((a) => a.id === stablecoinId);

    if (!coin) throw new Error(`coin ${stablecoinId} not found in cache`);

    const price = coin.price ?? null;
    const totalUSD = coin.circulating
      ? Object.values(coin.circulating).reduce((s, v) => s + (v ?? 0), 0)
      : 0;

    const cacheAgeSec = Math.floor(Date.now() / 1000) - cached.updatedAt;
    const pegRef = 1.0;
    // pegRef is hardcoded to 1.0; non-USD stablecoins will show inflated deviation.
    // The snapshot still provides useful price/supply data for triage.

    let deviationStr = "N/A";
    let verifiedLabel: VerificationResult["verifiedLabel"] = "verified: unconfirmed";

    if (price != null && price > 0) {
      const dev = ((price - pegRef) / pegRef) * 100;
      deviationStr = `${dev >= 0 ? "+" : ""}${dev.toFixed(3)}%`;
      if (Math.abs(dev) > 1) verifiedLabel = "verified: confirmed";
    }

    const mcapStr =
      totalUSD > 1e9
        ? `$${(totalUSD / 1e9).toFixed(2)}B`
        : totalUSD > 1e6
          ? `$${(totalUSD / 1e6).toFixed(0)}M`
          : `$${totalUSD.toFixed(0)}`;

    // "Confirmed" = data issue is real (warning); "Unconfirmed" = data looks OK (checkmark)
    const verificationSummary =
      verifiedLabel === "verified: confirmed"
        ? "⚠️ Confirmed"
        : "✅ Unconfirmed";

    const block = [
      "**--- Auto-Verification Snapshot (at time of submission) ---**",
      price != null ? `**Cached price:** $${price.toFixed(6)}` : "**Cached price:** N/A",
      totalUSD > 0 ? `**Circulating supply:** ${mcapStr}` : "",
      `**Peg deviation:** ${deviationStr}`,
      `**Cache age:** ${cacheAgeSec}s`,
      `**Verification result:** ${verificationSummary}`,
    ]
      .filter(Boolean)
      .join("\n");

    return { block, verifiedLabel };
  } catch (err) {
    console.warn("[feedback] Auto-verification failed:", err);
    return {
      block: "**Verification:** pending (cache unavailable at submission time)",
      verifiedLabel: "verified: pending",
    };
  }
}

// ── GitHub helpers ────────────────────────────────────────────────────────

const GH_HEADERS = (pat: string): Record<string, string> => ({
  Authorization: `Bearer ${pat}`,
  "Content-Type": "application/json",
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "pharos-feedback-widget/1.0",
});

async function createGitHubIssue(
  pat: string,
  title: string,
  body: string,
  labels: string[]
): Promise<void> {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/issues`,
    {
      method: "POST",
      headers: GH_HEADERS(pat),
      body: JSON.stringify({ title, body, labels }),
      signal: AbortSignal.timeout(10_000),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub Issues API ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function createGitHubDiscussion(
  pat: string,
  repositoryId: string,
  categoryId: string,
  title: string,
  body: string
): Promise<boolean> {
  const mutation = `
    mutation CreateDiscussion($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
      createDiscussion(input: {
        repositoryId: $repositoryId,
        categoryId: $categoryId,
        title: $title,
        body: $body
      }) {
        discussion { id }
      }
    }
  `;
  try {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: GH_HEADERS(pat),
      body: JSON.stringify({
        query: mutation,
        variables: { repositoryId, categoryId, title, body },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn("[feedback] GraphQL HTTP error:", res.status);
      return false;
    }
    const data = (await res.json()) as { errors?: unknown[] };
    if (data.errors?.length) {
      console.warn("[feedback] GraphQL errors:", JSON.stringify(data.errors));
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[feedback] GraphQL Discussion creation failed:", err);
    return false;
  }
}

// ── Issue body formatting ─────────────────────────────────────────────────

function formatBody(fb: FeedbackBody, verificationBlock?: string): string {
  const lines: string[] = [];

  lines.push(
    `**Type:** ${fb.type === "bug" ? "Bug Report" : fb.type === "data-correction" ? "Data Correction" : "Feature Request"}`
  );

  if (fb.stablecoinName || fb.stablecoinId) {
    const name = (fb.stablecoinName ?? "").replace(/[\r\n]/g, " ").slice(0, 100);
    const id = fb.stablecoinId ? ` (${fb.stablecoinId})` : "";
    lines.push(`**Stablecoin:** ${name}${id}`);
  }

  const safePageUrl = fb.pageUrl.replace(/[\r\n]/g, " ").slice(0, 200);
  lines.push(`**Page:** ${safePageUrl}`);

  if (fb.pegValue) lines.push(`**Current value:** ${fb.pegValue}`);
  if (fb.expectedValue) lines.push(`**Expected value / source:** ${fb.expectedValue}`);

  lines.push("", "**Description:**", fb.description);

  if (verificationBlock) lines.push("", verificationBlock);

  lines.push("", "---", "*Submitted via Pharos feedback widget*");

  return lines.join("\n");
}

// ── Main handler ──────────────────────────────────────────────────────────

export async function handleFeedback(
  db: D1Database,
  request: Request,
  env: FeedbackEnv
): Promise<Response> {
  // Parse JSON body
  let fb: FeedbackBody;
  try {
    fb = (await request.json()) as FeedbackBody;
  } catch {
    return errorResponse(400, "Invalid JSON body");
  }

  if (typeof fb !== "object" || fb === null) {
    return errorResponse(400, "Invalid JSON body");
  }

  // Honeypot: silently accept but do nothing
  if (fb.website) return jsonResponse({ ok: true });

  // Validate type
  if (!["bug", "data-correction", "feature-request"].includes(fb.type)) {
    return errorResponse(400, "Invalid feedback type");
  }

  // Validate description
  const desc = fb.description?.trim() ?? "";
  if (desc.length < 10 || desc.length > 2000) {
    return errorResponse(400, "Description must be 10–2000 characters");
  }

  // Validate title (required for bug + feature-request)
  if (fb.type === "bug" || fb.type === "feature-request") {
    const title = fb.title?.trim() ?? "";
    if (title.length < 3 || title.length > 100) {
      return errorResponse(400, "Title must be 3–100 characters");
    }
  }

  // Validate pageUrl
  if (!fb.pageUrl?.startsWith("/")) {
    return errorResponse(400, "Invalid pageUrl");
  }

  let canonicalStablecoinId: string | undefined;

  // Validate stablecoinId if provided (strip invalid IDs, preserve original submitted value in payload).
  if (fb.stablecoinId) {
    const resolved = resolveStablecoinId(fb.stablecoinId, { allowLegacy: true });
    if (!resolved) {
      fb.stablecoinId = undefined;
    } else {
      canonicalStablecoinId = resolved.canonicalId;
      if (resolved.matchedBy !== "canonical") {
        const path = new URL(request.url).pathname;
        console.log(
          `[legacy-id] context=path=${path} input=${fb.stablecoinId} resolved=${resolved.canonicalId} matchedBy=${resolved.matchedBy}`,
        );
      }
    }
  }

  // Rate limiting
  const forwardedFor = request.headers.get("X-Forwarded-For");
  const ip =
    request.headers.get("CF-Connecting-IP") ??
    forwardedFor?.split(",")[0]?.trim() ??
    "unknown";
  if (!env.FEEDBACK_IP_SALT) {
    console.error("[feedback] FEEDBACK_IP_SALT secret not configured");
    return errorResponse(503, "Service misconfigured");
  }
  const allowed = await checkRateLimit(db, ip, env.FEEDBACK_IP_SALT);
  if (!allowed) {
    return errorResponse(429, "Too many submissions. Please wait a few minutes.");
  }

  // Require PAT
  const pat = env.GITHUB_PAT;
  if (!pat) {
    console.error("[feedback] GITHUB_PAT secret not configured");
    return errorResponse(503, "Feedback service temporarily unavailable");
  }

  try {
    if (fb.type === "feature-request") {
      const title = `[Feature Request] ${(fb.title ?? "").trim()}`;
      const body = formatBody(fb);

      const repoNodeId = env.GITHUB_REPO_NODE_ID;
      const categoryId = env.GITHUB_DISCUSSION_CATEGORY_ID;

      let created = false;
      if (repoNodeId && categoryId) {
        created = await createGitHubDiscussion(pat, repoNodeId, categoryId, title, body);
      }
      if (!created) {
        await createGitHubIssue(pat, title, body, ["feature-request"]);
      }
    } else {
      let verificationBlock: string | undefined;
      let verifiedLabel: "verified: confirmed" | "verified: unconfirmed" | "verified: pending" = "verified: pending";

      if (fb.type === "data-correction" && canonicalStablecoinId) {
        const result = await verifyDataCorrection(db, canonicalStablecoinId);
        verificationBlock = result.block;
        verifiedLabel = result.verifiedLabel;
      }

      const stablecoinPart = fb.stablecoinName ? `${fb.stablecoinName}: ` : "";
      const shortDesc = fb.description.trim().slice(0, 60);
      const ellipsis = fb.description.trim().length > 60 ? "…" : "";

      const title =
        fb.type === "bug"
          ? `[Bug] ${(fb.title ?? "").trim()}`
          : `[Data Correction] ${stablecoinPart}${shortDesc}${ellipsis}`;

      const labels =
        fb.type === "bug" ? ["bug"] : ["data-correction", verifiedLabel];

      const body = formatBody(fb, verificationBlock);
      await createGitHubIssue(pat, title, body, labels);
    }

    return jsonResponse({ ok: true });
  } catch (err) {
    console.error("[feedback] GitHub API error:", err);
    return errorResponse(500, "Failed to submit feedback. Please try again.");
  }
}

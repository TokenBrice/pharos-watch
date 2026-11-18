import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import sharp from "sharp";
import { unstable_dev, unstable_readConfig, type Unstable_DevWorker } from "wrangler";
import { SOCIAL_PREVIEW_WIDTH, SOCIAL_PREVIEW_HEIGHT } from "../../shared/lib/social-preview";
import { makeScorecardMetadataFixture } from "../../shared/test-utils/social-scorecard";
import { stableJsonStringifyV1 } from "../../shared/lib/stable-json";
import { decodeSocialScorecardMetadata, SOCIAL_SCORECARD_METADATA_HEADER } from "../../shared/lib/social-scorecard";
import { sha256HexFromBytes } from "../../shared/lib/sha256";

it("renders a PNG through the production Satori and resvg pipeline in workerd", async () => {
  const root = resolve(import.meta.dirname, "../..");
  mkdirSync(resolve(root, "agents"), { recursive: true });
  const scratch = mkdtempSync(resolve(root, "agents/og-worker-test-"));
  let worker: Unstable_DevWorker | undefined;
  try {
  const config = resolve(scratch, "wrangler.json");
  const entry = resolve(scratch, "worker.ts");
  const production = unstable_readConfig({ config: resolve(root, "worker/wrangler.toml") });
  const metadata = makeScorecardMetadataFixture();
  const identity = metadata.publication;
  const resultDigest = "d".repeat(64);
  const row = {
    score_index: stableJsonStringifyV1({
      schemaVersion: 2, safetyScoreIdentity: identity, publicationResultDigest: resultDigest,
      asOfSec: metadata.asOfSec, publishedAtSec: metadata.publishedAtSec, expectedCount: 1,
      scores: { "usdc-circle": { score: 82, grade: "A", ratingStatus: "rated", partialEvidence: null } },
    }),
    index_updated_at: metadata.publishedAtSec,
    health: stableJsonStringifyV1({
      schemaVersion: 2, status: "current", acceptedPublicationGenerationId: identity.publicationGenerationId,
      acceptedAtSec: metadata.publishedAtSec, attemptedAtSec: metadata.publishedAtSec, heldSinceSec: null, reasons: [],
    }),
    health_updated_at: metadata.publishedAtSec,
    publication_identity: JSON.stringify({
      candidateId: "renderer-regression", policyVersion: identity.methodologyVersion,
      publicationGenerationId: identity.publicationGenerationId, baseInputGenerationId: identity.baseInputGenerationId,
      factSetDigest: "e".repeat(64), policyId: identity.policyId, policyDigest: identity.policyDigest,
      evaluationBuildDigest: identity.evaluationBuildDigest, resultDigest,
    }),
    result_digest: resultDigest, publication_updated_at: metadata.publishedAtSec,
  };
  writeFileSync(config, JSON.stringify({
    name: "og-runtime-test",
    compatibility_date: production.compatibility_date,
    compatibility_flags: production.compatibility_flags,
    tsconfig: "../../worker/tsconfig.json",
    rules: production.rules,
    // Both renderer and scorecard admission now use the production import graph.
    alias: Object.fromEntries(Object.entries(production.alias ?? {}).map(([name, path]) => {
      if (typeof path !== "string") throw new Error(`Invalid Worker alias: ${name}`);
      return [name, resolve(root, "worker", path)];
    })),
  }));
  const logo = readFileSync(resolve(root, "public/logos/2-usdc.svg"), "utf8");
  writeFileSync(entry, `
    const row = ${JSON.stringify(row)};
    const db = { prepare() { return { bind() { return { first: async () => row }; } }; } };
    // A render's one outbound request, the coin's registered logo, answered locally.
    const logoRequests = [];
    globalThis.fetch = async (input) => {
      logoRequests.push(String(input));
      return new Response(${JSON.stringify(logo)}, { headers: { "Content-Type": "image/svg+xml" } });
    };
    export default {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/logo-requests") return Response.json(logoRequests);
        // Exercise the same cold request-time loading boundary as production OG.
        const { handleScorecardOg } = await import(${JSON.stringify(resolve(root, "worker/src/api/og-scorecard.tsx"))});
        return handleScorecardOg(db, path.split("/").pop());
      },
    };
  `);
    worker = await unstable_dev(entry, {
      config, local: true, persist: false, logLevel: "error", port: 0,
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true },
    });
    // Cold initialization, then isolate reuse, across both retained-card layouts:
    // an SVG-only mock cannot catch Satori's multi-child div failures.
    for (const path of ["/scorecard/usdc-circle", "/scorecard/safety-scores", "/scorecard/usdc-circle"]) {
      const response = await worker.fetch(path);
      expect(response.status, response.status === 200 ? path : await response.text()).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("image/png");
      const bytes = Buffer.from(await response.arrayBuffer());
      const captured = decodeSocialScorecardMetadata(response.headers.get(SOCIAL_SCORECARD_METADATA_HEADER));
      expect(captured.imageSha256).toBe(sha256HexFromBytes(bytes));
      expect(captured.subject).toMatchObject(path.endsWith("usdc-circle") ? { grade: "A", score: 82 } : { ratedCount: 1, totalCount: 1 });
      const image = sharp(bytes);
      expect(await image.metadata()).toMatchObject({ format: "png", width: SOCIAL_PREVIEW_WIDTH, height: SOCIAL_PREVIEW_HEIGHT });
      await image.raw().toBuffer();
    }
    expect(await (await worker.fetch("/logo-requests")).json()).toEqual(Array(2).fill("https://pharos.watch/logos/2-usdc.svg"));
  } finally {
    try {
      await worker?.stop();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}, 60_000);

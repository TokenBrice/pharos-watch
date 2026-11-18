#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SOCIAL_PREVIEW_ASSET_OBJECT_PREFIX, SOCIAL_PREVIEW_BUCKET_NAME } from "../../shared/lib/social-preview-storage";
import { SOCIAL_PREVIEW_ASSET_CACHE_CONTROL, assertSocialPreviewPng, socialPreviewAssetIdentity } from "../../shared/lib/social-preview-asset";
import { assertCliUsage, parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { loadCloudflareAccountStateManifest } from "../lib/cloudflare-account-state-manifest.mjs";
import { preflightCloudflarePagesR2 } from "../lib/cloudflare-pages-r2";
import { R2ObjectExistsError, SignedR2ObjectClient } from "../lib/r2-object-client";
import { SOCIAL_PREVIEW_MAP_PATH } from "../lib/social-preview-build";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const USAGE = `Usage: node --import tsx scripts/maintenance/publish-social-previews.ts [options]

Create the route map's missing /og/v2/ images in permanent R2. Lists
evergreen/v2/ once, then uploads each absent PNG from the exact Pages export
with a create-only write. Objects are never overwritten, read back or pruned.

  --out-dir <path>  Exact Pages export, relative to the repository (default: out)
  --dry-run         Validate the export's current images without network or writes (default)
  --execute         Check Pages binding/lifecycle, then create the missing objects
  -h, --help        Show this help

Execute requires CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN with Pages project
and R2 bucket lifecycle read access, plus R2_SOCIAL_PREVIEWS_ACCESS_KEY_ID and
R2_SOCIAL_PREVIEWS_SECRET_ACCESS_KEY scoped only to pharos-social-previews.
Run only in the trusted publisher step, after export/gates and before Pages activation.`;

type BucketClient = Pick<SignedR2ObjectClient, "list" | "put">;

export async function publishSocialPreviews({
  repoRoot = REPO_ROOT, outDir = "out", execute = false, client, env = process.env, fetchImpl = fetch,
}: { repoRoot?: string; outDir?: string; execute?: boolean; client?: BucketClient; env?: Readonly<Record<string, string | undefined>>; fetchImpl?: typeof fetch } = {}): Promise<{
  assets: number; created: number; existing: number; dryRun: boolean;
}> {
  const map = JSON.parse(readFileSync(resolve(repoRoot, SOCIAL_PREVIEW_MAP_PATH), "utf8")) as Record<string, { url?: unknown }>;
  const assets = new Map<string, Buffer>();
  for (const image of Object.values(map)) {
    const identity = typeof image?.url === "string" ? socialPreviewAssetIdentity(image.url) : null;
    if (!identity) throw new Error(`Invalid social preview route map URL: ${String(image?.url)}`);
    if (assets.has(identity.key)) continue;
    const bytes = readFileSync(resolve(repoRoot, outDir, "og/v2", identity.filename));
    // A create under the bucket lock is permanent: nothing malformed may enter.
    assertSocialPreviewPng(bytes);
    assets.set(identity.key, bytes);
  }
  if (assets.size === 0) throw new Error("Empty social preview publication set");
  if (!execute) return { assets: assets.size, created: 0, existing: 0, dryRun: true };
  const storageManifest = loadCloudflareAccountStateManifest(resolve(repoRoot, "scripts/ci/cloudflare-account-state-manifest.json"));
  if (storageManifest.pages.production.requiredR2Bindings?.SOCIAL_PREVIEWS !== SOCIAL_PREVIEW_BUCKET_NAME) {
    throw new Error(`Social preview account-state manifest must require SOCIAL_PREVIEWS=${SOCIAL_PREVIEW_BUCKET_NAME}`);
  }
  await preflightCloudflarePagesR2({
    manifest: storageManifest, accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN, fetchImpl,
  });
  const r2 = client ?? new SignedR2ObjectClient({
    bucket: SOCIAL_PREVIEW_BUCKET_NAME,
    accessKeyEnv: "R2_SOCIAL_PREVIEWS_ACCESS_KEY_ID",
    secretKeyEnv: "R2_SOCIAL_PREVIEWS_SECRET_ACCESS_KEY",
  });
  const stored = new Set(await r2.list(SOCIAL_PREVIEW_ASSET_OBJECT_PREFIX));
  const missing = [...assets].filter(([key]) => !stored.has(key));
  let created = 0;
  let existing = assets.size - missing.length;
  let next = 0;
  let failure: { error: unknown } | undefined;
  // Stop claiming uploads after a failure, but let in-flight creates settle before blocking activation.
  async function publishWorker(): Promise<void> {
    while (!failure && next < missing.length) {
      const [key, bytes] = missing[next++];
      try {
        await r2.put(key, bytes, {
          ifNoneMatch: "*", contentType: "image/png", cacheControl: SOCIAL_PREVIEW_ASSET_CACHE_CONTROL,
          customMetadata: { "png-sha256": createHash("sha256").update(bytes).digest("hex") },
        });
        created++;
      } catch (error) {
        // A concurrent release already created this input-addressed identity.
        if (error instanceof R2ObjectExistsError) existing++;
        else failure ??= { error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, missing.length) }, () => publishWorker()));
  if (failure) throw failure.error;
  return { assets: assets.size, created, existing, dryRun: false };
}

export async function runSocialPreviewPublisherCli(argv = process.argv.slice(2)): Promise<void> {
  const { values } = parseStrictCliArgs(argv, {
    options: { "out-dir": { type: "string" }, "dry-run": { type: "boolean" }, execute: { type: "boolean" }, help: { type: "boolean", short: "h" } },
    conflicts: [["dry-run", "execute"]],
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  assertCliUsage(values["out-dir"] === undefined || (typeof values["out-dir"] === "string" && values["out-dir"].trim().length > 0), "--out-dir must be nonblank");
  const result = await publishSocialPreviews({ outDir: values["out-dir"] as string | undefined, execute: values.execute === true });
  console.log(`[social-previews] ${result.dryRun ? "dry-run" : "published"}: ${result.assets} current assets; ${result.created} created, ${result.existing} already permanent`);
}

runDirectCli(import.meta.url, () => runSocialPreviewPublisherCli(), { label: "publish-social-previews", usage: USAGE });

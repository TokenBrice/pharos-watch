#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SOCIAL_PREVIEW_REVISION } from "../../shared/lib/social-preview";
import { SOCIAL_PREVIEW_BUCKET_NAME } from "../../shared/lib/social-preview-storage";
import { SOCIAL_PREVIEW_ASSET_CACHE_CONTROL, socialPreviewAssetIdentity, verifySocialPreviewAsset, type SocialPreviewAssetIdentity } from "../../shared/lib/social-preview-asset";
import { assertCliUsage, parseStrictCliArgs, runDirectCli, writeCliHelpIfRequested } from "../lib/cli-args.mjs";
import { loadCloudflareAccountStateManifest } from "../lib/cloudflare-account-state-manifest.mjs";
import { preflightCloudflarePagesR2 } from "../lib/cloudflare-pages-r2";
import { R2ObjectExistsError, SignedR2ObjectClient, type R2ObjectClient } from "../lib/r2-object-client";
import { SOCIAL_PREVIEW_GENERATOR, SOCIAL_PREVIEW_MAP_PATH, SOCIAL_PREVIEW_SIGNATURE_PATH } from "../lib/social-preview-build";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const USAGE = `Usage: node --import tsx scripts/maintenance/publish-social-previews.ts [options]

Verify every current/retained immutable PNG in the exact Pages export, then
create missing permanent R2 objects. Existing identities must contain exactly
those original bytes and metadata. Objects are never overwritten or pruned.

  --out-dir <path>  Exact Pages export, relative to the repository (default: out)
  --dry-run         Validate local publication inputs without network or writes (default)
  --execute         Check Pages binding/lifecycle, then publish and verify remote readback
  -h, --help        Show this help

Execute requires CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN with Pages project
and R2 bucket lifecycle read access, plus R2_SOCIAL_PREVIEWS_ACCESS_KEY_ID and
R2_SOCIAL_PREVIEWS_SECRET_ACCESS_KEY scoped only to pharos-social-previews.
Run only in the trusted publisher step, after export/gates and before Pages activation.`;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid social preview ${label}`);
  return value as Record<string, unknown>;
}

export async function publishSocialPreviews({
  repoRoot = REPO_ROOT, outDir = "out", execute = false, client, env = process.env, fetchImpl = fetch,
}: { repoRoot?: string; outDir?: string; execute?: boolean; client?: R2ObjectClient; env?: Readonly<Record<string, string | undefined>>; fetchImpl?: typeof fetch } = {}): Promise<{
  assets: number; created: number; existing: number; dryRun: boolean;
}> {
  const manifest = object(JSON.parse(readFileSync(resolve(repoRoot, SOCIAL_PREVIEW_SIGNATURE_PATH), "utf8")), "manifest");
  if (manifest.generatedBy !== SOCIAL_PREVIEW_GENERATOR || manifest.revision !== SOCIAL_PREVIEW_REVISION || !Array.isArray(manifest.cards)) {
    throw new Error("Invalid social preview manifest identity");
  }
  const retained = object(manifest.retained, "retained roster");
  if (Object.keys(retained).length === 0 || manifest.cards.length === 0) throw new Error("Empty social preview publication roster");
  const map = object(JSON.parse(readFileSync(resolve(repoRoot, SOCIAL_PREVIEW_MAP_PATH), "utf8")), "route map");
  const current = new Map<string, Record<string, unknown>>();
  for (const value of manifest.cards) {
    const card = object(value, "card");
    const image = object(map[String(card.path)], "route image");
    const record = object(retained[String(card.url)], "current retained image");
    const identity = typeof card.url === "string" ? socialPreviewAssetIdentity(card.url) : null;
    if (!identity || card.semanticHash !== identity.semanticHash || image.url !== card.url || current.has(String(card.path))
      || card.sourceFingerprint !== record.sourceFingerprint || card.kind !== record.kind) throw new Error("Social preview map/manifest mismatch");
    current.set(String(card.path), card);
  }
  if (current.size !== Object.keys(map).length) throw new Error("Social preview route map has unregistered images");
  const assets: {
    identity: SocialPreviewAssetIdentity;
    bytes: Buffer;
    metadata: Record<string, string>;
  }[] = [];
  for (const [url, value] of Object.entries(retained).sort(([left], [right]) => left.localeCompare(right))) {
    const identity = socialPreviewAssetIdentity(url);
    if (!identity) throw new Error(`Invalid retained social preview URL: ${url}`);
    const record = object(value, "retained image");
    const metadata = {
      "png-sha256": typeof record.pngSha256 === "string" ? record.pngSha256 : "",
      "source-fingerprint": typeof record.sourceFingerprint === "string" ? record.sourceFingerprint : "",
      "semantic-hash": identity.semanticHash,
      kind: typeof record.kind === "string" ? record.kind : "",
    };
    const bytes = readFileSync(resolve(repoRoot, outDir, url.slice(1)));
    const original = readFileSync(resolve(repoRoot, "public", url.slice(1)));
    if (!bytes.equals(original)) throw new Error(`Pages export differs from original social preview: ${url}`);
    await verifySocialPreviewAsset(bytes, identity, metadata);
    assets.push({ identity, bytes, metadata });
  }
  const expected = new Set(assets.map(({ identity }) => identity.filename));
  for (const directory of [resolve(repoRoot, "public/og/v2"), resolve(repoRoot, outDir, "og/v2")]) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !expected.has(entry.name)) throw new Error(`Unregistered social preview publication input: ${entry.name}`);
    }
  }
  if (!execute) return { assets: assets.length, created: 0, existing: 0, dryRun: true };
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
  let created = 0;
  let existing = 0;
  let nextAsset = 0;
  let failed = false;
  let failure: unknown;
  // Stop claiming work on failure, but drain in-flight readbacks before blocking activation.
  async function publishWorker(): Promise<void> {
    while (!failed && nextAsset < assets.length) {
      const { identity, bytes, metadata } = assets[nextAsset++];
      try {
        try {
          await r2.put(identity.key, bytes, {
            ifNoneMatch: "*", contentType: "image/png", cacheControl: SOCIAL_PREVIEW_ASSET_CACHE_CONTROL, customMetadata: metadata,
          });
          created++;
        } catch (error) {
          if (!(error instanceof R2ObjectExistsError)) throw error;
          existing++;
        }
        const stored = await r2.get(identity.key);
        const storedMetadata = await r2.head(identity.key);
        if (!stored || !stored.equals(bytes) || !storedMetadata || storedMetadata.contentType !== "image/png"
          || storedMetadata.contentLength !== bytes.byteLength
          || Object.entries(metadata).some(([name, value]) => storedMetadata.customMetadata[name] !== value)) {
          throw new Error(`Permanent social preview collision or failed readback: ${identity.key}`);
        }
        await verifySocialPreviewAsset(stored, identity, storedMetadata.customMetadata);
      } catch (error) {
        if (!failed) { failed = true; failure = error; }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, assets.length) }, () => publishWorker()));
  if (failed) throw failure;
  return { assets: assets.length, created, existing, dryRun: false };
}

export async function runSocialPreviewPublisherCli(argv = process.argv.slice(2)): Promise<void> {
  const { values } = parseStrictCliArgs(argv, {
    options: { "out-dir": { type: "string" }, "dry-run": { type: "boolean" }, execute: { type: "boolean" }, help: { type: "boolean", short: "h" } },
    conflicts: [["dry-run", "execute"]],
  });
  if (writeCliHelpIfRequested(values, USAGE)) return;
  assertCliUsage(values["out-dir"] === undefined || (typeof values["out-dir"] === "string" && values["out-dir"].trim().length > 0), "--out-dir must be nonblank");
  const result = await publishSocialPreviews({ outDir: values["out-dir"] as string | undefined, execute: values.execute === true });
  console.log(`[social-previews] ${result.dryRun ? "dry-run" : "published"}: ${result.assets} verified assets; ${result.created} created, ${result.existing} already permanent`);
}

runDirectCli(import.meta.url, () => runSocialPreviewPublisherCli(), { label: "publish-social-previews", usage: USAGE });

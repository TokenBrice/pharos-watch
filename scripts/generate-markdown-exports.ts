/* eslint-disable security/detect-non-literal-fs-filename -- repo-local build script writes generated markdown under the static export directory only. */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { changelogs } from "../src/data/changelogs";
import {
  buildMethodologyChangelogMarkdown,
  buildMethodologyIndexMarkdown,
  METHODOLOGY_CHANGELOG_KEYS,
} from "./lib/methodology-to-markdown";
import {
  iterateDigestRoutes,
  iterateDocRoutes,
  iterateStablecoinRoutes,
  renderChangelogIndex,
  type MarkdownRoute,
} from "./lib/markdown-renderers";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const OUT_DIR = join(dirname(SCRIPT_PATH), "../out");

const CHANGELOG_PATHS: Record<(typeof METHODOLOGY_CHANGELOG_KEYS)[number], string> = {
  scoring: "/methodology/scoring-changelog/",
  depeg: "/methodology/depeg-changelog/",
  "blacklist-tracker": "/methodology/blacklist-tracker-changelog/",
  "liquidity-score": "/methodology/liquidity-score-changelog/",
  "stability-index": "/methodology/stability-index-changelog/",
  "mint-burn-flow": "/methodology/mint-burn-flow-changelog/",
  yield: "/methodology/yield-changelog/",
  "pricing-pipeline": "/methodology/pricing-pipeline-changelog/",
  "chain-health": "/methodology/chain-health-changelog/",
};

export function writeMarkdownRoute(outDir: string, route: MarkdownRoute): void {
  if (!route.path.startsWith("/") || !route.path.endsWith("/")) {
    throw new Error(`Path must start and end with a trailing slash: ${route.path}`);
  }
  if (route.path.includes("..")) {
    throw new Error(`Path traversal segments are not allowed: ${route.path}`);
  }

  const segments = route.path.split("/").filter(Boolean);
  const target = resolve(outDir, ...segments, "index.md");
  const resolvedOutDir = resolve(outDir);
  if (!target.startsWith(resolvedOutDir + sep) && target !== resolvedOutDir) {
    throw new Error(`Resolved path escapes outDir: ${target}`);
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, route.body, "utf-8");
}

export async function main(): Promise<void> {
  let count = 0;

  const write = (route: MarkdownRoute) => {
    writeMarkdownRoute(OUT_DIR, route);
    count += 1;
  };

  write({ path: "/methodology/", body: buildMethodologyIndexMarkdown() });

  for (const key of METHODOLOGY_CHANGELOG_KEYS) {
    write({
      path: CHANGELOG_PATHS[key],
      body: buildMethodologyChangelogMarkdown(key),
    });
  }

  for (const route of iterateStablecoinRoutes()) write(route);

  write({ path: "/changelog/", body: renderChangelogIndex(changelogs) });

  for (const route of iterateDigestRoutes()) write(route);
  for (const route of iterateDocRoutes()) write(route);

  console.log(`generate-markdown-exports: wrote ${count} markdown variants`);
}

if (resolve(process.argv[1] ?? "") === SCRIPT_PATH) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

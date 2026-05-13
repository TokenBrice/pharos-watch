#!/usr/bin/env node

console.error(
  [
    "Worker production publishing is intentionally disabled from npm scripts.",
    "Use the production release workflow, which uploads a Worker Version, runs validation and D1 migration checks, preview-smokes the candidate, promotes the exact version, and syncs triggers.",
    "For local debugging, use `cd worker && npm run dev`.",
  ].join("\n"),
);
process.exit(1);

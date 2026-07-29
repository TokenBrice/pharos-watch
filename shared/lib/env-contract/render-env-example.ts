import type { EnvExampleSection } from "./types.ts";
import { ENV_BINDINGS } from "./registry.ts";

const ENV_EXAMPLE_SECTION_ORDER: readonly {
  comments: readonly string[];
  key: EnvExampleSection;
}[] = [
  {
    key: "frontend",
    comments: [
      "# Generated from `shared/lib/env-contract.ts`; run `npm run check:env-contract` after manifest edits.",
      "# Secrets typically use `wrangler secret put`; plain worker vars usually live in",
      "# `worker/wrangler.toml [vars]` or are configured directly in Cloudflare.",
      "# `DB` is configured separately in `worker/wrangler.toml` under `[d1_databases]`",
      "# and as a Pages D1 binding on the site-data proxy project.",
      "",
      "# Frontend optional build/runtime bindings",
      "# `NEXT_PUBLIC_API_BASE` is mainly for local `next dev` or non-Pharos hosts.",
      "# When unset on Pharos/Pages browser hosts, public reads go through same-origin",
      "# `/_site-data/*`; direct `https://api.pharos.watch` is reserved for explicit",
      "# public API callsites and non-Pharos hosts.",
      "# `NEXT_PUBLIC_GA_ID` is optional; when unset, no analytics script or",
      "# custom-event telemetry is injected by `src/app/layout.tsx`.",
    ],
  },
  {
    key: "workerRequired",
    comments: ["# Worker required active bindings"],
  },
  {
    key: "workerOptional",
    comments: [
      "# Worker optional active bindings",
    ],
  },
  {
    key: "workerReserved",
    comments: [
      "# Worker reserved-only keys.",
      "# The worker keeps these names reserved for cross-runtime alignment, but it does",
      "# not currently consume them at runtime.",
    ],
  },
  {
    key: "sharedSiteApiSecret",
    comments: [
      "# Pages Functions + local dev proxy shared secret",
      "# Required for `npm run dev` to fetch authenticated API data locally.",
      "# Copy from the Pages Functions environment in the Cloudflare dashboard.",
    ],
  },
  {
    key: "pagesSiteDataRequired",
    comments: [
      "# Pages Functions required active bindings for the site-data proxy.",
      "# Production and preview Pages hosts fail closed for `/_site-data/*` when",
      "# this upstream origin is missing.",
    ],
  },
  {
    key: "pagesOpsRequired",
    comments: [
      "# Pages Functions required active bindings for the ops admin proxy.",
      "# Also configure the shared keys above: `CF_ACCESS_TEAM_DOMAIN` and",
      "# `CF_ACCESS_OPS_UI_AUD`. `CF_ACCESS_TEAM_DOMAIN` is active on both Worker",
      "# and Pages; `CF_ACCESS_OPS_UI_AUD` is active on Pages and reserved on Worker.",
    ],
  },
  {
    key: "pagesOptional",
    comments: [
      "# Pages Functions optional active bindings",
      "# `OPS_UI_ORIGIN` and `OPS_API_ORIGIN` are the same names listed above as",
      "# worker-reserved keys, but they are active on the Pages Functions runtime.",
    ],
  },
];

function renderValueLine(key: string, value: string): string {
  return `${key}=${value}`;
}

export function renderEnvExample(): string {
  const lines: string[] = [];

  for (const section of ENV_EXAMPLE_SECTION_ORDER) {
    if (lines.length > 0) {
      lines.push("");
    }

    lines.push(...section.comments);

    for (const binding of ENV_BINDINGS.filter((binding) => binding.example?.section === section.key)) {
      lines.push(renderValueLine(binding.key, binding.example?.value ?? ""));
    }
  }

  return `${lines.join("\n")}\n`;
}

# Funding Page Implementation Plan (v2 — simplified)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a stealth-released `/funding` page that renders Pharos's monthly running costs, the donations that cover them, and a small set of support CTAs — from two manually-edited JSON files, with a dedicated Claude skill (`funding-update`) handling weekly on-chain research.

**Architecture:** Fully static — no D1, no worker code, no API endpoint, no cron. The page reads `shared/data/funding/costs.json` and `shared/data/funding/donations.json` at build time and renders entirely server-side. A new Claude skill (`funding-update`), modeled on `pre-launch-update`, researches inbound transfers to `pharos-watch.eth` across chains, resolves ENS, and appends rows to `donations.json` with user approval. Costs are hand-edited.

**Tech Stack:** Next.js 16 static export; TypeScript; vitest for helper tests. No external runtime dependencies beyond what the repo already uses.

**Supersedes:** `agents/plans/2026-04-18-funding-page-implementation-plan.md` (the original 4,616-line plan). The design spec at `agents/plans/2026-04-18-funding-page-design.md` still applies for voice and page sections; everything the spec says about cron, D1, API, or chart is deliberately out of scope for this v2 plan.

**What this plan intentionally drops from the original:**
- D1 migration + 5 new tables
- Daily cron + slot registration + connection budgets + seeding script
- Alchemy + Gnosisscan + CoinGecko historical pricing modules
- ENS resolver module + cache TTL + per-run caps
- Spam denylist module
- `/api/funding-summary` + Zod schema + endpoint registration
- TanStack hook + error boundary + Skeleton loading state (static data, no network)
- Monthly Recharts bar chart (1 data point today; revisit when ≥6 months exist)
- Trailing-3-month coverage KPI, `is_cold_start` flag, cost step-line
- `TonalSection` extraction from `/about` (use `Card` + local tone map; ~30 lines, not worth a cross-cutting refactor)
- Stealth→promotion criteria, methodology-version bumping

**What this plan keeps from the original design spec:**
- Stealth release: `/funding/` unlinked, `robots: noindex`
- Voice & copy guidelines (honest, no urgency, no CTAs in card titles)
- Wallet + Giveth primary CTAs; Star / Contribute / Flag compact strip
- Year-end horizon paragraph
- 3-question FAQ (≤80 words total)
- Founder vs community split in donation accounting

---

## Pre-flight

- [ ] **Confirm no `shared/data/funding/` directory exists yet**

```bash
ls shared/data/funding/ 2>&1 | head -3
```

Expected: `ls: cannot access 'shared/data/funding/': No such file or directory`. If any stale scaffolding from the v1 plan is still on disk (e.g. `cost-line-items.json`, `donor-labels.json`), `git rm` those files before starting Task 1 — this plan is a clean slate and uses different filenames.

(`buildExplorerUrl` and `formatAddress` were already verified at plan-write time; no pre-flight check needed for them.)

---

## Task 1: Shared types + seed data files

**Files:**
- Create: `shared/lib/funding/types.ts`
- Create: `shared/data/funding/costs.json`
- Create: `shared/data/funding/donations.json`

**Why no separate donor-labels file:** the v1 plan needed one because a cron auto-ingested rows and labels had to be a separate lookup. Here the skill (or a human) writes each row knowing its kind at insertion time. Keep the labelling inline on each row via a `kind` field.

- [ ] **Step 1: Create `shared/lib/funding/types.ts`**

```typescript
/**
 * Six chains the funding page can display. Keep in lockstep with
 * `buildExplorerUrl` (shared/lib/explorer.ts); if a chain is added
 * here but explorer.ts has no case, donor list entries on that chain
 * will render without a link.
 */
export type FundingChain =
  | "ethereum"
  | "base"
  | "optimism"
  | "arbitrum"
  | "polygon"
  | "gnosis";

export type CostCategory = "team" | "infra";

export interface CostLineItem {
  label: string;
  category: CostCategory;
  usd_per_month: number;
  note?: string;
}

export interface CostsFile {
  /** UTC unix seconds of the last review. Surfaced on the page footer. */
  last_reviewed_at: number;
  items: CostLineItem[];
}

/**
 * One donation row. Written by the funding-update skill or by hand.
 *
 * - `kind: "founder"` rows are excluded from the community lifetime total,
 *   excluded from the donor list, but visible in the cost-breakdown footer
 *   as "founder subsidy this month / lifetime".
 * - `kind: "pool"` (e.g. Giveth payout contract) counts as community;
 *   `display` should read "via Giveth" rather than the raw contract address.
 * - `kind: "community"` is everything else (default).
 *
 * `usd_at_receipt` is computed once at insertion time — no historical-price
 * pipeline at runtime. Stablecoin donations are priced at $1. ETH and other
 * native / whitelisted assets are priced via the CoinGecko `/coins/{id}/history`
 * endpoint for the transfer's UTC block date, with the skill recording the
 * source in `price_note`.
 */
export interface Donation {
  chain: FundingChain;
  tx_hash: string;
  block_timestamp: number; // UTC unix seconds
  from_address: string; // lowercased
  display: string; // ENS name, custom label, or truncated address
  kind: "founder" | "pool" | "community";
  asset_symbol: string; // 'ETH', 'USDC', 'xDAI', ...
  amount_decimal: number;
  usd_at_receipt: number;
  price_note: string; // 'stablecoin-1-to-1' | 'coingecko-historical-YYYY-MM-DD' | 'manual-<source>'
}

export interface DonationsFile {
  /** UTC unix seconds of the last run of the funding-update skill. */
  last_updated_at: number;
  donations: Donation[];
}
```

- [ ] **Step 2: Create `shared/data/funding/costs.json`**

Set `last_reviewed_at` to today's UTC unix seconds (paste the output of `date -u +%s`). Line-item amounts come from the v1 design doc with the added Claude API row — confirm with the user if any value has drifted since the spec was written.

```json
{
  "last_reviewed_at": 1744934400,
  "items": [
    { "label": "Ike", "category": "team", "usd_per_month": 1500, "note": "Growth & comms" },
    { "label": "Brice", "category": "team", "usd_per_month": 0, "note": "Uncompensated until Pharos is self-funded" },
    { "label": "CoinGecko API", "category": "infra", "usd_per_month": 129, "note": "Analyst tier" },
    { "label": "Alchemy", "category": "infra", "usd_per_month": 40, "note": "Pay-as-you-go, ~$40 typical" },
    { "label": "Claude API", "category": "infra", "usd_per_month": 30, "note": "Daily digest generation" },
    { "label": "Cloudflare Workers", "category": "infra", "usd_per_month": 5, "note": "Paid plan" },
    { "label": "Domain registration", "category": "infra", "usd_per_month": 2.85, "note": "pharos.watch, annualized" }
  ]
}
```

Current total: **$1,706.85 / month** (Team $1,500 + Infra $206.85).

- [ ] **Step 3: Create `shared/data/funding/donations.json` as an empty log**

Seed with an empty array. The historical known inbound tx (`0xc310bc94c763f00c939aefba0094e012892b45e688954283199264d37cdb8786`) and any other past transfers will be picked up by the first run of the `funding-update` skill (Task 5), which handles pricing, ENS resolution, and founder labeling in one flow. That avoids asking the hand-edit step to do research work that the skill is already built for.

Use a real `last_updated_at` (today's unix seconds — e.g. `date +%s`); do not commit the `0` placeholder.

```json
{
  "last_updated_at": 0,
  "donations": []
}
```

- [ ] **Step 4: Commit**

```bash
git add shared/lib/funding/types.ts shared/data/funding/
git commit -m "feat(funding): shared types and initial data files"
```

---

## Task 2: Pure helper functions

**Files:**
- Create: `shared/lib/funding/helpers.ts`
- Create: `shared/lib/funding/__tests__/helpers.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `shared/lib/funding/__tests__/helpers.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  computeCostsTotal,
  groupCostsByCategory,
  summarizeDonations,
  monthKey,
} from "../helpers";
import type { CostLineItem, Donation } from "../types";

const COSTS: CostLineItem[] = [
  { label: "Ike", category: "team", usd_per_month: 1500 },
  { label: "Brice", category: "team", usd_per_month: 0, note: "Volunteer" },
  { label: "CoinGecko API", category: "infra", usd_per_month: 129 },
  { label: "Alchemy", category: "infra", usd_per_month: 40 },
  { label: "Cloudflare Workers", category: "infra", usd_per_month: 5 },
  { label: "Domain", category: "infra", usd_per_month: 2.85 },
];

const D = (ts: number, kind: Donation["kind"], usd: number, from = "0xa"): Donation => ({
  chain: "ethereum",
  tx_hash: `0x${ts}`,
  block_timestamp: ts,
  from_address: from,
  display: from,
  kind,
  asset_symbol: "ETH",
  amount_decimal: 0.1,
  usd_at_receipt: usd,
  price_note: "coingecko-spot-test",
});

describe("computeCostsTotal", () => {
  it("sums usd_per_month to two decimal places", () => {
    expect(computeCostsTotal(COSTS)).toBeCloseTo(1676.85, 2);
  });
});

describe("groupCostsByCategory", () => {
  it("returns team then infra, each with a subtotal", () => {
    const groups = groupCostsByCategory(COSTS);
    expect(groups).toEqual([
      { category: "team", items: [COSTS[0], COSTS[1]], subtotal: 1500 },
      { category: "infra", items: [COSTS[2], COSTS[3], COSTS[4], COSTS[5]], subtotal: 176.85 },
    ]);
  });

  it("omits categories with no items", () => {
    const infraOnly = COSTS.filter((c) => c.category === "infra");
    const groups = groupCostsByCategory(infraOnly);
    expect(groups.map((g) => g.category)).toEqual(["infra"]);
  });
});

describe("monthKey", () => {
  it("returns YYYY-MM in UTC", () => {
    const ts = Date.UTC(2026, 3, 18, 23, 59, 0) / 1000;
    expect(monthKey(ts)).toBe("2026-04");
  });
});

describe("summarizeDonations", () => {
  const apr = Date.UTC(2026, 3, 15) / 1000;
  const mar = Date.UTC(2026, 2, 15) / 1000;
  const feb = Date.UTC(2026, 1, 15) / 1000;

  it("splits community from founder and counts distinct community donors", () => {
    const rows: Donation[] = [
      D(apr, "community", 100, "0xa"),
      D(apr, "community", 50, "0xb"),
      D(apr, "founder", 1000, "0xf"),
      D(mar, "community", 200, "0xa"),
      D(feb, "pool", 25, "0xp"),
    ];
    const s = summarizeDonations(rows, apr);
    expect(s.currentMonthCommunityUsd).toBe(150);
    expect(s.currentMonthFounderUsd).toBe(1000);
    expect(s.lifetimeCommunityUsd).toBe(375); // 100 + 50 + 200 + 25
    expect(s.lifetimeFounderUsd).toBe(1000);
    // Distinct community senders across lifetime: 0xa, 0xb, 0xp
    expect(s.lifetimeCommunityDonorCount).toBe(3);
  });

  it("returns zeros when donations is empty", () => {
    const s = summarizeDonations([], apr);
    expect(s.lifetimeCommunityUsd).toBe(0);
    expect(s.lifetimeCommunityDonorCount).toBe(0);
    expect(s.currentMonthCommunityUsd).toBe(0);
    expect(s.currentMonthFounderUsd).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run shared/lib/funding/__tests__/helpers.test.ts
```

Expected: FAIL — module `../helpers` cannot be resolved.

- [ ] **Step 3: Implement `shared/lib/funding/helpers.ts`**

```typescript
import type { CostCategory, CostLineItem, Donation } from "./types";

const CATEGORY_ORDER: readonly CostCategory[] = ["team", "infra"];

export function computeCostsTotal(items: readonly CostLineItem[]): number {
  return items.reduce((sum, item) => sum + item.usd_per_month, 0);
}

export interface CostCategoryGroup {
  category: CostCategory;
  items: CostLineItem[];
  subtotal: number;
}

export function groupCostsByCategory(items: readonly CostLineItem[]): CostCategoryGroup[] {
  return CATEGORY_ORDER.flatMap((category) => {
    const subset = items.filter((item) => item.category === category);
    if (subset.length === 0) return [];
    const subtotal = subset.reduce((sum, item) => sum + item.usd_per_month, 0);
    return [{ category, items: subset, subtotal }];
  });
}

/** YYYY-MM in UTC. */
export function monthKey(timestampSec: number): string {
  const d = new Date(timestampSec * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface DonationSummary {
  currentMonthCommunityUsd: number;
  currentMonthFounderUsd: number;
  lifetimeCommunityUsd: number;
  lifetimeFounderUsd: number;
  lifetimeCommunityDonorCount: number;
}

/**
 * Split donations into community (kind !== "founder") and founder, computing
 * current-month and lifetime totals. `nowSec` defines "this month" so tests
 * and the page-render path agree.
 */
export function summarizeDonations(
  donations: readonly Donation[],
  nowSec: number,
): DonationSummary {
  const currentMonth = monthKey(nowSec);
  let currentMonthCommunityUsd = 0;
  let currentMonthFounderUsd = 0;
  let lifetimeCommunityUsd = 0;
  let lifetimeFounderUsd = 0;
  const communitySenders = new Set<string>();

  for (const d of donations) {
    const isFounder = d.kind === "founder";
    if (isFounder) {
      lifetimeFounderUsd += d.usd_at_receipt;
    } else {
      lifetimeCommunityUsd += d.usd_at_receipt;
      communitySenders.add(d.from_address);
    }
    if (monthKey(d.block_timestamp) === currentMonth) {
      if (isFounder) currentMonthFounderUsd += d.usd_at_receipt;
      else currentMonthCommunityUsd += d.usd_at_receipt;
    }
  }

  return {
    currentMonthCommunityUsd,
    currentMonthFounderUsd,
    lifetimeCommunityUsd,
    lifetimeFounderUsd,
    lifetimeCommunityDonorCount: communitySenders.size,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run shared/lib/funding/__tests__/helpers.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add shared/lib/funding/helpers.ts shared/lib/funding/__tests__/helpers.test.ts
git commit -m "feat(funding): pure helpers for costs and donation summary"
```

---

## Task 3: Page sections (KPI row, cost breakdown, donor list, support CTAs, year-end, FAQ)

**Files:**
- Create: `src/components/funding/funding-page-sections.tsx`
- Create: `src/components/funding/__tests__/funding-page-sections.test.tsx`

**Why one file, not six:** each section is small (<50 lines). Splitting into six files would mean six imports on the page, six test files for trivial render checks, and `src/components/funding/` sprawl. One file keeps the footprint proportional to the work. If a section grows, split it out later.

**Why not extract `TonalSection` from `/about`:** the v1 plan had a Task 14.5 that pulled `AboutSection` + `getToneClasses` into a shared primitive for cross-page reuse. For a single additional page, duplicating ~30 lines of tone-map + a tiny Card wrapper is cheaper than taking on a cross-cutting refactor risk. Revisit if a third page wants the same primitive.

- [ ] **Step 1: Write the failing tests**

Create `src/components/funding/__tests__/funding-page-sections.test.tsx`:

```typescript
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  FundingKpiRow,
  CostBreakdown,
  DonorList,
} from "../funding-page-sections";
import type { CostLineItem, Donation } from "@shared/lib/funding/types";

const COSTS: CostLineItem[] = [
  { label: "Ike", category: "team", usd_per_month: 1500 },
  { label: "Alchemy", category: "infra", usd_per_month: 40 },
];

describe("FundingKpiRow", () => {
  it("renders numeric KPIs when there is community history", () => {
    render(
      <FundingKpiRow
        summary={{
          currentMonthCommunityUsd: 300,
          currentMonthFounderUsd: 1000,
          lifetimeCommunityUsd: 300,
          lifetimeFounderUsd: 3000,
          lifetimeCommunityDonorCount: 2,
        }}
        monthlyTargetUsd={1540}
      />,
    );
    expect(screen.getByText("This month coverage")).toBeInTheDocument();
    // 300 / 1540 ≈ 19%
    expect(screen.getByText("19%")).toBeInTheDocument();
    expect(screen.getByText("Community support")).toBeInTheDocument();
    expect(screen.getByText(/from 2 supporters/)).toBeInTheDocument();
  });

  it("shows cold-start copy when lifetime community is zero", () => {
    render(
      <FundingKpiRow
        summary={{
          currentMonthCommunityUsd: 0,
          currentMonthFounderUsd: 0,
          lifetimeCommunityUsd: 0,
          lifetimeFounderUsd: 0,
          lifetimeCommunityDonorCount: 0,
        }}
        monthlyTargetUsd={1540}
      />,
    );
    expect(screen.getByText("Tracking begins")).toBeInTheDocument();
    expect(screen.getByText("Be the first")).toBeInTheDocument();
  });
});

describe("CostBreakdown", () => {
  it("renders team and infra groups and total", () => {
    render(
      <CostBreakdown
        items={COSTS}
        currentCommunityUsd={300}
        currentFounderUsd={1240}
        lifetimeFounderUsd={3000}
        lastReviewedAt={1744934400}
      />,
    );
    expect(screen.getByText("Team")).toBeInTheDocument();
    expect(screen.getByText("Infrastructure")).toBeInTheDocument();
    expect(screen.getByText("Ike")).toBeInTheDocument();
    expect(screen.getByText(/1,540/)).toBeInTheDocument(); // total
    // Footer exposes community + founder split explicitly
    expect(screen.getByText(/This month: \$300 community/)).toBeInTheDocument();
    expect(screen.getByText(/Lifetime founder subsidy: \$3,000/)).toBeInTheDocument();
  });
});

describe("DonorList", () => {
  const now = Math.floor(Date.UTC(2026, 3, 18) / 1000);

  it("hides founder rows and shows community rows with display names", () => {
    const donations: Donation[] = [
      {
        chain: "ethereum",
        tx_hash: "0xabc",
        block_timestamp: now - 3600,
        from_address: "0x1",
        display: "alice.eth",
        kind: "community",
        asset_symbol: "ETH",
        amount_decimal: 0.1,
        usd_at_receipt: 300,
        price_note: "coingecko-spot-2026-04-18",
      },
      {
        chain: "ethereum",
        tx_hash: "0xdef",
        block_timestamp: now - 7200,
        from_address: "0xf",
        display: "TokenBrice (founder subsidy)",
        kind: "founder",
        asset_symbol: "ETH",
        amount_decimal: 0.3,
        usd_at_receipt: 1000,
        price_note: "coingecko-spot-2026-04-18",
      },
    ];
    render(<DonorList donations={donations} lastUpdatedAt={now} />);
    expect(screen.getByText("alice.eth")).toBeInTheDocument();
    expect(screen.queryByText("TokenBrice (founder subsidy)")).not.toBeInTheDocument();
  });

  it("shows empty state when no community donations exist", () => {
    render(<DonorList donations={[]} lastUpdatedAt={now} />);
    expect(screen.getByText(/No community donations yet/)).toBeInTheDocument();
  });
});
```

(`YearEndHorizon` and `FundingFaq` are pure static-copy components — no branching, no props, no logic. A render test would only re-assert the JSX literal, so we don't bother. Visual check in Task 4 Step 3 covers them.)

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/components/funding/__tests__/funding-page-sections.test.tsx
```

Expected: FAIL — module `../funding-page-sections` cannot be resolved.

- [ ] **Step 3: Implement `src/components/funding/funding-page-sections.tsx`**

```typescript
import Image from "next/image";
import { ExternalLink, Heart, Star, Wallet, Wrench } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/utils";
import { buildExplorerUrl } from "@shared/lib/explorer";
import { formatAddress } from "@shared/lib/format";
import { CHAIN_META } from "@shared/lib/chains";
import type { CostLineItem, Donation, FundingChain } from "@shared/lib/funding/types";
import type { DonationSummary } from "@shared/lib/funding/helpers";
import { groupCostsByCategory } from "@shared/lib/funding/helpers";

const PHAROS_FUNDING_WALLET_DISPLAY = "0x5d698362EDb8AEa1C2b2483096BDeE3265D860DB";
const PHAROS_FUNDING_ENS = "pharos-watch.eth";
const GIVETH_URL = "https://giveth.io/project/pharos-watch:-transparent-stablecoins-analytics";
const GITHUB_URL = "https://github.com/TokenBrice/stablecoin-dashboard";
const SUPPORTED_CHAINS: FundingChain[] = ["ethereum", "base", "optimism", "arbitrum", "polygon", "gnosis"];

const USD_COMPACT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

// Local tone map — intentionally duplicated from /about (Card component
// + 5 tone entries). See plan task 3 preamble for the "why".
type Tone = "brand" | "data" | "insight" | "neutral";
function toneBorder(tone: Tone): string {
  switch (tone) {
    case "brand": return "border-l-frost-blue";
    case "data": return "border-l-amber-500";
    case "insight": return "border-l-emerald-500";
    default: return "border-l-zinc-500";
  }
}
function toneKicker(tone: Tone): string {
  switch (tone) {
    case "brand": return "text-sky-700 dark:text-frost-blue/82";
    case "data": return "text-amber-700 dark:text-amber-400";
    case "insight": return "text-emerald-700 dark:text-emerald-400";
    default: return "text-muted-foreground";
  }
}

/* ------------------------------------------------------------------ KPI row */

export interface FundingKpiRowProps {
  summary: DonationSummary;
  monthlyTargetUsd: number;
}

export function FundingKpiRow({ summary, monthlyTargetUsd }: FundingKpiRowProps) {
  const coveragePct = monthlyTargetUsd > 0
    ? Math.round((summary.currentMonthCommunityUsd / monthlyTargetUsd) * 100)
    : 0;

  const thisMonth = summary.lifetimeCommunityUsd === 0
    ? { primary: "Tracking begins", secondary: "first community donations will appear here" }
    : {
        primary: `${coveragePct}%`,
        secondary: `${USD_COMPACT.format(summary.currentMonthCommunityUsd)} of ${USD_COMPACT.format(monthlyTargetUsd)} covered`,
      };

  const community = summary.lifetimeCommunityDonorCount === 0
    ? { primary: "Be the first", secondary: "community support starts here" }
    : {
        primary: USD_COMPACT.format(summary.lifetimeCommunityUsd),
        secondary: `from ${summary.lifetimeCommunityDonorCount} supporters since launch`,
      };

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <KpiCard kicker="This month coverage" primary={thisMonth.primary} secondary={thisMonth.secondary} tone="brand" />
      <KpiCard kicker="Community support" primary={community.primary} secondary={community.secondary} tone="insight" />
    </div>
  );
}

function KpiCard({
  kicker,
  primary,
  secondary,
  tone,
}: {
  kicker: string;
  primary: string;
  secondary: string;
  tone: Tone;
}) {
  return (
    <Card className={cn("rounded-xl border-l-[3px]", toneBorder(tone))}>
      <CardContent className="space-y-1 p-4">
        <p className={cn("pharos-kicker", toneKicker(tone))}>{kicker}</p>
        <p className="text-2xl font-semibold tracking-tight text-foreground font-mono tabular-nums">{primary}</p>
        <p className="text-xs text-muted-foreground">{secondary}</p>
      </CardContent>
    </Card>
  );
}

/* ---------------------------------------------------------- Cost breakdown */

const CATEGORY_LABELS: Record<string, string> = { team: "Team", infra: "Infrastructure" };

export interface CostBreakdownProps {
  items: CostLineItem[];
  currentCommunityUsd: number;
  currentFounderUsd: number;
  lifetimeFounderUsd: number;
  lastReviewedAt: number;
}

export function CostBreakdown({
  items,
  currentCommunityUsd,
  currentFounderUsd,
  lifetimeFounderUsd,
  lastReviewedAt,
}: CostBreakdownProps) {
  const groups = groupCostsByCategory(items);
  const total = groups.reduce((s, g) => s + g.subtotal, 0);
  const reviewedDate = new Date(lastReviewedAt * 1000).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
  });

  return (
    <Card className={cn("rounded-xl border-l-[3px]", toneBorder("data"))}>
      <CardHeader className="space-y-1">
        <p className={cn("pharos-kicker", toneKicker("data"))}>Where it goes</p>
        <CardTitle as="h2">Monthly costs</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {groups.map((group) => (
          <div key={group.category} className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {CATEGORY_LABELS[group.category] ?? group.category}
            </p>
            <ul className="space-y-0.5 text-sm">
              {group.items.map((item) => (
                <li key={item.label} className="flex justify-between gap-4">
                  <span className="flex-1 truncate">
                    {item.label}
                    {item.note ? <span className="ml-2 text-xs text-muted-foreground">— {item.note}</span> : null}
                  </span>
                  <span className="font-mono tabular-nums text-muted-foreground">
                    {USD_COMPACT.format(item.usd_per_month)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div className="flex justify-between border-t border-border/60 pt-2 text-sm font-medium">
          <span>Total / month</span>
          <span className="font-mono tabular-nums">{USD_COMPACT.format(total)}</span>
        </div>
        <div className="space-y-0.5 text-xs text-muted-foreground">
          <p>
            This month: {USD_COMPACT.format(currentCommunityUsd)} community ·{" "}
            {USD_COMPACT.format(currentFounderUsd)} founder subsidy.
          </p>
          <p>Lifetime founder subsidy: {USD_COMPACT.format(lifetimeFounderUsd)}.</p>
          <p>Costs last reviewed: {reviewedDate}.</p>
        </div>
      </CardContent>
    </Card>
  );
}

/* --------------------------------------------------------------- Donor list */

export interface DonorListProps {
  donations: Donation[];
  lastUpdatedAt: number;
  /** Cap how many rows render. Default 20. */
  limit?: number;
}

export function DonorList({ donations, lastUpdatedAt, limit = 20 }: DonorListProps) {
  const community = donations
    .filter((d) => d.kind !== "founder")
    .sort((a, b) => b.block_timestamp - a.block_timestamp);
  const visible = community.slice(0, limit);
  const lastUpdatedLabel = lastUpdatedAt > 0
    ? new Date(lastUpdatedAt * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : null;

  return (
    <Card className={cn("rounded-xl border-l-[3px]", toneBorder("insight"))}>
      <CardHeader className="space-y-1">
        <p className={cn("pharos-kicker", toneKicker("insight"))}>Supporters</p>
        <CardTitle as="h2">Recent supporters</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No community donations yet. {lastUpdatedLabel ? `Last checked ${lastUpdatedLabel}.` : ""}
          </p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {visible.map((d) => {
              const explorerUrl = buildExplorerUrl({ chainKey: d.chain, entityType: "tx", value: d.tx_hash });
              const displayText = d.display || formatAddress(d.from_address);
              return (
                <li key={`${d.chain}-${d.tx_hash}`} className="flex items-baseline justify-between gap-3">
                  <span className="flex-1 truncate font-mono text-xs">{displayText}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {USD_COMPACT.format(d.usd_at_receipt)}{" "}
                    {explorerUrl ? (
                      <a
                        href={explorerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline underline-offset-2 hover:text-foreground"
                      >
                        ↗
                      </a>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {community.length > limit ? (
          <p className="text-xs text-muted-foreground">
            Showing most recent {limit} of {community.length} supporters.
          </p>
        ) : null}
        {lastUpdatedLabel ? (
          <p className="text-xs text-muted-foreground">Last refresh: {lastUpdatedLabel}.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------- Support CTAs */

export function SupportCtas() {
  return (
    <section id="how-to-support">
      <Card className={cn("rounded-xl border-l-[3px]", toneBorder("brand"))}>
        <CardHeader className="space-y-1">
          <p className={cn("pharos-kicker", toneKicker("brand"))}>Get involved</p>
          <CardTitle as="h2">How to support</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2">
            <CtaCard
              icon={Wallet}
              title="Wallet"
              description={`${PHAROS_FUNDING_ENS} resolves to the same address on every supported chain. ETH, stablecoins, and other ERC-20s accepted.`}
              emphasized
              action={
                <div className="space-y-2">
                  <div className="flex items-center gap-2 rounded-md border border-border/60 bg-background px-3 py-1.5">
                    <span className="flex-1 truncate font-mono text-xs">
                      {formatAddress(PHAROS_FUNDING_WALLET_DISPLAY)}
                    </span>
                    <CopyButton text={PHAROS_FUNDING_WALLET_DISPLAY} />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {SUPPORTED_CHAINS.map((c) => {
                      const meta = CHAIN_META[c];
                      return (
                        <span
                          key={c}
                          className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[10px]"
                        >
                          {meta?.logoPath ? <Image src={meta.logoPath} alt="" width={12} height={12} /> : null}
                          {meta?.name ?? c}
                        </span>
                      );
                    })}
                  </div>
                </div>
              }
            />
            <CtaCard
              icon={Heart}
              title="Giveth"
              description="A public-goods funding platform. Donations route to the same wallet and appear on the wall as a single 'via Giveth' entry."
              emphasized
              action={
                <Button asChild variant="outline" className="min-h-9 w-full justify-between">
                  <a href={GIVETH_URL} target="_blank" rel="noopener noreferrer">
                    Giveth
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </Button>
              }
            />
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Easiest: wallet — same address on every chain. Cheapest gas: Base or Gnosis.
            Via Giveth: supports their public-goods pool; donations arrive at the wallet and appear on the wall as a
            single "via Giveth" entry.
          </p>
          <div className="space-y-2">
            <p className="pharos-kicker text-muted-foreground">Other ways to help</p>
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
              <CtaCard
                icon={Star}
                title="Star on GitHub"
                description="A star helps others find Pharos when they search GitHub."
                action={
                  <Button asChild variant="outline" className="min-h-9 w-full justify-between">
                    <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
                      GitHub
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </Button>
                }
              />
              <CtaCard
                icon={Wrench}
                title="Contribute"
                description="MIT-licensed. Issues and PRs welcome."
                action={
                  <Button asChild variant="outline" className="min-h-9 w-full justify-between">
                    <a href={`${GITHUB_URL}/issues`} target="_blank" rel="noopener noreferrer">
                      Issues
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </Button>
                }
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Found bad data or a broken view? The feedback form on any stablecoin detail page goes straight to
            the maintainers.
          </p>
        </CardContent>
      </Card>
    </section>
  );
}

function CtaCard({
  icon: Icon,
  title,
  description,
  action,
  emphasized,
}: {
  icon: typeof Wallet;
  title: string;
  description: string;
  action: React.ReactNode;
  emphasized?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-full flex-col gap-2 rounded-xl border bg-background/40 p-4",
        emphasized ? "border-l-[3px] border-l-frost-blue border-border/60" : "border-border/60",
      )}
    >
      <div className="flex items-center gap-2">
        <Icon className={cn("h-4 w-4", emphasized ? "text-sky-700 dark:text-frost-blue/82" : "text-foreground")} />
        <p className="text-sm font-medium text-foreground">{title}</p>
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
      <div className="mt-auto pt-2">{action}</div>
    </div>
  );
}

/* ----------------------------------------------------------- Year-end + FAQ */

export function YearEndHorizon() {
  const shareUrl =
    "https://x.com/intent/tweet?text=" +
    encodeURIComponent("Pharos — independent stablecoin analytics, MIT-licensed. https://pharos.watch");
  return (
    <Card className={cn("rounded-xl border-l-[3px]", toneBorder("brand"))}>
      <CardHeader className="space-y-1">
        <p className={cn("pharos-kicker", toneKicker("brand"))}>Where we're going</p>
        <CardTitle as="h2">Path to sustainability</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
        <p>
          Pharos aims to fund itself by the end of 2026 without subsidy from Brice. Until then, he covers the gap
          directly. We review trajectory each quarter — if it is clearly behind, this paragraph will say so rather than
          leave the commitment stale.
        </p>
        <p className="text-xs">
          If you can&apos;t support financially,{" "}
          <a
            href={shareUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            sharing Pharos
          </a>{" "}
          helps others find it.
        </p>
      </CardContent>
    </Card>
  );
}

export function FundingFaq() {
  const qa: Array<{ q: string; a: string }> = [
    {
      q: "Is my donation tax-deductible?",
      a: "No — Pharos is not a registered charity. Giveth donations may qualify in some jurisdictions; check Giveth's documentation.",
    },
    {
      q: "What do supporters get?",
      a: "Public recognition on the wall unless you ask for a custom label. All Pharos features stay free for everyone — there is no paid tier.",
    },
    {
      q: "What happens to donations if Pharos stops operating?",
      a: "The MIT-licensed code and the on-chain ledger remain available. Donations are non-refundable.",
    },
  ];
  return (
    <Card className="rounded-xl border-l-[3px] border-l-zinc-500">
      <CardHeader className="space-y-1">
        <p className="pharos-kicker text-muted-foreground">Questions</p>
        <CardTitle as="h2">FAQ</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="space-y-3">
          {qa.map(({ q, a }) => (
            <div key={q} className="space-y-1">
              <dt className="text-sm font-medium text-foreground">{q}</dt>
              <dd className="text-sm text-muted-foreground">{a}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/components/funding/__tests__/funding-page-sections.test.tsx
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Type-check**

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/funding/
git commit -m "feat(funding): page sections (KPIs, costs, donors, CTAs, FAQ, horizon)"
```

---

## Task 4: Page route

**Files:**
- Create: `src/app/funding/page.tsx`

- [ ] **Step 1: Implement the page as a server component**

Because both data files are imported at build time and all sections are server components, there is no client boundary, no hook, no loading state, and no error boundary needed.

Create `src/app/funding/page.tsx`:

```typescript
import type { Metadata } from "next";
import { FeaturePageShell } from "@/components/feature-page-shell";
import {
  FundingKpiRow,
  CostBreakdown,
  DonorList,
  SupportCtas,
  YearEndHorizon,
  FundingFaq,
} from "@/components/funding/funding-page-sections";
import { computeCostsTotal, summarizeDonations } from "@shared/lib/funding/helpers";
import costsData from "@shared/data/funding/costs.json";
import donationsData from "@shared/data/funding/donations.json";
import type { CostsFile, DonationsFile } from "@shared/lib/funding/types";

export const metadata: Metadata = {
  title: "Funding — Pharos",
  description: "On-chain donations, running costs, and Pharos's path to being fully community-funded.",
  robots: { index: false, follow: false }, // stealth release — not indexed in v1
  alternates: { canonical: "/funding/" },
};

export default function FundingPage() {
  const costs = costsData as CostsFile;
  const donations = donationsData as DonationsFile;
  const now = Math.floor(Date.now() / 1000);
  const summary = summarizeDonations(donations.donations, now);
  const monthlyTargetUsd = computeCostsTotal(costs.items);

  return (
    <FeaturePageShell
      breadcrumbName="Funding"
      path="/funding/"
      title="Funding"
      leadParagraphs={[
        "An honest ledger of what Pharos costs to run, what supporters cover, and where we are on the path to a self-funded project.",
      ]}
    >
      <div className="space-y-8">
        <p className="text-xs text-muted-foreground">
          <a href="#how-to-support" className="underline underline-offset-2 hover:text-foreground">
            Skip to how to support &rarr;
          </a>
        </p>
        <FundingKpiRow summary={summary} monthlyTargetUsd={monthlyTargetUsd} />
        <div className="grid gap-4 lg:grid-cols-2">
          <CostBreakdown
            items={costs.items}
            currentCommunityUsd={summary.currentMonthCommunityUsd}
            currentFounderUsd={summary.currentMonthFounderUsd}
            lifetimeFounderUsd={summary.lifetimeFounderUsd}
            lastReviewedAt={costs.last_reviewed_at}
          />
          <DonorList donations={donations.donations} lastUpdatedAt={donations.last_updated_at} />
        </div>
        <SupportCtas />
        <FundingFaq />
        <YearEndHorizon />
      </div>
    </FeaturePageShell>
  );
}
```

- [ ] **Step 2: Verify JSON imports compile**

If TypeScript complains about JSON imports, confirm `tsconfig.json` has `"resolveJsonModule": true`. It is already set in this repo (used by other static data imports), so no change should be needed.

```bash
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Build and visually check the page**

```bash
npm run build 2>&1 | tail -20
```

Expected: build completes without errors; `/funding` appears in the route list.

```bash
npm run dev
```

Open `http://localhost:3000/funding` in a browser. Expected:
- Page renders at all viewports (check 375px and desktop) in light and dark themes
- KPI row shows 2 cards
- Cost breakdown shows team + infra groups and a total (~$1,707/m)
- Donor list shows whatever rows are in `donations.json` (or the empty state if none)
- CTAs: wallet card with the address + 6 chain badges + copy button, Giveth card, three small cards below
- Year-end horizon paragraph + "sharing Pharos" link
- FAQ with three Q/A pairs
- No console errors

- [ ] **Step 4: Commit**

```bash
git add src/app/funding/
git commit -m "feat(funding): /funding page route"
```

---

## Task 5: `funding-update` Claude skill

**Files:**
- Create: `.claude/skills/funding-update/SKILL.md`

- [ ] **Step 1: Write the skill definition**

Create `.claude/skills/funding-update/SKILL.md`:

```markdown
---
name: funding-update
description: Use when asked to update Pharos funding donations data, or on a ~weekly cadence to keep /funding current. Researches inbound transfers to the funding wallet across supported chains, resolves ENS, and appends rows to shared/data/funding/donations.json with user approval.
user_invocable: true
---

## Funding Donations Update

Weekly maintenance of the donations log that backs `/funding`. Researches new inbound transfers to the funding wallet, prices them in USD at receipt time, resolves ENS, flags spam, and after user approval, appends rows to `shared/data/funding/donations.json` and bumps `last_updated_at`.

This skill does **not** touch `shared/data/funding/costs.json`. Cost line items are a deliberate judgment call and live in a hand-edited file.

### Scope

- **Six chains:** Ethereum, Base, Optimism, Arbitrum, Polygon, Gnosis.
- **Wallet:** `0x5d698362edb8aea1c2b2483096bdee3265d860db` (ENS: `pharos-watch.eth`). Same address on every EVM chain.

### Prerequisites

- `ALCHEMY_API_KEY` present (covers 5 chains: ethereum, base, optimism, arbitrum, polygon).
- `GNOSISSCAN_API_KEY` present (free tier is fine; sign up at https://gnosisscan.io/myapikey if needed).
- `COINGECKO_API_KEY` present (Analyst or Demo tier).

Ask the user if any key is missing; the repo's worker uses all three already.

### Process

#### Step 1 — Read current state

1. Read `shared/data/funding/donations.json`. For each of the 6 chains, record the highest `block_timestamp` seen on that chain (or `0` if the chain has no rows). Call this map `cursorsByChain`.
2. Read `shared/data/funding/costs.json` only to display the current monthly cost total to the user for context ("costs are $X/m; $Y covered so far this month") — do not edit it.

#### Step 2 — Fetch new transfers on every chain

Run the six calls in parallel (or sequentially — it's one curl per chain, the skill is not on a latency budget).

**Alchemy chains** (ethereum, base, optimism, arbitrum, polygon) — use `alchemy_getAssetTransfers`. Alchemy hostnames per chain:

| Chain | Alchemy host |
|---|---|
| ethereum | `eth-mainnet.g.alchemy.com` |
| base | `base-mainnet.g.alchemy.com` |
| optimism | `opt-mainnet.g.alchemy.com` |
| arbitrum | `arb-mainnet.g.alchemy.com` |
| polygon | `polygon-mainnet.g.alchemy.com` |

**Category support differs by chain:** `internal` is only valid on ethereum, base, and arbitrum. On optimism and polygon, pass `["external","erc20"]` only — passing `"internal"` will error.

```bash
# Ethereum / Base / Arbitrum (include "internal")
curl -s "https://eth-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"alchemy_getAssetTransfers","params":[{
    "toAddress":"0x5d698362edb8aea1c2b2483096bdee3265d860db",
    "category":["external","internal","erc20"],
    "withMetadata":true,"excludeZeroValue":true,"order":"asc"
  }]}'

# Optimism / Polygon (drop "internal")
curl -s "https://opt-mainnet.g.alchemy.com/v2/$ALCHEMY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"alchemy_getAssetTransfers","params":[{
    "toAddress":"0x5d698362edb8aea1c2b2483096bdee3265d860db",
    "category":["external","erc20"],
    "withMetadata":true,"excludeZeroValue":true,"order":"asc"
  }]}'
```

`fromBlock` can be omitted for low-volume wallets — Alchemy returns everything from genesis and we filter by `cursorsByChain[chain]` after. If any chain ever exceeds 1,000 transfers, add `"fromBlock": "0x<recent-block-hex>"` to that call.

**Gnosis** — Gnosisscan REST. Three endpoints cover inbound native xDAI (`txlist`), ERC-20 (`tokentx`), and contract-sends (`txlistinternal`). All three:

```bash
ADDR="0x5d698362edb8aea1c2b2483096bdee3265d860db"
for endpoint in tokentx txlist txlistinternal; do
  curl -s "https://api.gnosisscan.io/api?module=account&action=$endpoint&address=$ADDR&startblock=0&endblock=99999999&sort=asc&apikey=$GNOSISSCAN_API_KEY"
done
```

Only keep rows where `to == wallet` (txlist/txlistinternal return both directions). Drop rows with `isError == "1"`. If any endpoint returns `{"status":"0","message":"NOTOK","result":"Max rate limit reached"}`, wait a minute and retry — do not treat as an empty result.

For every row collected across all six chains, filter: keep only rows where `block_timestamp > cursorsByChain[chain]`. Normalize into a common shape:

- `chain`
- `tx_hash` (lowercased)
- `block_timestamp` (seconds)
- `from_address` (lowercased)
- `asset_symbol` (native symbol per chain — `ETH` on eth/base/op/arb, `MATIC` on polygon, `xDAI` on gnosis — or the ERC-20 symbol)
- `asset_address` (`null` for native; lowercased contract address for ERC-20)
- `amount_decimal` (Alchemy's `value` is already decimal-normalized; Gnosisscan returns raw string `value` that must be divided by `10 ** tokenDecimal` for tokentx, or by `1e18` for txlist/txlistinternal xDAI)

If the combined list is empty after filtering, report "No new donations since last run" and exit. No file edits.

#### Step 3 — Filter obvious spam

For each candidate, present to the user:

- `chain`, short `tx_hash`, `asset_symbol`, `amount_decimal`, short `from_address`

The user confirms which rows are real donations. Rows marked spam are discarded (not written anywhere — the skill is memoryless across runs). Real rows proceed to Step 4.

#### Step 4 — Price each donation in USD at receipt

For each approved row:

- **Stablecoins** (USDC, USDT, DAI, xDAI, FRAX, LUSD): `usd_at_receipt = amount_decimal`, `price_note = "stablecoin-1-to-1"`.
- **Native ETH / WETH:** CoinGecko `/coins/ethereum/history?date=DD-MM-YYYY` for the transfer's UTC date, read `market_data.current_price.usd`. `price_note = "coingecko-historical-YYYY-MM-DD"`.
- **Native MATIC:** CoinGecko `/coins/matic-network/history?date=DD-MM-YYYY`. `price_note = "coingecko-historical-YYYY-MM-DD"`.
- **WBTC:** CoinGecko `/coins/wrapped-bitcoin/history?date=DD-MM-YYYY`.
- **Other tokens:** ask the user for the USD value and the price source. `price_note = "manual-<brief-description>"`. Do **not** auto-resolve contract → CoinGecko id (spoofed-ticker attack).

Use the repo's existing CoinGecko auth scheme: Pro key → `https://pro-api.coingecko.com/api/v3` with `x-cg-pro-api-key` header; Demo/Analyst key → `https://api.coingecko.com/api/v3` with `x-cg-demo-api-key` header.

#### Step 5 — Resolve ENS and label donors

ENS lives on Ethereum L1 only. Look up ENS once per unique `from_address`, regardless of which chain the donation arrived on.

For each unique sender:

1. **If already present in `donations.json` on a prior row** — reuse that row's `display` value, skip lookup.
2. **If the address matches a known founder EOA** (confirm with the user on the first run; subsequent runs remember by seeing the address in the JSON with `kind: "founder"`) — set `kind: "founder"`, `display: "TokenBrice (founder subsidy)"` regardless of ENS.
3. **If the address matches a Giveth payout contract** (discovered during first Giveth test donation; same first-run confirmation flow) — set `kind: "pool"`, `display: "via Giveth"`.
4. **Otherwise** — `kind: "community"`. Look up ENS via any of these (pick whichever works — no ABI-level eth_call needed):
   - WebFetch `https://app.ens.domains/{address}` and parse the primary name shown.
   - WebFetch `https://api.ensideas.com/ens/resolve/{address}` (returns `{ name, displayName, address }`).
   - Ask the user to confirm/paste the name if the above are unavailable.

   **Forward-verify:** if a name is returned, forward-resolve it (e.g. WebFetch `https://app.ens.domains/{name}` and confirm the address matches, or ask the user to eyeball `name.eth` on Etherscan and confirm it resolves to the sender address). Only accept the name if forward-resolution matches. If anything feels off, fall back to `formatAddress(address)` — no name is better than a spoofed one.

   `display` is the verified ENS name if one exists, else `formatAddress(address)`.

#### Step 6 — Present the diff

Show the user a table of the new rows to be appended:

```
  + {chain} {tx_hash_short} {asset} {amount} → ${usd} | {display} [{kind}]
```

Flag anything uncertain:
- A `community` row with `usd > $500` — ask whether this might be the founder subsidy instead.
- An asset that required manual pricing — show the source the user gave.
- A sender with no resolved ENS — confirm it'll render as a truncated address.

If any assumption is unsafe (e.g. no confirmed founder address yet and inbound is $5k), stop and ask before writing.

#### Step 7 — Write the file

After the user approves:

1. Append each row to `donations[]` in `shared/data/funding/donations.json`, sorted by `block_timestamp` ascending relative to where it slots in (preserve oldest-first order).
2. Update `last_updated_at` to `Math.floor(Date.now() / 1000)`.
3. Save with `Edit`, not `Write` (preserve surrounding formatting).

#### Step 8 — Build and tests

```bash
npm run build 2>&1 | tail -5
npx vitest run shared/lib/funding/__tests__/helpers.test.ts
```

Expected: build completes, tests pass.

#### Step 9 — Commit

```bash
git add shared/data/funding/donations.json
git commit -m "data(funding): add {N} new donation(s) via funding-update"
```

### Quality Standards

- Never append a row you haven't personally verified on the right explorer (Etherscan, Basescan, Polygonscan, Arbiscan, Optimism explorer, or Gnosisscan depending on chain).
- `usd_at_receipt` is priced at the **transfer's block date**, not current spot — that's what makes historical coverage % meaningful.
- ENS names must be forward-verified; an un-verified reverse record is a spoofing vector.
- Spam rows are discarded, not recorded. No denylist file to maintain.
- Never modify historical rows. If a row is wrong, ask the user before editing.
- Never touch `costs.json`.

### What NOT to Do

- Do **NOT** auto-approve rows. Every new row requires explicit user confirmation.
- Do **NOT** infer the founder address or Giveth pool address — ask on first encounter.
- Do **NOT** re-resolve ENS for addresses already in the file unless the user asks.
- Do **NOT** price unknown tokens via CoinGecko contract-lookup — ask for a manual USD value instead.
- Do **NOT** retry a rate-limited Gnosisscan response by treating it as empty — wait and retry.
```

- [ ] **Step 2: Verify the skill is discoverable and run it once to backfill history**

```bash
ls -la .claude/skills/funding-update/SKILL.md
```

Expected: file exists.

Now invoke the skill once in a fresh Claude Code session: `/funding-update`. The first run will scan all 6 chains from genesis and pick up the known historical inbound tx (`0xc310bc...`). On that first run:
- Confirm Brice's EOA when the skill asks — this becomes the stored `kind: "founder"` label.
- Confirm a Giveth pool address only if you've already done a test donation; otherwise skip and revisit after the first Giveth payout.
- Approve the appended rows.

If the skill errors on missing `ALCHEMY_API_KEY` / `GNOSISSCAN_API_KEY` / `COINGECKO_API_KEY`, add them to your shell and re-run. The skill does not need to be run every time — after the backfill it's a manual weekly invocation.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/funding-update/
git commit -m "skill(funding-update): weekly donations research and append"
```

---

## Task 6: Documentation

**Files:**
- Create: `docs/funding-page.md`
- Modify: `docs/architecture.md`

**Why no `docs/api-reference.md` update:** there is no new API endpoint.

- [ ] **Step 1: Create `docs/funding-page.md`**

```markdown
# Funding page

Public ledger of Pharos's running costs and the donations that cover them. Stealth-released — `robots: noindex` and no navigation entry in v1.

## Data model

Two hand-maintained JSON files:

- `shared/data/funding/costs.json` — monthly cost line items. Owned by @TokenBrice; reviewed on the 1st of each month. `last_reviewed_at` (UTC unix seconds) is surfaced on the page footer so readers see freshness.
- `shared/data/funding/donations.json` — every inbound donation, one row each. Populated via the `funding-update` Claude skill on a ~weekly cadence.

Row shape for donations is defined in `shared/lib/funding/types.ts` (`Donation`). Each row carries `usd_at_receipt` priced at the transfer's block date, a `kind` field (`founder | pool | community`), and a `display` field with either a forward-verified ENS name or a human label.

## Intentional simplifications

- **No cron, no D1, no API.** The page imports both JSON files at build time and renders server-side. Static export is trivially CDN-cacheable.
- **No chart.** Until ≥6 months of donation history exist, a bar chart adds visual weight without showing anything meaningful. Revisit when the trailing window is populated.
- **No historical-pricing pipeline.** The `funding-update` skill prices each donation once at append time using CoinGecko for native assets and $1 for stablecoins; results are recorded in `price_note` on each row.
- **No ENS resolver module.** ENS reverse + forward-verify runs once per new address during the skill's run; results are frozen into `display` on the row.
- **No spam filter module.** Unknown-token pricing requires a manual USD value from the user, which naturally gates out spoofed-ticker spam.

If donation volume grows to the point where hand-curation becomes painful, promote the skill to a worker cron (daily Alchemy scan → D1 → `/api/funding-summary` endpoint). Everything the page renders is already derivable from what the skill writes, so the frontend does not need to change.

## Ownership & cadence

- `costs.json` — reviewed 1st of each month; bump `last_reviewed_at` every time you edit.
- `donations.json` — `funding-update` skill invoked ~weekly, or ad-hoc on alert. `last_updated_at` is bumped automatically by the skill.

## Voice

Match `/about`: honest, plain, concrete. No urgency, no banners, no modals. See the design spec at `agents/plans/2026-04-18-funding-page-design.md` for voice substitutions and the "nouns not verbs in card titles" rule.

## Related files

- Route: `src/app/funding/page.tsx`
- Sections: `src/components/funding/funding-page-sections.tsx`
- Helpers + types: `shared/lib/funding/`
- Data: `shared/data/funding/`
- Skill: `.claude/skills/funding-update/SKILL.md`
```

- [ ] **Step 2: Update `docs/architecture.md`**

Read `docs/architecture.md` first to see where subsystem descriptions live (there's typically a section list toward the top and per-subsystem detail below). Add a short entry:

```markdown
### Funding page

The `/funding` route is a static page backed by two hand-maintained JSON files in `shared/data/funding/` (costs and donations). No cron, no D1, no API endpoint. Donations are appended to `donations.json` via the `funding-update` Claude skill on a weekly cadence — the skill researches inbound transfers to `pharos-watch.eth`, prices each donation in USD at receipt, resolves ENS, and writes after user approval. See `docs/funding-page.md` for the data model and the rationale for the intentionally-simple architecture.
```

Place it alongside other subsystem entries. Do **not** add a row to the API-endpoint table — there is no new endpoint.

- [ ] **Step 3: Commit**

```bash
git add docs/funding-page.md docs/architecture.md
git commit -m "docs(funding): methodology and architecture entry for /funding"
```

---

## Task 7: Final verification

- [ ] **Step 1: Run the merge gate**

```bash
npm run test:merge-gate
```

Expected: passes. Fix failures locally before pushing.

- [ ] **Step 2: Full build + test run**

```bash
npm run build 2>&1 | tail -10
npm test 2>&1 | tail -20
```

Expected: build completes; all tests pass; `/funding` listed in the route output.

- [ ] **Step 3: Manual browser smoke**

```bash
npm run dev
```

At `http://localhost:3000/funding`, verify:

- Both 375px (mobile) and desktop viewports render without overflow.
- Light and dark themes both look right (toggle via the theme switch).
- Wallet copy button copies the EIP-55 checksummed address.
- External links (Giveth, GitHub) open in a new tab.
- `buildExplorerUrl` returns a usable URL for each chain your donor list references — if gnosis returns null, the explorer link is correctly omitted (not shown as a broken icon).
- The "Skip to how to support" anchor scrolls to the `#how-to-support` section.
- No console errors or warnings.

If the donor list is empty (no donations yet), verify the empty-state copy reads correctly.

- [ ] **Step 4: Delete the old plan file**

With v2 merged, the old overengineered plan is confusing — remove it so future readers see only the one in force.

```bash
git rm agents/plans/2026-04-18-funding-page-implementation-plan.md
git commit -m "chore(funding): drop superseded v1 implementation plan"
```

(The design spec at `agents/plans/2026-04-18-funding-page-design.md` stays — it's still the voice and copy source of truth.)

---

## Done

`/funding` is live behind the URL only — `robots: noindex`, no nav entry. Next donation? Invoke `/funding-update` in Claude Code, approve the diff, commit. If donations grow enough to make manual curation painful, revisit the worker-cron path that the original v1 plan sketched — but the frontend surface will not need to change because all it reads is `donations.json` and `costs.json`, and the skill already writes exactly those fields.

---

## Self-review checklist

Design spec coverage:

- Lead paragraphs — Task 4 Step 1 ✓
- KPI cards (simplified from 3 to 2: this-month coverage + community support) — Task 3 ✓
- Monthly chart — **intentionally dropped**; rationale in `docs/funding-page.md`
- Cost breakdown with team/infra groups and total — Task 3 `CostBreakdown` ✓
- Donor wall with ENS, chain-aware explorer links — Task 3 `DonorList` ✓
- Support CTAs with wallet + Giveth emphasized + 3 compact secondary — Task 3 `SupportCtas` ✓
- Year-end horizon paragraph + share link — Task 3 `YearEndHorizon` ✓
- FAQ (3 Q/A, ≤80 words) — Task 3 `FundingFaq` ✓
- Stealth release (`robots: noindex`, no nav) — Task 4 metadata ✓
- Founder vs community accounting — `kind` field on donation rows + `summarizeDonations` helper ✓
- Honest cost snapshot freshness — `last_reviewed_at` surfaced in `CostBreakdown` footer ✓
- Honest donations freshness — `last_updated_at` surfaced in `DonorList` footer ✓
- Pricing methodology disclosure — `price_note` per row + `docs/funding-page.md` section ✓
- Voice: nouns not verbs in card titles; no urgency/banners/modals — Task 3 copy ✓

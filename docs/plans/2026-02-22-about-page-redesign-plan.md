# About Page Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the dense, text-heavy about page with a scannable overview featuring a feature icon grid and data pipeline diagram.

**Architecture:** Single-file rewrite of `src/app/about/page.tsx`. No new components or files — everything stays in the page component. The FAQPage JSON-LD is updated to match the trimmed content. Pure CSS/Tailwind for visuals (no SVG dependencies).

**Tech Stack:** Next.js 16, React 19, Tailwind CSS v4, Lucide React icons, shadcn/ui Card components.

---

### Task 1: Rewrite the About Page

**Files:**
- Modify: `src/app/about/page.tsx` (full rewrite, keep metadata + JSON-LD)

**Step 1: Rewrite the page**

Replace the entire `AboutPage` component and its imports. Keep the `metadata` export. The new page has 5 sections:

**Section 1 — Hero / Why Pharos:**
```tsx
// Breadcrumb + h1 (unchanged pattern)
// Card with sky-500 left border:
//   - TokenBrice avatar (Image, 80x80, rounded-xl)
//   - 3 sentences max: personal project by TokenBrice + Claude, stablecoin data in one place, open for others
//   - Same external links to tokenbrice.xyz and anthropic.com/claude-code
```

**Section 2 — What Pharos Tracks (feature grid):**
Replace the bullet list with a 2x3 responsive grid. Each cell is a small card with:
- Lucide icon (colored to match the section theme)
- Bold title
- One-liner description (no paragraphs)

Grid items:
1. `BarChart3` icon, amber — "{TRACKED_STABLECOINS.length} Stablecoins" / "Tracked across every major chain, classified by governance, backing, and peg currency"
2. `Skull` icon, zinc — "{DEAD_STABLECOINS.length} in the Cemetery" / "Algorithmic failures, rug pulls, regulatory shutdowns, and quiet abandonments"
3. `ShieldAlert` icon, red — "Freeze Tracking" / "USDC, USDT, PAXG & XAUT blacklist events on Ethereum, Arbitrum, Base, Optimism, Polygon, Avalanche, BSC, and Tron"
4. `Activity` icon, emerald — "Peg Tracker" / "Composite peg scores, depeg event detection, heatmaps, and 4 years of history" (link to /peg-tracker)
5. `ShieldCheck` icon, blue — "Safety Ratings" / "Independent Bluechip SMIDGE grades for rated stablecoins" (link to bluechip.org)
6. `Droplets` icon, cyan — "DEX Liquidity" / "Pool depth, volume, quality-adjusted TVL, durability, and cross-chain presence scored 0-100" (link to /liquidity)

Layout: `grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4`

Each card: Card component with `rounded-2xl` and no left border (keep it clean). Icon + title in a flex row, description below.

**Section 3 — Classification (trimmed):**
Card with violet-500 left border. 2-3 sentences explaining CeFi / CeFi-Dependent / DeFi. Use `<span>` with font-medium for the tier names. Example:

> Pharos classifies stablecoins into three governance tiers: **CeFi** (fully centralized), **CeFi-Dependent** (decentralized infrastructure but reliant on centralized collateral or peg mechanisms), and **DeFi** (fully on-chain, no centralized custody dependency). This reflects actual infrastructure dependency, not marketing claims.

Cut the second paragraph with examples.

**Section 4 — Data Pipeline diagram:**
Card with zinc-500 left border. Title: "Data Sources & Pipeline".

One-liner intro: "All data is fetched server-side by a Cloudflare Worker and cached in D1. The browser never calls external APIs."

Then a CSS flow diagram with three columns:

```
[Sources]  →  [Worker + D1]  →  [Dashboard]
```

Left column (Sources) groups:
- **Supply & Price**: DefiLlama, CoinGecko, CoinMarketCap, DexScreener
- **On-chain Events**: Etherscan v2, TronGrid
- **Ratings & Reference**: Bluechip, ECB (frankfurter.app), Exchange Rate API, metals.dev
- **DEX Data**: DeFiLlama Yields, Curve Finance API

Middle column: Cloudflare Worker + D1 icon/box

Right column: Static Next.js dashboard on Cloudflare Pages

Implementation: Use a responsive layout:
- Desktop (`md:` and up): 3-column grid with arrow elements between columns
- Mobile: vertical stack with downward arrows

Arrows: Use `→` characters or CSS `::after` pseudo-elements. Keep it simple — Tailwind borders + text, no SVG.

**Section 5 — Footer:**
Unchanged. GitHub link + contact.

**JSON-LD update:**
Update the FAQPage structured data to match the trimmed content. Remove the Peg Score and Liquidity Score detailed methodology answers. Trim "What does Pharos track?" to match the new one-liners.

**Imports needed:**
```tsx
import { Activity, BarChart3, Droplets, ExternalLink, Github, ShieldAlert, ShieldCheck, Skull } from "lucide-react";
```

**Step 2: Build and type-check**

Run: `cd /home/ahirice/Documents/git/stablecoin-dashboard && npm run build`
Expected: Build succeeds with no type errors.

**Step 3: Visual review**

Run: `npm run dev`
Check in browser:
- Desktop: feature grid is 3-col, pipeline diagram is 3-col horizontal
- Mobile (375px): feature grid is 1-col, pipeline stacks vertically
- All links work (peg-tracker, liquidity, bluechip.org, tokenbrice.xyz, GitHub)
- No horizontal overflow on any viewport

**Step 4: Commit**

```bash
git add src/app/about/page.tsx
git commit -m "Redesign about page: trim copy, add feature grid and pipeline diagram"
```

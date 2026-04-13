# Safety Scores Star Page Revamp

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the safety-scores page from a competent data table into an opinionated, narrative-driven star feature that makes visitors feel *informed* the moment they land.

**Architecture:** Restructure the page hierarchy to lead with provocative data (systemic risk headline + grade distribution), elevate the contagion simulator from a hidden accordion to a visible hero, add grade-grouped sections to the card grid for scanability, and inject editorial confidence through headline stats and sharper copy. Remove the underwhelming TopGradeSpotlight card. Fix minor UX issues (sticky banner offset, sort button labels, skeleton count, FAQ gaps).

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, shadcn/ui, Recharts, TanStack Query

**Design context:** Dark-first financial dashboard. Users are crypto-native power users who value density, precision, speed-to-insight. Target emotion: *informed*. See `docs/design-context.md`.

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `src/app/safety-scores/client.tsx` | Main client component — restructure layout, remove TopGradeSpotlight, add headline stats, grade-grouped grid, fix sticky offset, fix sort labels, adjust skeleton count |
| Modify | `src/app/safety-scores/page.tsx` | Shell config — distill lead paragraphs, move Telegram callout to afterClient, add FAQ items |
| Modify | `src/components/stress-test-panel.tsx` | Refactor into two parts: a visible risk headline card + the full expandable simulator |
| Create | `src/components/systemic-risk-headline.tsx` | Extracted "above the fold" systemic risk teaser — top 3 risks with $ at risk, CTA to open full simulator |
| Modify | `shared/lib/report-card-core.ts` | Fix dimension short labels ("Decent." → "Decen." already done, verify "Depend." → "Dep.") |

No new hooks, no new shared types, no new API calls — this is purely a presentation-layer restructure using data already fetched.

---

### Task 1: Distill the above-fold area (page shell)

**Files:**
- Modify: `src/app/safety-scores/page.tsx`

Restructure the shell to lead with data, not text. Compress lead paragraphs to one punchy line. Move the Telegram callout banner from `beforeClient` to `afterClient` (before FAQ). Add 3 new FAQ items.

- [ ] **Step 1.1: Read current page.tsx**

Verify current state matches the plan's assumptions (2 lead paragraphs, beforeClient = CalloutBanner, afterClient = FaqSection, 2 FAQ items).

- [ ] **Step 1.2: Compress lead paragraphs to one line**

In `src/app/safety-scores/page.tsx`, replace:

```tsx
leadParagraphs: [
  "Safety grades and contagion simulation for every tracked stablecoin.",
  "Each stablecoin receives a letter grade from A+ to F based on five dimensions: peg stability, liquidity depth, transparency, resilience, and regulatory standing. The contagion simulator lets you model what happens to the broader market when a major stablecoin fails, revealing hidden dependency chains and systemic risk.",
],
```

with:

```tsx
leadParagraphs: [
  "Letter grades from A+ to F for every tracked stablecoin, plus contagion simulation to model cascading failures.",
],
```

- [ ] **Step 1.3: Move Telegram callout from beforeClient to afterClient, before FAQ**

Replace the `beforeClient` and `afterClient` props:

Remove `beforeClient` entirely.

Change `afterClient` from:

```tsx
afterClient: <FaqSection items={FAQ_ITEMS} includeJsonLd />,
```

to:

```tsx
afterClient: (
  <>
    <CalloutBanner icon={<Bell className="h-4 w-4" />} className="border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300">
      Get notified when a safety grade changes.{" "}
      <Link
        href="/telegram#bot"
        className="text-foreground underline underline-offset-4 hover:text-foreground/80 transition-colors"
      >
        Set up alerts&nbsp;&rarr;
      </Link>
    </CalloutBanner>
    <FaqSection items={FAQ_ITEMS} includeJsonLd />
  </>
),
```

- [ ] **Step 1.4: Add 3 new FAQ items**

Add these to the `FAQ_ITEMS` array:

```tsx
{
  question: "How often do safety grades change?",
  answer:
    "Grades are recomputed every cron cycle (roughly every 30 minutes) as new data arrives. In practice, most grades are stable day-to-day. Significant shifts happen when peg deviations spike, liquidity pools drain, or governance changes are enacted. You can set up Telegram alerts to get notified the moment a grade changes.",
},
{
  question: "What should I do with this information?",
  answer:
    "Safety grades are one input into your own risk assessment, not financial advice. Use them to identify which stablecoins carry hidden dependency risk, compare liquidity depth before choosing an exit route, and stress-test your portfolio assumptions with the contagion simulator. The grade breakdown on each coin's detail page explains exactly what drove the score.",
},
{
  question: "Why do most stablecoins receive a C grade?",
  answer:
    "A C grade (score 50–64) is the statistical center of the grading distribution. It means the coin meets baseline requirements but has meaningful weaknesses in at least one dimension — typically limited liquidity, moderate dependency risk, or weaker decentralization. Only coins that excel across all five dimensions reach A or B territory.",
},
```

- [ ] **Step 1.5: Verify the build compiles**

Run: `cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm run build 2>&1 | tail -20`
Expected: Build succeeds, no type errors.

- [ ] **Step 1.6: Commit**

```bash
git add src/app/safety-scores/page.tsx
git commit -m "refactor(safety-scores): distill above-fold, move callout below grid, expand FAQ"
```

---

### Task 2: Extract systemic risk headline component

**Files:**
- Create: `src/components/systemic-risk-headline.tsx`
- Modify: `src/hooks/use-stress-test.ts` (read-only — verify interface)

Build a new component that surfaces the top 3 systemic risks above the fold. This replaces the TopGradeSpotlight and gives the contagion simulator a visible entry point.

- [ ] **Step 2.1: Verify StressTestState interface**

Read `src/hooks/use-stress-test.ts` and confirm that `systemicRisks` has `coinId`, `name`, `symbol`, `affectedCount`, `supplyAtRisk` fields, and that the hook is already instantiated in the client component.

- [ ] **Step 2.2: Create systemic-risk-headline.tsx**

```tsx
"use client";

import { Card, CardContent } from "@/components/ui/card";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { formatCurrency } from "@shared/lib/format";
import { Network } from "lucide-react";
import { cn } from "@/lib/utils";

interface SystemicRisk {
  coinId: string;
  name: string;
  symbol: string;
  affectedCount: number;
  supplyAtRisk: number;
}

interface SystemicRiskHeadlineProps {
  risks: SystemicRisk[];
  logos?: Record<string, string>;
  onOpenSimulator: () => void;
}

export function SystemicRiskHeadline({ risks, logos, onOpenSimulator }: SystemicRiskHeadlineProps) {
  const top3 = risks.slice(0, 3);
  if (top3.length === 0) return null;

  const totalAtRisk = top3.reduce((sum, r) => sum + r.supplyAtRisk, 0);

  return (
    <Card className="border-rose-500/15 bg-rose-500/[0.03]">
      <CardContent className="py-5">
        <div className="flex items-start gap-3 mb-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-rose-500/15">
            <Network className="h-4 w-4 text-rose-600 dark:text-rose-400" aria-hidden="true" />
          </div>
          <div>
            <p className="text-sm font-semibold text-rose-700 dark:text-rose-400">
              What happens if a major stablecoin fails?
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {formatCurrency(totalAtRisk)} in downstream supply depends on just {top3.length} coins.{" "}
              <button
                type="button"
                onClick={onOpenSimulator}
                className="pharos-focus-ring text-foreground underline underline-offset-4 hover:text-foreground/80 transition-colors"
              >
                Run a simulation&nbsp;&darr;
              </button>
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {top3.map((risk, i) => (
            <div
              key={risk.coinId}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm",
                i === 0 ? "bg-rose-500/10 border border-rose-500/20" : "bg-muted/30"
              )}
            >
              <span
                className={cn(
                  "flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold shrink-0",
                  i === 0 ? "bg-rose-500 text-white" : "bg-muted text-muted-foreground"
                )}
              >
                {i + 1}
              </span>
              <StablecoinLogo src={logos?.[risk.coinId]} name={risk.symbol} size={20} />
              <div className="min-w-0 flex-1">
                <span className="font-medium text-sm block truncate">{risk.symbol}</span>
                <span className="text-xs text-muted-foreground">
                  {risk.affectedCount} dependent{risk.affectedCount !== 1 ? "s" : ""}
                </span>
              </div>
              <span className="font-mono text-xs font-semibold text-muted-foreground">
                {formatCurrency(risk.supplyAtRisk)}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2.3: Verify the build compiles**

Run: `cd /Users/ahirice/Documents/git/stablecoin-dashboard && npx tsc --noEmit 2>&1 | tail -10`
Expected: No type errors.

- [ ] **Step 2.4: Commit**

```bash
git add src/components/systemic-risk-headline.tsx
git commit -m "feat(safety-scores): add systemic risk headline component"
```

---

### Task 3: Restructure client.tsx — remove TopGradeSpotlight, add headline stats, wire risk headline

**Files:**
- Modify: `src/app/safety-scores/client.tsx`

This is the main restructuring task. The new page order becomes:

1. Error/stale banners (unchanged)
2. **Headline stats row** (new — 3 compact stats: ecosystem average score, % of supply in A/B grades, total coins graded)
3. **Grade distribution hero** (existing, unchanged)
4. **Systemic risk headline** (new — replaces TopGradeSpotlight)
5. **Contagion simulator** (existing, but default-open when risks exist)
6. Filter/sort controls (existing)
7. Simulation banner (existing, fix sticky offset)
8. **Grade-grouped card grid** (enhanced — section headers between grade tiers)
9. Results count (move above grid)

- [ ] **Step 3.1: Remove TopGradeSpotlight component and its usage**

Delete the entire `TopGradeSpotlight` function (lines ~115–151 in current file). Delete the `topGradeCoin` useMemo (lines ~428–434). Delete the JSX block that renders it (the `{topGradeCoin && !isSimulating && (` block, lines ~531–537). Remove the `Trophy` import from lucide-react.

- [ ] **Step 3.2: Add headline stats row**

Add a new component inside `client.tsx` (above `ReportCardsClient`):

```tsx
function HeadlineStats({
  cards,
  mcapMap,
}: {
  cards: ReportCard[];
  mcapMap: Map<string, number>;
}) {
  const activeCards = cards.filter((c) => !c.isDefunct && c.overallScore != null);
  if (activeCards.length === 0) return null;

  // Average score
  const avgScore = Math.round(
    activeCards.reduce((sum, c) => sum + (c.overallScore ?? 0), 0) / activeCards.length
  );

  // % of total supply in A or B grade
  const totalSupply = activeCards.reduce((sum, c) => sum + (mcapMap.get(c.id) ?? 0), 0);
  const abSupply = activeCards
    .filter((c) => {
      const range = gradeRange(c.overallGrade);
      return range === "A" || range === "B";
    })
    .reduce((sum, c) => sum + (mcapMap.get(c.id) ?? 0), 0);
  const abPct = totalSupply > 0 ? Math.round((abSupply / totalSupply) * 100) : 0;

  // Weakest dimension across the ecosystem
  const dimAvgs = DIMENSION_ORDER_LOCAL.map((key) => {
    const scores = activeCards.map((c) => c.dimensions[key].score).filter((s): s is number => s != null);
    return { key, avg: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0 };
  });
  const weakest = dimAvgs.reduce((a, b) => (a.avg < b.avg ? a : b));

  const stats = [
    { label: "Ecosystem avg.", value: String(avgScore), detail: scoreToGrade(avgScore) },
    { label: "Supply in A/B", value: `${abPct}%`, detail: formatCurrency(abSupply) },
    { label: "Weakest dimension", value: DIMENSION_SHORT_LABELS_LOCAL[weakest.key], detail: `avg ${Math.round(weakest.avg)}` },
  ];

  return (
    <div className="grid grid-cols-3 gap-3">
      {stats.map((s) => (
        <div key={s.label} className="rounded-lg border border-border/50 bg-card/50 px-3 py-2.5 text-center">
          <p className="pharos-kicker">{s.label}</p>
          <p className="text-lg font-bold font-mono tracking-tight">{s.value}</p>
          <p className="text-xs text-muted-foreground font-mono">{s.detail}</p>
        </div>
      ))}
    </div>
  );
}
```

Note: You will need local references to `DIMENSION_ORDER` and `DIMENSION_SHORT_LABELS` — import them from `@shared/lib/report-cards`:

```tsx
import {
  gradeRange,
  REPORT_CARD_GRADE_COLORS,
  scoreToGrade,
  DIMENSION_ORDER as DIMENSION_ORDER_LOCAL,
  DIMENSION_SHORT_LABELS as DIMENSION_SHORT_LABELS_LOCAL,
} from "@shared/lib/report-cards";
import { formatCurrency } from "@shared/lib/format";
```

- [ ] **Step 3.3: Wire the systemic risk headline and add state for simulator open/close**

Import the new component:

```tsx
import { SystemicRiskHeadline } from "@/components/systemic-risk-headline";
```

In `StressTestPanel`, the accordion is controlled by internal `isOpen` state. To allow the risk headline's "Run a simulation" button to open it, add a ref-based approach. In `ReportCardsClient`, add:

```tsx
const simulatorRef = useRef<HTMLDivElement>(null);

const handleOpenSimulator = useCallback(() => {
  // Scroll to the simulator and let the user see it
  simulatorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  // Dispatch a custom event that StressTestPanel listens for
  simulatorRef.current?.dispatchEvent(new CustomEvent("pharos:open-simulator", { bubbles: true }));
}, []);
```

Wrap the StressTestPanel in a div with the ref:

```tsx
<div ref={simulatorRef}>
  <StressTestPanel stressTest={stressTest} mcapMap={mcapMap} logos={logos} defaultOpen />
</div>
```

Add `defaultOpen` as a new prop to `StressTestPanel` (see Task 4).

- [ ] **Step 3.4: Assemble the new page order in JSX**

Replace the JSX return in `ReportCardsClient` with this structure (pseudocode for clarity — actual JSX follows the same component calls):

```tsx
return (
  <div className="space-y-6">
    {/* 1. Error/stale banners — unchanged */}
    <QueryErrorNotice ... />
    <StaleDataBanner ... />

    {/* 2. Headline stats */}
    {reportData?.cards && (
      <HeadlineStats cards={reportData.cards} mcapMap={mcapMap} />
    )}

    {/* 3. Grade distribution hero — unchanged */}
    <Card>
      <CardContent className="pt-6 pb-6">
        <GradeDistributionHero ... />
      </CardContent>
    </Card>

    {/* 4. Systemic risk headline — NEW, replaces TopGradeSpotlight */}
    {!isSimulating && stressTest.systemicRisks.length > 0 && (
      <SystemicRiskHeadline
        risks={stressTest.systemicRisks}
        logos={logos}
        onOpenSimulator={handleOpenSimulator}
      />
    )}

    {/* 5. Contagion simulator — now default-open */}
    <div ref={simulatorRef}>
      <StressTestPanel stressTest={stressTest} mcapMap={mcapMap} logos={logos} defaultOpen />
    </div>

    {/* 6. Filter/sort controls — unchanged */}
    ...

    {/* 7. Simulation banner — fix sticky offset */}
    ...

    {/* 8. Results count — moved above grid */}
    ...

    {/* 9. Card grid — enhanced with grade group headers */}
    ...
  </div>
);
```

- [ ] **Step 3.5: Fix the simulation sticky banner offset**

Change line ~606 from:

```tsx
<div className="sticky top-16 z-30 ...
```

to:

```tsx
<div className="sticky top-14 z-30 ...
```

(`top-14` = 56px matches the mobile header height `h-14`.)

- [ ] **Step 3.6: Fix sort button abbreviations**

In the `SORT_OPTIONS` array, change:

```tsx
{ key: "decentralization", label: "Decent." },
{ key: "dependencyRisk", label: "Depend." },
```

to:

```tsx
{ key: "decentralization", label: "Decen." },
{ key: "dependencyRisk", label: "Dep. Risk" },
```

- [ ] **Step 3.7: Adjust loading skeleton count**

Change the skeleton grid from 15 cards to 24 (fills 4 rows at 6-col layout, closer to above-fold reality without being jarring):

```tsx
{Array.from({ length: 24 }, (_, i) => (
```

- [ ] **Step 3.8: Verify the build compiles**

Run: `cd /Users/ahirice/Documents/git/stablecoin-dashboard && npx tsc --noEmit 2>&1 | tail -10`
Expected: No type errors.

- [ ] **Step 3.9: Commit**

```bash
git add src/app/safety-scores/client.tsx
git commit -m "refactor(safety-scores): restructure page hierarchy, add headline stats, wire risk headline"
```

---

### Task 4: Update StressTestPanel to support defaultOpen prop

**Files:**
- Modify: `src/components/stress-test-panel.tsx`

Add a `defaultOpen` prop so the simulator panel renders open by default when the page loads, and listen for the custom event from the risk headline.

- [ ] **Step 4.1: Add defaultOpen prop**

Update the props interface:

```tsx
interface StressTestPanelProps {
  stressTest: StressTestState;
  mcapMap: Map<string, number>;
  logos?: Record<string, string>;
  defaultOpen?: boolean;
}
```

Update the component signature and state:

```tsx
export function StressTestPanel({ stressTest, mcapMap, logos, defaultOpen = false }: StressTestPanelProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
```

- [ ] **Step 4.2: Listen for the pharos:open-simulator custom event**

Add an effect after the `isOpen` state:

```tsx
const panelRef = useRef<HTMLDivElement>(null);

useEffect(() => {
  const el = panelRef.current;
  if (!el) return;
  const handler = () => setIsOpen(true);
  el.addEventListener("pharos:open-simulator", handler);
  return () => el.removeEventListener("pharos:open-simulator", handler);
}, []);
```

Wrap the Card in a div with the ref:

```tsx
return (
  <div ref={panelRef}>
    <Card>
      ...
    </Card>
  </div>
);
```

Wait — since `StressTestPanel` is already wrapped in a `<div ref={simulatorRef}>` in the parent, the custom event will bubble up. But the listener needs to be on the StressTestPanel's own container. Actually, simplify: just use the Card's own wrapper. Alternatively, skip the custom event approach entirely and just accept an `isOpenOverride` callback prop. Simpler:

Replace the custom event approach with a controlled prop pattern. In `client.tsx`:

```tsx
const [simulatorOpen, setSimulatorOpen] = useState(true);

const handleOpenSimulator = useCallback(() => {
  setSimulatorOpen(true);
  simulatorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
}, []);
```

And pass to StressTestPanel:

```tsx
<StressTestPanel
  stressTest={stressTest}
  mcapMap={mcapMap}
  logos={logos}
  isOpen={simulatorOpen}
  onOpenChange={setSimulatorOpen}
/>
```

Update `StressTestPanel` to accept controlled open state:

```tsx
interface StressTestPanelProps {
  stressTest: StressTestState;
  mcapMap: Map<string, number>;
  logos?: Record<string, string>;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function StressTestPanel({ stressTest, mcapMap, logos, isOpen: controlledOpen, onOpenChange }: StressTestPanelProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = controlledOpen ?? internalOpen;
  const setIsOpen = onOpenChange ?? setInternalOpen;
```

This keeps the component backward-compatible (uncontrolled by default) while allowing the parent to drive state.

- [ ] **Step 4.3: Verify the build compiles**

Run: `cd /Users/ahirice/Documents/git/stablecoin-dashboard && npx tsc --noEmit 2>&1 | tail -10`
Expected: No type errors.

- [ ] **Step 4.4: Commit**

```bash
git add src/components/stress-test-panel.tsx src/app/safety-scores/client.tsx
git commit -m "feat(stress-test): support controlled open state for simulator panel"
```

---

### Task 5: Add grade-grouped sections to the card grid

**Files:**
- Modify: `src/app/safety-scores/client.tsx`

Replace the flat card grid with grade-grouped sections. When no grade filter is active, insert section headers between grade tiers (A, B, C, D, F, NR) to break the monotony and give the grid a narrative structure.

- [ ] **Step 5.1: Build the grouped rendering logic**

Add a helper function inside `client.tsx`:

```tsx
function groupByGrade(cards: ReportCard[]): { grade: string; cards: ReportCard[] }[] {
  const groups = new Map<string, ReportCard[]>();
  for (const card of cards) {
    const range = gradeRange(card.overallGrade);
    const existing = groups.get(range);
    if (existing) {
      existing.push(card);
    } else {
      groups.set(range, [card]);
    }
  }
  // Preserve A → B → C → D → F → NR order
  return GRADE_RANGES.filter((g) => groups.has(g)).map((g) => ({ grade: g, cards: groups.get(g)! }));
}
```

- [ ] **Step 5.2: Add grade section header component**

```tsx
const GRADE_SECTION_DESCRIPTIONS: Record<string, string> = {
  A: "Top tier — strong across all dimensions",
  B: "Above average — solid fundamentals with minor gaps",
  C: "Middle ground — meets baseline but has weaknesses",
  D: "Below average — significant risk in multiple areas",
  F: "Critical — major concerns across dimensions",
  NR: "Not yet rated — insufficient data",
};

function GradeSectionHeader({ grade, count }: { grade: string; count: number }) {
  return (
    <div className="col-span-full flex items-center gap-3 pt-2">
      <span
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold font-mono",
          GRADE_BAR_COLORS[grade]?.split(" ")[0] ?? "bg-muted",
          "text-white"
        )}
      >
        {grade}
      </span>
      <div className="min-w-0">
        <span className="text-sm font-medium">
          {count} {count === 1 ? "coin" : "coins"}
        </span>
        <span className="text-xs text-muted-foreground ml-2">
          {GRADE_SECTION_DESCRIPTIONS[grade] ?? ""}
        </span>
      </div>
      <div className="flex-1 border-t border-border/40" />
    </div>
  );
}
```

- [ ] **Step 5.3: Replace the flat grid with grouped rendering**

Replace the card grid JSX. When `gradeFilter === "all"` (no filter active), render grouped sections. When a specific grade is filtered, render flat (the group header would be redundant since all cards share the same grade).

```tsx
{filteredCards.length === 0 ? (
  <div className="text-center py-12 space-y-2">
    <p className="text-sm text-muted-foreground">No coins match this filter.</p>
    {gradeFilter !== "all" && (
      <Button variant="outline" size="sm" onClick={() => setGradeFilter("all")} className="pharos-focus-ring">
        Clear filter
      </Button>
    )}
  </div>
) : gradeFilter === "all" && !isSimulating ? (
  // Grouped by grade
  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
    {groupByGrade(filteredCards).map((group) => (
      <Fragment key={group.grade}>
        <GradeSectionHeader grade={group.grade} count={group.cards.length} />
        {group.cards.map((card, i) => (
          <LazyCard key={card.id}>
            <ReportCardMini
              card={card}
              logo={logos?.[card.id]}
              isSimulated={affectedIds.has(card.id)}
              isSimulating={isSimulating}
              originalGrade={originalCardMap.get(card.id)?.overallGrade}
              originalScore={originalCardMap.get(card.id)?.overallScore}
              animIndex={i % 5}
            />
          </LazyCard>
        ))}
      </Fragment>
    ))}
  </div>
) : (
  // Flat grid (filtered or simulating)
  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
    {filteredCards.map((card, i) => (
      <LazyCard key={card.id}>
        <ReportCardMini
          card={card}
          logo={logos?.[card.id]}
          isSimulated={affectedIds.has(card.id)}
          isSimulating={isSimulating}
          originalGrade={originalCardMap.get(card.id)?.overallGrade}
          originalScore={originalCardMap.get(card.id)?.overallScore}
          animIndex={i % 5}
        />
      </LazyCard>
    ))}
  </div>
)}
```

Add the `Fragment` import at top: `import { Fragment } from "react";` (or use `React.Fragment` — `Fragment` is already importable from React 19).

- [ ] **Step 5.4: Move results count above the grid**

Move the "Showing X coins" paragraph to render before the grid, not after the filter controls. Also make it slightly more prominent:

```tsx
{filteredCards.length > 0 && (
  <div className="flex items-center justify-between">
    <p className="text-sm text-muted-foreground">
      Showing <span className="font-medium text-foreground">{filteredCards.length}</span>{" "}
      {filteredCards.length === 1 ? "coin" : "coins"}
      {gradeFilter !== "all" && ` with grade ${gradeFilter}`}
    </p>
  </div>
)}
```

- [ ] **Step 5.5: Verify the build compiles**

Run: `cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm run build 2>&1 | tail -20`
Expected: Build succeeds.

- [ ] **Step 5.6: Commit**

```bash
git add src/app/safety-scores/client.tsx
git commit -m "feat(safety-scores): add grade-grouped sections to card grid"
```

---

### Task 6: Visual polish pass — `/impeccable:arrange` + `/impeccable:bolder`

**Files:**
- Modify: `src/app/safety-scores/client.tsx`
- Modify: `src/components/systemic-risk-headline.tsx`
- Modify: `src/components/stress-test-panel.tsx`

After all structural changes are in place, run two impeccable passes:

- [ ] **Step 6.1: Run `/impeccable:arrange`**

Use the `/impeccable:arrange` skill on the safety-scores page to evaluate and improve layout rhythm, spacing, visual hierarchy between the new sections (headline stats → grade distribution → risk headline → simulator → grid). The skill should assess whether the vertical spacing, section separators, and visual weight transitions feel intentional.

Target areas:
- Spacing between headline stats and grade distribution hero
- Visual transition from grade distribution (informational) to risk headline (provocative)
- Breathing room between simulator panel and filter controls
- Grade section headers — make sure they read as structural dividers, not just labels

- [ ] **Step 6.2: Run `/impeccable:bolder`**

Use the `/impeccable:bolder` skill specifically on the systemic risk headline component. The current design is functional but should feel more assertive — this is the "what happens if a major stablecoin fails?" moment. The skill should evaluate whether the risk card carries enough visual weight to stop scrolling and provoke curiosity.

Target areas:
- The headline text "What happens if a major stablecoin fails?" should feel like a question worth answering
- The dollar amount (e.g., "$42B in downstream supply") should feel consequential
- The "Run a simulation" CTA should feel inviting, not buried

- [ ] **Step 6.3: Verify the build compiles and run lint**

Run: `cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm run build && npm run lint 2>&1 | tail -20`
Expected: Build and lint pass.

- [ ] **Step 6.4: Commit**

```bash
git add src/app/safety-scores/client.tsx src/components/systemic-risk-headline.tsx src/components/stress-test-panel.tsx
git commit -m "style(safety-scores): polish layout rhythm and risk headline visual weight"
```

---

### Task 7: Animation pass — `/impeccable:animate`

**Files:**
- Modify: `src/app/safety-scores/client.tsx`
- Possibly modify: `src/app/globals.css`

- [ ] **Step 7.1: Run `/impeccable:animate`**

Use the `/impeccable:animate` skill on the safety-scores page to add purposeful transitions:

Target areas:
1. **Grid reflow on filter change**: When the user clicks a grade filter, the grid should animate the transition (fade-in for appearing cards, layout shift for reflow). CSS `@starting-style` or a simple opacity transition on LazyCard.
2. **Grade section headers**: Subtle fade-in-down as they scroll into view (can reuse the IntersectionObserver pattern from LazyCard).
3. **Headline stats**: Consider a brief count-up animation on first load for the numeric values (ecosystem average, % supply in A/B). Keep it fast (300ms) — this isn't a landing page, it's a dashboard.

Do NOT add:
- Spring physics or complex motion
- Hover animations beyond what's already there
- Anything that adds delay to data access

- [ ] **Step 7.2: Verify the build compiles**

Run: `cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm run build 2>&1 | tail -20`
Expected: Build succeeds.

- [ ] **Step 7.3: Commit**

```bash
git add src/app/safety-scores/client.tsx src/app/globals.css
git commit -m "style(safety-scores): add purposeful filter and load transitions"
```

---

### Task 8: Final verification

**Files:** None (verification only)

- [ ] **Step 8.1: Run the full merge gate**

Run: `cd /Users/ahirice/Documents/git/stablecoin-dashboard && npm run test:merge-gate 2>&1 | tail -30`
Expected: All checks pass.

- [ ] **Step 8.2: Visual verification in dev server**

Run: `npm run dev` and verify in browser at `http://localhost:3000/safety-scores/`:

Checklist:
- [ ] Headline stats row shows ecosystem average, % supply in A/B, weakest dimension
- [ ] Grade distribution bar is the first major visual element (after one-line lead paragraph)
- [ ] Systemic risk headline appears with top 3 risks and $ at risk
- [ ] "Run a simulation" scrolls to and opens the contagion simulator
- [ ] Simulator panel is open by default
- [ ] Card grid shows grade-grouped sections (A header, A cards, B header, B cards, etc.)
- [ ] Clicking a grade filter collapses to flat grid for that grade
- [ ] Sticky simulation banner sits flush under header on mobile (no 8px gap)
- [ ] Sort buttons read "Decen." and "Dep. Risk" instead of "Decent." and "Depend."
- [ ] Loading skeleton shows 24 cards
- [ ] FAQ has 5 items total
- [ ] Telegram callout banner appears below the card grid, above FAQ
- [ ] TopGradeSpotlight card is gone

- [ ] **Step 8.3: Commit any remaining fixes**

```bash
git add -A
git commit -m "fix(safety-scores): address final visual verification issues"
```

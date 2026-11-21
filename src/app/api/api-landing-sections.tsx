import Link from "next/link";
import { Activity, ArrowUpRight, BookOpenCheck, Code2, Fingerprint } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { API_PATHS } from "@shared/lib/api-endpoints";
import { API_BREAKING_CHANGE_NOTICE_DAYS, API_PAGE_ANCHORS, PUBLIC_API_HOST } from "@shared/lib/public-api-contract";
import { renderSafetyBadgeSvg } from "@shared/lib/safety-badge-svg";
import type { ApiCoverageFacts, ApiPreviewExamples } from "./api-landing-data";

const formatCount = (value: number): string => value.toLocaleString("en-US");
const SECTION_TITLE_CLASS_NAME = "text-2xl font-semibold tracking-tight text-foreground";
const ITEM_TITLE_CLASS_NAME = "text-sm font-semibold text-foreground";
const ITEM_BODY_CLASS_NAME = "mt-1 text-sm leading-relaxed text-muted-foreground";
const FREE_GRADES_CURL = `curl ${PUBLIC_API_HOST}${API_PATHS.safetyGrades()}`;
const REPOSITORY_URL = "https://github.com/TokenBrice/pharos-watch";

/** Header facts row: what the API covers, counted from release data. Shares the line with "Used by". */
export function ApiCoverageFactsRow({ facts }: { facts: ApiCoverageFacts }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <li>
        <span className="pharos-numeric font-semibold text-foreground">{formatCount(facts.stablecoins)}</span> stablecoins
        tracked
      </li>
      <li>
        <span className="pharos-numeric font-semibold text-foreground">{formatCount(facts.deployments)}</span> contracts on{" "}
        <span className="pharos-numeric font-semibold text-foreground">{formatCount(facts.chains)}</span> chains
      </li>
      <li>
        <span className="pharos-numeric font-semibold text-foreground">{formatCount(facts.complianceDossiers)}</span> MiCA
        and GENIUS dossiers
      </li>
      <li>
        <Link href="/methodology/#safety-scores-methodology" className="pharos-prose-link">
          Safety Score methodology {facts.methodologyLabel}
        </Link>
      </li>
    </ul>
  );
}

/** Everything usable without a key, including the citable MIT datasets. */
export function ApiFreeAccess() {
  return (
    <section aria-labelledby="api-free-title" className="pharos-subtle-band space-y-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <h2 id="api-free-title" className="text-base font-semibold text-foreground">
          Free, no key
        </h2>
        <p className="pharos-meta">Data and code are MIT licensed. Credit Pharos (pharos.watch) when you cite it.</p>
      </div>
      <ul className="grid gap-4 md:grid-cols-3">
        <li className="min-w-0">
          <h3 className={ITEM_TITLE_CLASS_NAME}>Safety Score grades</h3>
          <p className={ITEM_BODY_CLASS_NAME}>Current grade and score for every tracked stablecoin.</p>
          <div className="mt-2 flex min-w-0 items-center gap-1">
            <code className="min-w-0 font-mono text-xs text-foreground [overflow-wrap:anywhere]">{FREE_GRADES_CURL}</code>
            <CopyButton text={FREE_GRADES_CURL} className="size-11 shrink-0 sm:size-8" />
          </div>
        </li>
        <li className="min-w-0">
          <h3 className={ITEM_TITLE_CLASS_NAME}>Datasets you can cite</h3>
          <p className={ITEM_BODY_CLASS_NAME}>
            Dated daily files for scores, supply and depeg history, with a ready-made citation.
          </p>
          <Link href="/api/reference/#public-datasets" className="pharos-prose-link mt-2 inline-block text-sm text-foreground">
            Browse the datasets
          </Link>
        </li>
        <li className="min-w-0">
          <h3 className={ITEM_TITLE_CLASS_NAME}>Live grade badges</h3>
          <p className={ITEM_BODY_CLASS_NAME}>
            Embed a stablecoin&apos;s current grade in a README, docs page or app. It shows Unavailable, never a stale grade.
          </p>
          <a href={`#${API_PAGE_ANCHORS.badges}`} className="pharos-prose-link mt-2 inline-block text-sm text-foreground">
            Get a badge
          </a>
        </li>
      </ul>
    </section>
  );
}

const EYEBROW_CLASS_NAME = "pharos-label";
const ICON_CLASS_NAME = "mb-2 h-5 w-5 text-muted-foreground";

/** Proof points for teams that have to justify the dependency. */
export function ApiTrustPoints({ methodologyLabel }: { methodologyLabel: string }) {
  return (
    <section aria-labelledby="api-trust-title" className="space-y-5 border-t border-border/55 pt-8">
      <div className="space-y-1.5">
        <p className={EYEBROW_CLASS_NAME}>Why teams build on it</p>
        <h2 id="api-trust-title" className={SECTION_TITLE_CLASS_NAME}>
          What you can rely on
        </h2>
      </div>
      <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <li>
          <BookOpenCheck className={ICON_CLASS_NAME} aria-hidden="true" />
          <h3 className={ITEM_TITLE_CLASS_NAME}>Published methodology</h3>
          <p className={ITEM_BODY_CLASS_NAME}>
            Every grade follows a versioned public methodology, currently Safety Score {methodologyLabel}, and changes
            are logged.
          </p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <Link href="/methodology/#safety-scores-methodology" className="pharos-prose-link text-foreground">
              Methodology
            </Link>
            <Link href="/methodology/scoring-changelog/" className="pharos-prose-link text-foreground">
              Scoring changelog
            </Link>
          </div>
        </li>
        <li>
          <Fingerprint className={ICON_CLASS_NAME} aria-hidden="true" />
          <h3 className={ITEM_TITLE_CLASS_NAME}>Provenance on every response</h3>
          <p className={ITEM_BODY_CLASS_NAME}>
            Each response states when every source was read and the freshness budget it was judged against. A missing
            value comes with a reason; unavailable is never reported as zero.
          </p>
        </li>
        <li>
          <Code2 className={ICON_CLASS_NAME} aria-hidden="true" />
          <h3 className={ITEM_TITLE_CLASS_NAME}>Open source, MIT</h3>
          <p className={ITEM_BODY_CLASS_NAME}>
            The code and the datasets are public and MIT licensed, so your integration never depends on a closed vendor.
          </p>
          <a
            href={REPOSITORY_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="pharos-prose-link mt-2 inline-flex items-center gap-1 text-sm text-foreground"
          >
            Source on GitHub
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </li>
        <li>
          <Activity className={ICON_CLASS_NAME} aria-hidden="true" />
          <h3 className={ITEM_TITLE_CLASS_NAME}>Public uptime, predictable changes</h3>
          <p className={ITEM_BODY_CLASS_NAME}>
            Uptime and incident history are public on the status page. Breaking changes to keyed routes get{" "}
            {API_BREAKING_CHANGE_NOTICE_DAYS} days&apos; notice.
          </p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <Link href="/status/" className="pharos-prose-link text-foreground">
              Status and uptime
            </Link>
            <Link href="/api/terms/" className="pharos-prose-link text-foreground">
              API terms
            </Link>
          </div>
        </li>
      </ul>
    </section>
  );
}

function badgeDataUri(badge: NonNullable<ApiPreviewExamples["badge"]>, style: "flat" | "card", theme: "dark" | "light"): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(renderSafetyBadgeSvg({ kind: "rated", ...badge }, { style, theme }))}`;
}

function Snippet({ label, code }: { label: string; code: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-[var(--code-surface-bg)] text-[var(--code-surface-fg)]">
      <div className="flex items-center justify-between border-b border-[var(--code-surface-border)] px-3 py-2">
        <span className="text-2xs font-semibold text-[var(--code-surface-muted)]">{label}</span>
        <CopyButton text={code} className="size-8 shrink-0" />
      </div>
      <pre className="whitespace-pre-wrap px-3 py-3 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">
        <code>{code}</code>
      </pre>
    </div>
  );
}

const BADGE_COIN_ID = "usdc-circle";
const BADGE_URL = `${PUBLIC_API_HOST}${API_PATHS.safetyBadge(BADGE_COIN_ID)}`;
const BADGE_MARKDOWN = `[![Pharos Safety Score](${BADGE_URL})](https://pharos.watch/stablecoin/${BADGE_COIN_ID}/)`;
const BADGE_HTML = `<a href="https://pharos.watch/stablecoin/${BADGE_COIN_ID}/"><img src="${BADGE_URL}?style=card&theme=dark" alt="Pharos Safety Score" /></a>`;

/** Free embeddable grade badges: their own section, so they never read as part of a paid plan. */
export function ApiBadgeSection({ badge, asOfDate }: { badge: ApiPreviewExamples["badge"]; asOfDate: string }) {
  return (
    <section id={API_PAGE_ANCHORS.badges} aria-labelledby="api-badges-title" className="scroll-mt-20 space-y-5 border-t border-border/55 pt-8">
      <div className="space-y-1.5">
        <p className={EYEBROW_CLASS_NAME}>Free, no key</p>
        <h2 id="api-badges-title" className={SECTION_TITLE_CLASS_NAME}>
          Safety Score badges
        </h2>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          Show a stablecoin&apos;s current grade in a README, docs page or app. Replace the ID with any tracked stablecoin;
          add <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs text-foreground">style=card</code> or{" "}
          <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs text-foreground">theme=light</code> to change
          the look. When a grade is held or stale, the badge shows Unavailable instead of an old grade.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start">
        {badge ? (
          <div className="pharos-inset flex flex-col items-start gap-4 p-5">
            <div className="flex flex-wrap items-center gap-3">
              <img src={badgeDataUri(badge, "flat", "dark")} alt={`Flat dark Safety Score badge for ${badge.symbol}`} height={26} />
              <img src={badgeDataUri(badge, "flat", "light")} alt={`Flat light Safety Score badge for ${badge.symbol}`} height={26} />
            </div>
            <img src={badgeDataUri(badge, "card", "dark")} alt={`Card Safety Score badge for ${badge.symbol}`} height={64} />
            <p className="pharos-meta">Shown with the {asOfDate} grade; the live badge always serves the current one.</p>
          </div>
        ) : null}
        <div className="min-w-0 space-y-3">
          <Snippet label="Markdown" code={BADGE_MARKDOWN} />
          <Snippet label="HTML (card style)" code={BADGE_HTML} />
        </div>
      </div>
    </section>
  );
}

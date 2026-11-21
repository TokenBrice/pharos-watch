import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { API_PATHS } from "@shared/lib/api-endpoints";
import { API_BREAKING_CHANGE_NOTICE_DAYS, API_PAGE_ANCHORS, PUBLIC_API_HOST } from "@shared/lib/public-api-contract";
import type { ApiCoverageFacts } from "./api-landing-data";

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
          <a href={`#${API_PAGE_ANCHORS.integrationPreview}`} className="pharos-prose-link mt-2 inline-block text-sm text-foreground">
            See the badge
          </a>
        </li>
      </ul>
    </section>
  );
}

/** Proof points for teams that have to justify the dependency. */
export function ApiTrustPoints({ methodologyLabel }: { methodologyLabel: string }) {
  return (
    <section aria-labelledby="api-trust-title" className="space-y-5 border-t border-border/55 pt-8">
      <h2 id="api-trust-title" className={SECTION_TITLE_CLASS_NAME}>
        What you can rely on
      </h2>
      <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <li>
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
          <h3 className={ITEM_TITLE_CLASS_NAME}>Provenance on every response</h3>
          <p className={ITEM_BODY_CLASS_NAME}>
            Each response states when every source was read and the freshness budget it was judged against. A missing
            value comes with a reason; unavailable is never reported as zero.
          </p>
        </li>
        <li>
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
          <h3 className={ITEM_TITLE_CLASS_NAME}>Predictable changes</h3>
          <p className={ITEM_BODY_CLASS_NAME}>
            Breaking changes to keyed routes get {API_BREAKING_CHANGE_NOTICE_DAYS} days&apos; notice. Service status and
            its history are public.
          </p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <Link href="/status/" className="pharos-prose-link text-foreground">
              Status
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

import { ExternalLink } from "lucide-react";
import type { LaunchMilestone } from "@shared/types/stablecoin-meta-primitives";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import { LaunchMilestoneBadge } from "@/components/pre-launch-badge";
import { PreLaunchLaunchPath } from "@/components/pre-launch-launch-path";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { EvidenceModule, EvidenceStateStrip } from "@/components/stablecoin-detail/evidence-module";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { JsonLdScript } from "@/components/json-ld-script";
import { formatFuzzyDate } from "@/lib/pre-launch";
import { buildLaunchVerdict, describeTargetHistory, sortMilestonesNewestFirst } from "@/lib/pre-launch-dossier";
import { buildPreLaunchQuickAnswers } from "@/lib/pre-launch-quick-answers";
import { buildFaqJsonLd } from "@/lib/faq";
import { safeJsonLd } from "@/lib/json-ld";

/** Newest milestones shown before the "Earlier activity" fold. */
const VISIBLE_MILESTONES = 5;

export function LaunchPathModule({ coin }: { coin: StablecoinMeta }) {
  const history = describeTargetHistory(coin.dateHistory);

  return (
    <EvidenceModule
      id="launch-path"
      title="Launch path"
      variant="module"
      headingLevel="h2"
      visual={<PreLaunchLaunchPath coin={coin} />}
      verdict={buildLaunchVerdict(coin)}
      folds={
        <>
          {history.length > 0 ? (
            <ModuleDisclosure id="target-history" label="Target history" count={history.length}>
              <ol className="mt-1 space-y-1.5 pb-1 text-xs text-muted-foreground">
                {history.map((entry) => (
                  <li key={entry.key} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="pharos-numeric text-foreground line-through decoration-muted-foreground/60">{entry.target}</span>
                    <span>retired {entry.retiredOn}</span>
                  </li>
                ))}
                {coin.expectedLaunchDate ? (
                  <li className="flex flex-wrap items-baseline gap-x-2">
                    <span className="pharos-numeric font-semibold text-foreground">{formatFuzzyDate(coin.expectedLaunchDate)}</span>
                    <span>current target</span>
                  </li>
                ) : null}
              </ol>
            </ModuleDisclosure>
          ) : null}
          {coin.launchPhaseDetail ? (
            <ModuleDisclosure id="launch-status" label="Launch status narrative">
              <p className="mt-1 break-words pb-1 text-sm leading-relaxed text-muted-foreground">{coin.launchPhaseDetail}</p>
            </ModuleDisclosure>
          ) : null}
        </>
      }
      // Keyed: React's dev key check flags this server-built footer inside the
      // client module's fold run.
      footer={
        <EvidenceFooter key="footer">
          <span>Registry dates (UTC); a quarter, half or year target draws as its whole window.</span>
        </EvidenceFooter>
      }
    />
  );
}

/** Launch-intent answers from registry fields only; the FAQPage JSON-LD mirrors the visible text. */
export function LaunchQuickAnswers({ coin }: { coin: StablecoinMeta }) {
  const items = buildPreLaunchQuickAnswers(coin);
  return (
    <section id="launch-quick-answers" aria-labelledby="launch-quick-answers-title" className="space-y-3">
      <DetailSectionTitle id="launch-quick-answers-title">Launch status: quick answers</DetailSectionTitle>
      <dl className="pharos-card-shell gap-0 divide-y divide-border/50 py-0">
        {items.map((item) => (
          <div key={item.question} className="px-4 py-3 sm:px-5">
            <dt className="text-sm font-medium text-foreground">{item.question}</dt>
            <dd className="mt-1 break-words text-sm leading-relaxed text-muted-foreground">{item.answer}</dd>
          </div>
        ))}
      </dl>
      <JsonLdScript json={safeJsonLd(buildFaqJsonLd(items))} />
    </section>
  );
}

function MilestoneList({ milestones }: { milestones: LaunchMilestone[] }) {
  return (
    <ol className="space-y-0">
      {milestones.map((m, i) => (
        <li key={`${m.date}-${m.title}`} className="relative flex gap-3 pb-4 last:pb-0">
          {i < milestones.length - 1 ? (
            <span aria-hidden="true" className="absolute bottom-0 left-[4.5px] top-4 w-px bg-border/60" />
          ) : null}
          {/* The same glyphs as the Launch path plot: dot, or diamond for a delay. */}
          <span aria-hidden="true" className="mt-1.5 flex h-2.5 w-2.5 shrink-0 items-center justify-center">
            <span className={m.type === "delay" ? "h-2 w-2 rotate-45 bg-state-warn-solid" : "h-2.5 w-2.5 rounded-full bg-foreground/75"} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <time dateTime={m.date} className="pharos-numeric text-xs text-muted-foreground">
                {formatFuzzyDate(m.date)}
              </time>
              <LaunchMilestoneBadge type={m.type} />
            </div>
            <p className="mt-1 text-sm font-medium text-foreground">{m.title}</p>
            {m.description ? (
              <p className="mt-0.5 break-words text-xs leading-relaxed text-muted-foreground">{m.description}</p>
            ) : null}
            {m.sourceUrl ? (
              <a
                href={m.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="pharos-focus-ring mt-1 inline-flex min-h-6 items-center gap-1 rounded-sm text-2xs text-muted-foreground hover:text-foreground hover:underline"
              >
                Source
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function ActivityModule({ coin }: { coin: StablecoinMeta }) {
  const milestones = sortMilestonesNewestFirst(coin.milestones);
  if (milestones.length === 0) {
    return <EvidenceStateStrip id="activity" title="Activity" state="not-reviewed" reason="no milestones logged yet" density="main" headingLevel="h2" />;
  }
  const visible = milestones.slice(0, VISIBLE_MILESTONES);
  const earlier = milestones.slice(VISIBLE_MILESTONES);
  const sourced = milestones.filter((m) => m.sourceUrl).length;

  return (
    <EvidenceModule
      id="activity"
      title="Activity"
      variant="module"
      headingLevel="h2"
      folds={
        earlier.length > 0 ? (
          <ModuleDisclosure id="earlier-activity" label="Earlier activity" count={earlier.length}>
            <div className="mt-2 pb-1">
              <MilestoneList milestones={earlier} />
            </div>
          </ModuleDisclosure>
        ) : null
      }
      footer={
        <EvidenceFooter key="footer">
          <span className="pharos-numeric">
            {milestones.length} {milestones.length === 1 ? "entry" : "entries"} · {sourced} sourced
          </span>
        </EvidenceFooter>
      }
    >
      <MilestoneList milestones={visible} />
    </EvidenceModule>
  );
}

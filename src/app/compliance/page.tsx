import Link from "next/link";
import { FaqSection } from "@/components/faq-section";
import { CardExpandButton } from "@/components/home-alt-mini-cards/pulse-card-header";
import { ComplianceContentLoadingState } from "@/app/compliance/loading-state";
import { buildComplianceStatusDistribution, buildComplianceSummary } from "@/lib/compliance-model";
import { ComplianceStatusDistributionBars } from "@/app/compliance/status-distribution-bar";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import type { FaqItem } from "@/lib/faq";
import { GENIUS_REGIME_STATE } from "@shared/lib/compliance-regime-state";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";

const COMPLIANCE_SUMMARY = buildComplianceSummary();
const complianceDescription = `${COMPLIANCE_SUMMARY.micaAuthorized} of ${COMPLIANCE_SUMMARY.micaAssessed} active stablecoins assessed for MiCA hold MiCA authorization. GENIUS Act status for ${COMPLIANCE_SUMMARY.geniusTracked} coins (effective ${GENIUS_REGIME_STATE.effectiveDate}), from public registers.`;

const COMPLIANCE_FAQ_ITEMS = [
  {
    question: "What does the compliance tracker show?",
    answer:
      "It maps assessed stablecoins to public, sourced regulatory facts. MiCA rows cover EU authorization status, EMT/ART token type, competent authority, issuer entity, and register references. GENIUS rows are implementation-watch signals while the U.S. regime is pre-effective.",
  },
  {
    question: "Why are GENIUS rows separated from the main table?",
    answer:
      "Pharos keeps GENIUS rows in Implementation Watch until an explicitly reviewed release marks the regime effective. Active assets then become eligible for the main table; pre-launch assets remain in Watch until normal catalog activation. Issuer-specific approval evidence does not bypass the regime phase or change an asset's lifecycle.",
  },
  {
    question: "What is the difference between an EMT and an ART?",
    answer:
      "An e-money token (EMT) references a single official currency. An asset-referenced token (ART) references a basket or other value, such as a multi-currency mix or a commodity. ARTs are rare in the tracked set.",
  },
  {
    question: "Is this legal or compliance advice?",
    answer:
      "No. The tracker is an informational surface with sourced links, not legal advice. Statuses are editorial assignments against public registers, regulator notices, and issuer disclosures, and may lag real-world authorizations or restrictions.",
  },
] as const satisfies readonly FaqItem[];

const COMPLIANCE_STATUS_DISTRIBUTION = buildComplianceStatusDistribution();

const COMPLIANCE_HERO = (
  <section aria-label="Compliance coverage summary" className="pharos-card-shell overflow-hidden">
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-border/50 p-5 sm:p-6">
      <div className="space-y-1.5">
        <p className="text-sm font-medium text-muted-foreground">MiCA-authorized active stablecoins</p>
        <p className="pharos-numeric text-[2.1rem] font-semibold leading-none tracking-tight text-foreground sm:text-[2.45rem]">
          {COMPLIANCE_SUMMARY.micaAuthorized.toLocaleString()}
        </p>
        <p className="pharos-meta">of {COMPLIANCE_SUMMARY.micaAssessed.toLocaleString()} active stablecoins assessed for MiCA</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/30 px-3 py-1 text-xs font-medium text-muted-foreground">
          GENIUS regime
          <span className="capitalize text-foreground">{GENIUS_REGIME_STATE.rulemakingPhase.replace(/-/g, " ")}</span>
          <span className="pharos-numeric text-foreground">· effective {GENIUS_REGIME_STATE.effectiveDate}</span>
        </span>
        <CardExpandButton href="#data" expandLabel="Jump to compliance tables" />
      </div>
    </div>
    <dl className="grid grid-cols-3 divide-x divide-border/40">
      <div className="min-w-0 space-y-1 px-4 py-4 sm:px-6 sm:py-5">
        <dt className="pharos-meta">Authorized share of active MiCA rows</dt>
        <dd className="pharos-numeric text-lg font-semibold text-foreground sm:text-xl">
          {COMPLIANCE_SUMMARY.micaAuthorizedPct}%
        </dd>
      </div>
      <div className="min-w-0 space-y-1 px-4 py-4 sm:px-6 sm:py-5">
        <dt className="pharos-meta">GENIUS tracked</dt>
        <dd className="pharos-numeric text-lg font-semibold text-foreground sm:text-xl">
          {COMPLIANCE_SUMMARY.geniusTracked.toLocaleString()}
        </dd>
      </div>
      <div className="min-w-0 space-y-1 px-4 py-4 sm:px-6 sm:py-5">
        <dt className="pharos-meta">Assessed regime rows</dt>
        <dd className="pharos-numeric text-lg font-semibold text-foreground sm:text-xl">
          {COMPLIANCE_SUMMARY.assessedRegimeRows.toLocaleString()}
        </dd>
      </div>
    </dl>
    <ComplianceStatusDistributionBars distribution={COMPLIANCE_STATUS_DISTRIBUTION} />
  </section>
);

const sourceReferences = GENIUS_REGIME_STATE.sourceReferences ?? [
  { label: GENIUS_REGIME_STATE.sourceLabel, url: GENIUS_REGIME_STATE.sourceUrl },
];

const COMPLIANCE_STATIC_SECTION = (
  <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
    <div className="pharos-card-shell p-5">
      <p className="pharos-label">How to read status</p>
      <div className="mt-3 space-y-2 text-sm leading-relaxed text-muted-foreground">
        <p>
          <span className="font-medium text-foreground">MiCA authorized</span> means the issuer holds an in-effect EMI
          or credit-institution authorization listed on a competent-authority register. Pending, transitional,
          non-compliant, and out-of-scope retain the existing MiCA editorial meanings.
        </p>
        <p>
          <span className="font-medium text-foreground">GENIUS rows are not compliance approvals.</span> They track
          source-backed public posture such as issuer-announced intent, regulator-sourced applications, or future PPSI
          approvals once the regime is operational.
        </p>
      </div>
    </div>
    <div className="pharos-card-shell p-5">
      <p className="pharos-label">GENIUS regime state</p>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Public law</dt>
        <dd className="pharos-numeric text-foreground">{GENIUS_REGIME_STATE.publicLawDate}</dd>
        <dt className="text-muted-foreground">Effective date</dt>
        <dd className="pharos-numeric text-foreground">{GENIUS_REGIME_STATE.effectiveDate}</dd>
        <dt className="text-muted-foreground">Phase</dt>
        <dd className="capitalize text-foreground">{GENIUS_REGIME_STATE.rulemakingPhase.replace(/-/g, " ")}</dd>
      </dl>
      <details className="mt-3 text-sm text-muted-foreground">
        <summary className="pharos-focus-ring cursor-pointer rounded-sm py-1 hover:text-foreground">
          Sources ({sourceReferences.length})
        </summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 leading-relaxed">
          {sourceReferences.map((source) => (
            <li key={source.url}>
              <a href={source.url} target="_blank" rel="noopener noreferrer" className="pharos-prose-link">
                {source.label}
              </a>
            </li>
          ))}
        </ul>
      </details>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        Pair this with{" "}
        <Link href="/screener/" className="pharos-prose-link">
          Screener
        </Link>{" "}
        and{" "}
        <Link href="/safety-scores/" className="pharos-prose-link">
          Safety Scores
        </Link>{" "}
        for the non-legal risk picture.
      </p>
    </div>
  </section>
);

const route = createClientFeaturePage({
  path: "/compliance/",
  metadata: {
    title: `Active MiCA-Authorized Stablecoins (${COMPLIANCE_SUMMARY.micaAuthorized}) & GENIUS Act Tracker`,
    description: complianceDescription,
    ogImage: `${SITE_URL}/og-card.png`,
  },
  loadClient: () => import("./client").then((m) => ({ default: m.ComplianceClient })),
  loading: <ComplianceContentLoadingState />,
  shell: {
    breadcrumbName: "Compliance",
    title: "Compliance Tracker",
    leadParagraphs: [
      "Where each assessed stablecoin stands under EU MiCA and the U.S. GENIUS Act, sourced from public registers, regulator notices, and issuer disclosures.",
    ],
    headerSupplement: (
      <p className="pharos-lead hidden sm:block">
        Compliance status here is narrow and source-backed: it does not prove reserve sufficiency, operational
        controls, or sanctions and AML effectiveness.
      </p>
    ),
  },
  beforeClient: (
    <>
      {COMPLIANCE_HERO}
      {COMPLIANCE_STATIC_SECTION}
    </>
  ),
  afterClient: <FaqSection items={COMPLIANCE_FAQ_ITEMS} includeJsonLd />,
});

export const metadata = route.metadata;
export default route.Page;

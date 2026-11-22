import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { FaqSection } from "@/components/faq-section";
import { Term } from "@/components/term";
import { ComplianceContentLoadingState } from "@/app/compliance/loading-state";
import { buildComplianceStatusDistribution, buildComplianceSummary } from "@/lib/compliance-model";
import { ComplianceStatusDistributionBars } from "@/app/compliance/status-distribution-bar";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import type { FaqItem } from "@/lib/faq";
import { GENIUS_REGIME_STATE } from "@shared/lib/compliance-regime-state";
import type { GeniusAuthorizationStatus } from "@shared/types/compliance-vocabulary";

const COMPLIANCE_SUMMARY = buildComplianceSummary();
const COMPLIANCE_STATUS_DISTRIBUTION = buildComplianceStatusDistribution();

const GENIUS_ACTIVE_SIGNAL_STATUSES: ReadonlySet<GeniusAuthorizationStatus> = new Set([
  "ppsi-approved",
  "state-qualified",
  "official-application-pending",
  "issuer-announced-intent",
]);

const MICA_OUT_OF_SCOPE =
  COMPLIANCE_STATUS_DISTRIBUTION.mica.find((item) => item.status === "out-of-scope")?.count ?? 0;
const MICA_NON_COMPLIANT =
  COMPLIANCE_STATUS_DISTRIBUTION.mica.find((item) => item.status === "non-compliant")?.count ?? 0;
const MICA_IN_SCOPE = Math.max(COMPLIANCE_SUMMARY.micaAssessed - MICA_OUT_OF_SCOPE, 0);
const MICA_IN_SCOPE_PCT =
  MICA_IN_SCOPE > 0 ? Math.round((COMPLIANCE_SUMMARY.micaAuthorized / MICA_IN_SCOPE) * 100) : 0;
const GENIUS_ACTIVE_SIGNALS = COMPLIANCE_STATUS_DISTRIBUTION.genius.reduce(
  (sum, item) => (GENIUS_ACTIVE_SIGNAL_STATUSES.has(item.status) ? sum + item.count : sum),
  0,
);
const GENIUS_PRIMARY_SIGNAL_STATUS =
  COMPLIANCE_STATUS_DISTRIBUTION.genius.find((item) => GENIUS_ACTIVE_SIGNAL_STATUSES.has(item.status))?.status ??
  "issuer-announced-intent";

const complianceDescription = `${COMPLIANCE_SUMMARY.micaAuthorized} of ${MICA_IN_SCOPE} in-scope active stablecoins (${COMPLIANCE_SUMMARY.micaAssessed} assessed) hold MiCA authorization. ${GENIUS_ACTIVE_SIGNALS} GENIUS Act active signals across ${COMPLIANCE_SUMMARY.geniusTracked} tracked coins (effective ${GENIUS_REGIME_STATE.effectiveDate}).`;

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

const sourceReferences = GENIUS_REGIME_STATE.sourceReferences ?? [
  { label: GENIUS_REGIME_STATE.sourceLabel, url: GENIUS_REGIME_STATE.sourceUrl },
];

const COMPLIANCE_HERO = (
  <section aria-label="Compliance coverage summary" className="pharos-card-shell overflow-hidden">
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
        <div className="space-y-0.5">
          <p className="pharos-label">MiCA Authorized</p>
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="pharos-numeric text-2xl font-semibold leading-none tracking-tight text-foreground sm:text-3xl">
              {COMPLIANCE_SUMMARY.micaAuthorized.toLocaleString()}
            </span>
            <span className="pharos-numeric text-xs font-medium text-muted-foreground">
              {MICA_IN_SCOPE_PCT}% of {MICA_IN_SCOPE.toLocaleString()} in-scope
            </span>
          </p>
          <p className="pharos-meta">
            of {COMPLIANCE_SUMMARY.micaAssessed.toLocaleString()} active stablecoins assessed for MiCA
          </p>
        </div>

        <div className="space-y-0.5">
          <p className="pharos-label">GENIUS Active Signals</p>
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="pharos-numeric text-2xl font-semibold leading-none tracking-tight text-foreground sm:text-3xl">
              {GENIUS_ACTIVE_SIGNALS.toLocaleString()}
            </span>
            <span className="pharos-numeric text-xs font-medium text-muted-foreground">
              of {COMPLIANCE_SUMMARY.geniusTracked.toLocaleString()} tracked
            </span>
          </p>
          <p className="pharos-meta">
            <span className="capitalize">{GENIUS_REGIME_STATE.rulemakingPhase.replace(/-/g, " ")}</span> · effective{" "}
            <span className="pharos-numeric">{GENIUS_REGIME_STATE.effectiveDate}</span>
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5" aria-label="Quick compliance filters">
        <Link
          href="/compliance/?regime=mica&status=authorized#data"
          className="pharos-focus-ring pharos-control-pill min-h-11 px-3 text-xs font-medium sm:min-h-8"
        >
          MiCA Authorized ({COMPLIANCE_SUMMARY.micaAuthorized.toLocaleString()})
        </Link>
        {MICA_NON_COMPLIANT > 0 ? (
          <Link
            href="/compliance/?regime=mica&status=non-compliant#data"
            className="pharos-focus-ring pharos-control-pill min-h-11 px-3 text-xs font-medium sm:min-h-8"
          >
            MiCA Non-Compliant ({MICA_NON_COMPLIANT.toLocaleString()})
          </Link>
        ) : null}
        {GENIUS_ACTIVE_SIGNALS > 0 ? (
          <Link
            href={`/compliance/?regime=genius&status=${GENIUS_PRIMARY_SIGNAL_STATUS}#data`}
            className="pharos-focus-ring pharos-control-pill min-h-11 px-3 text-xs font-medium sm:min-h-8"
          >
            GENIUS Active Signals ({GENIUS_ACTIVE_SIGNALS.toLocaleString()})
          </Link>
        ) : null}
      </div>
    </div>

    <ComplianceStatusDistributionBars distribution={COMPLIANCE_STATUS_DISTRIBUTION} />

    <details className="group border-t border-border/50 bg-muted/20">
      <summary className="pharos-focus-ring flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden sm:min-h-9 sm:px-5">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-foreground">How to read status &amp; GENIUS regime state</span>
          <span aria-hidden="true">·</span>
          <span className="pharos-numeric">
            GENIUS effective {GENIUS_REGIME_STATE.effectiveDate} · {sourceReferences.length} sources
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none group-open:rotate-180"
        />
      </summary>
      <div className="grid gap-4 border-t border-border/50 px-4 py-4 sm:px-5 lg:grid-cols-2">
        <div className="space-y-2 text-sm leading-relaxed text-muted-foreground">
          <p className="pharos-label">How to read status</p>
          <p>
            Compliance status here is narrow and source-backed: it does not prove reserve sufficiency, operational
            controls, or sanctions and AML effectiveness.
          </p>
          <p>
            <span className="font-medium text-foreground">
              <Term slug="mica">MiCA</Term> authorized
            </span>{" "}
            means the issuer holds an in-effect <Term slug="emi">EMI</Term> or credit-institution authorization listed
            on a competent-authority register. Pending, transitional, non-compliant, and out-of-scope retain the
            existing MiCA editorial meanings.
          </p>
          <p>
            <span className="font-medium text-foreground">
              <Term slug="genius">GENIUS</Term> rows are not compliance approvals.
            </span>{" "}
            They track source-backed public posture such as issuer-announced intent, regulator-sourced applications, or
            future <Term slug="ppsi">PPSI</Term> approvals once the regime is operational.
          </p>
        </div>
        <div className="space-y-3 text-sm leading-relaxed text-muted-foreground">
          <p className="pharos-label">GENIUS regime state</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Public law</dt>
            <dd className="pharos-numeric text-foreground">{GENIUS_REGIME_STATE.publicLawDate}</dd>
            <dt className="text-muted-foreground">Effective date</dt>
            <dd className="pharos-numeric text-foreground">{GENIUS_REGIME_STATE.effectiveDate}</dd>
            <dt className="text-muted-foreground">Phase</dt>
            <dd className="capitalize text-foreground">{GENIUS_REGIME_STATE.rulemakingPhase.replace(/-/g, " ")}</dd>
          </dl>
          <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed">
            {sourceReferences.map((source) => (
              <li key={source.url}>
                <a href={source.url} target="_blank" rel="noopener noreferrer" className="pharos-prose-link">
                  {source.label}
                </a>
              </li>
            ))}
          </ul>
          <p className="text-xs leading-relaxed text-muted-foreground">
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
      </div>
    </details>
  </section>
);

const route = createClientFeaturePage({
  path: "/compliance/",
  metadata: {
    title: `Active MiCA-Authorized Stablecoins (${COMPLIANCE_SUMMARY.micaAuthorized}) & GENIUS Act Tracker`,
    description: complianceDescription,
  },
  loadClient: () => import("./client").then((m) => ({ default: m.ComplianceClient })),
  loading: <ComplianceContentLoadingState />,
  shell: {
    header: "instrument",
    breadcrumbName: "Compliance",
    title: "Compliance Tracker",
    leadParagraphs: [
      <>
        Where each assessed stablecoin stands under EU <Term slug="mica">MiCA</Term> and the U.S.{" "}
        <Term slug="genius">GENIUS Act</Term>, sourced from public registers, regulator notices, and issuer disclosures.
      </>,
    ],
  },
  beforeClient: COMPLIANCE_HERO,
  afterClient: <FaqSection items={COMPLIANCE_FAQ_ITEMS} includeJsonLd />,
});

export const metadata = route.metadata;
export default route.Page;

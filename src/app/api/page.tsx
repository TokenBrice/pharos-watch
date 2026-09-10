import Link from "next/link";
import { Activity, ArrowUpRight, BookOpen, Database, KeyRound, LineChart, ShieldCheck } from "lucide-react";
import { ApiKeyRequestForm } from "@/components/api-key-request-form";
import { CopyButton } from "@/components/copy-button";
import { DonorKeyClaim } from "@/components/donor-key-claim";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import { API_PATHS } from "@shared/lib/api-endpoints";
import donationsData from "@shared/data/funding/donations.json";
import { formatIsoDate } from "@shared/lib/format";
import { DONOR_API_KEY_MIN_USD, DONOR_API_KEY_RATE_LIMIT_PER_MINUTE } from "@shared/lib/ops-limits";
import {
  DONOR_KEY_CLAIMS_OPEN,
  PUBLIC_API_ARTIFACTS,
  PUBLIC_API_HOST,
  PUBLIC_API_KEY_HEADER,
  SELF_SERVE_API_KEY_EXPIRY_DAYS,
  SELF_SERVE_API_KEY_RATE_LIMIT_RPM,
  SELF_SERVE_ISSUANCE_OPEN,
  buildPublicApiCurlCommand,
} from "@shared/lib/public-api-contract";

export const metadata = buildPageMetadata({
  title: "Pharos Stablecoin API: Free Safety Grades & Keyed Endpoints",
  description:
    "Read Pharos Safety Score grades for every tracked stablecoin without a key, and use the keyed market, peg, liquidity, depeg, and risk endpoints at api.pharos.watch.",
  canonical: "/api/",
});

const FREE_GRADES_URL = `${PUBLIC_API_HOST}${API_PATHS.safetyGrades()}`;

// Eligibility follows the committed donation ledger, so the reconciliation date
// is the honest "as of" for the perk: a donation sent after it counts only once
// the funding skill appends the row and a release ships.
const LEDGER_RECONCILED_DATE = formatIsoDate(donationsData.last_updated_at);

const ACCESS_FACTS = [
  {
    title: "Free Grades",
    description:
      "Safety Score grades for every tracked stablecoin are served without an API key. Everything else on the public host needs one.",
    icon: ShieldCheck,
  },
  {
    title: "External Lane",
    description:
      "Use the public API host directly for integrations. Browser pages on Pharos use a separate site-data lane.",
    icon: ArrowUpRight,
  },
  {
    title: "Supporter Key",
    description:
      `Wallets with at least $${DONOR_API_KEY_MIN_USD} in donations of stablecoins currently graded A or B (including +/−) can claim one key at ${DONOR_API_KEY_RATE_LIMIT_PER_MINUTE} requests per minute, with no scheduled expiry.`,
    icon: KeyRound,
  },
] as const;

const QUICK_ENDPOINTS = [
  {
    method: "GET",
    path: "/api/stablecoins",
    title: "Stablecoin market snapshot",
    description: "Supply, price, chains, peg metadata, and freshness headers for every tracked active stablecoin.",
    icon: Database,
  },
  {
    method: "GET",
    path: "/api/stablecoin/usdc-circle",
    title: "Single stablecoin detail",
    description: "Per-coin profile for dashboards that need one canonical ID at a time.",
    icon: LineChart,
  },
  {
    method: "GET",
    path: "/api/depeg-events?active=true",
    title: "Active peg incidents",
    description: "Current depeg events and incident history filters for monitoring workflows.",
    icon: Activity,
  },
  {
    method: "GET",
    path: "/api/dex-liquidity",
    title: "DEX liquidity scores",
    description: "Pool depth, protocol diversity, and exit-capacity data keyed by Pharos stablecoin ID.",
    icon: ShieldCheck,
  },
] as const;

const CODE_EXAMPLES = [
  {
    label: "curl",
    code: buildPublicApiCurlCommand(),
  },
  {
    label: "JavaScript",
    code: `const response = await fetch("${PUBLIC_API_HOST}/api/stablecoin/usdc-circle", {
  headers: { "${PUBLIC_API_KEY_HEADER}": process.env.PHAROS_API_KEY },
});

if (!response.ok) throw new Error(\`Pharos API returned \${response.status}\`);
const coin = await response.json();`,
  },
  {
    label: "Python",
    code: `import os
import requests

response = requests.get(
    "${PUBLIC_API_HOST}/api/depeg-events",
    params={"active": "true"},
    headers={"${PUBLIC_API_KEY_HEADER}": os.environ["PHAROS_API_KEY"]},
    timeout=10,
)
response.raise_for_status()
events = response.json()`,
  },
] as const;

function CodeExampleCard({ example }: { example: (typeof CODE_EXAMPLES)[number] }) {
  return (
    <article className="overflow-hidden rounded-xl border border-border/60 bg-[var(--code-surface-bg)] text-[var(--code-surface-fg)]">
      <div className="flex items-center justify-between border-b border-[var(--code-surface-border)] px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--code-surface-muted)]">{example.label}</span>
        <CopyButton text={example.code} />
      </div>
      <pre className="overflow-x-auto px-3 py-3 text-xs leading-relaxed">
        <code>{example.code}</code>
      </pre>
    </article>
  );
}

export default function ApiAccessPage() {
  return (
    <FeaturePageShell
      breadcrumbName="API"
      path="/api/"
      title="Pharos API"
      leadParagraphs={[
        <>
          Safety Score grades for every tracked stablecoin are free and need no key. The full read-only API is
          keyed: keys are scoped to external API traffic and carry a per-key rate limit and expiry.
        </>,
      ]}
      headerSupplement={
        <div className="flex flex-wrap gap-3">
          <Link href="/about/api/" className="pharos-control-pill pharos-focus-ring gap-1.5">
            <BookOpen className="h-4 w-4" aria-hidden="true" />
            API Reference
          </Link>
          <a href={PUBLIC_API_ARTIFACTS.openApi} className="pharos-control-pill pharos-focus-ring gap-1.5">
            OpenAPI
            <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          </a>
          <a href={PUBLIC_API_ARTIFACTS.postmanCollection} className="pharos-control-pill pharos-focus-ring gap-1.5">
            Postman
            <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          </a>
        </div>
      }
    >
      <div className="space-y-8">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {ACCESS_FACTS.map((fact) => {
          const Icon = fact.icon;
          return (
            <section key={fact.title} className="pharos-card-shell px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-lg font-semibold tracking-tight text-foreground">{fact.title}</h2>
                <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/75 text-foreground">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{fact.description}</p>
            </section>
          );
        })}

        <section className="pharos-card-shell px-4 py-4">
          <p className="pharos-kicker">Call Pattern</p>
          <div className="mt-3 space-y-2 text-sm leading-relaxed text-muted-foreground">
            <p>
              Base URL:{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono tabular-nums text-[0.92em] text-foreground">
                {PUBLIC_API_HOST}
              </code>
            </p>
            <p>
              Header:{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono tabular-nums text-[0.92em] text-foreground">
                {PUBLIC_API_KEY_HEADER}
              </code>
            </p>
            <p>Respect 429 responses and add jitter to polling intervals.</p>
          </div>
        </section>
      </div>

      <section className="space-y-3">
        <div className="space-y-1.5">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">Start with a read endpoint</h2>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Use the external API lane for integrations, CI jobs, notebooks, and partner dashboards. The website uses a
            separate same-origin site-data lane, so browser code copied from Pharos pages is not the right integration
            contract.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {QUICK_ENDPOINTS.map((endpoint) => {
            const Icon = endpoint.icon;

            return (
              <Link
                key={endpoint.path}
                href="/about/api/#endpoint-directory"
                className="pharos-focus-ring pharos-card-shell pharos-interactive-card px-4 py-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="inline-flex rounded-full border border-border/60 bg-muted/50 px-2 py-0.5 font-mono text-[11px] font-bold leading-tight text-foreground">
                    {endpoint.method}
                  </span>
                  <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/75 text-foreground">
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  </span>
                </div>
                <code className="mt-3 block truncate font-mono tabular-nums text-[0.82rem] text-foreground">{endpoint.path}</code>
                <h3 className="mt-2 text-sm font-semibold tracking-tight text-foreground">{endpoint.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{endpoint.description}</p>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,0.7fr)_minmax(18rem,0.3fr)]">
        <div className="space-y-3">
          <div className="space-y-1.5">
            <p className="pharos-kicker">Working Examples</p>
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">Call Pharos from your stack</h2>
          </div>
          <div className="grid gap-3 lg:grid-cols-3">
            {CODE_EXAMPLES.map((example) => (
              <CodeExampleCard key={example.label} example={example} />
            ))}
          </div>
        </div>

        <aside className="pharos-card-shell px-4 py-4">
          <p className="pharos-kicker">Auth And Limits</p>
          <ul className="mt-3 space-y-2 text-sm leading-relaxed text-muted-foreground">
            <li>
              Send{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono tabular-nums text-[0.92em] text-foreground">{PUBLIC_API_KEY_HEADER}</code>{" "}
              on protected public routes.
            </li>
            <li>
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.92em] text-foreground">GET {API_PATHS.safetyGrades()}</code>{" "}
              needs no key.
            </li>
            {SELF_SERVE_ISSUANCE_OPEN ? (
              <li>
                Self-serve keys start at {SELF_SERVE_API_KEY_RATE_LIMIT_RPM} requests per minute and expire after{" "}
                {SELF_SERVE_API_KEY_EXPIRY_DAYS} days.
              </li>
            ) : null}
            <li>
              Keys carry per-key limits; treat 429 as quota pressure and honor Retry-After when present.
            </li>
            <li>Poll realtime endpoints no faster than 60 seconds and history endpoints roughly hourly.</li>
          </ul>
          <div className="mt-4 flex flex-col gap-2">
            <Link
              href="/about/api/#rate-limits"
              className="pharos-focus-ring rounded-xl border border-border/60 bg-background/70 px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              Rate-limit details
            </Link>
            <Link
              href="/about/api/#public-api-auth"
              className="pharos-focus-ring rounded-xl border border-border/60 bg-background/70 px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              Auth reference
            </Link>
            <a
              href={PUBLIC_API_ARTIFACTS.postmanEnvironment}
              className="pharos-focus-ring rounded-xl border border-border/60 bg-background/70 px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              Postman environment
            </a>
          </div>
        </aside>
      </section>

      <section className="pharos-card-shell px-4 py-5 sm:px-5 sm:py-6">
        <div className="space-y-2">
          <p className="pharos-kicker">No API Key Required</p>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">Safety Score grades for every stablecoin</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            One score and grade per tracked stablecoin from the current published Safety Score, with the
            methodology version and publication status. Same publication as the keyed report cards, refreshed on the
            same schedule. Coin IDs use the Pharos <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.92em] text-foreground">ticker-issuer</code> form.
          </p>
        </div>
        <div className="mt-4">
          <CodeExampleCard example={{ label: "curl", code: `curl ${FREE_GRADES_URL}` }} />
        </div>
      </section>

      <section className="pharos-card-shell px-4 py-5 sm:px-5 sm:py-6">
        <div className="space-y-2">
          <p className="pharos-kicker">Supporter Key</p>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">A thank-you perk for donors</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Any externally-owned EVM wallet with at least ${DONOR_API_KEY_MIN_USD} in qualifying stablecoin donations in the{" "}
            <Link href="/funding/" className="pharos-prose-link">
              public donation ledger
            </Link>{" "}
            can claim one API key. The wallet proves it is yours by signing a short text message: no transaction, no
            email address, and no payment processor.
          </p>
        </div>
        <ul className="mt-4 space-y-2 text-sm leading-relaxed text-muted-foreground">
          <li>{DONOR_API_KEY_RATE_LIMIT_PER_MINUTE} requests per minute, no scheduled expiry, revocable, and no SLA.</li>
          <li>Only donations of stablecoins currently graded A+, A, A−, B+, B, or B− count at claim time. Later grade changes do not revoke an issued key.</li>
          <li>Claims pause while the current Safety Score publication is held or unavailable.</li>
          <li>
            One key per wallet. A lost key is rotated by hand through the{" "}
            <Link href="/feedback/" className="pharos-prose-link">
              feedback form
            </Link>
            .
          </li>
          <li>The donating wallet has to be able to sign: exchange withdrawals and contract wallets do not qualify.</li>
          <li>Claims are not instant. The donor list is updated once a week, on Sunday mornings; a new donation can only be claimed once it appears on the funding page. Ledger last reconciled {LEDGER_RECONCILED_DATE} UTC.</li>
        </ul>
        {DONOR_KEY_CLAIMS_OPEN ? (
          <DonorKeyClaim />
        ) : (
          <p className="mt-4 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            Supporter key claims are paused for now.
          </p>
        )}
      </section>

      <ApiKeyRequestForm issuanceOpen={SELF_SERVE_ISSUANCE_OPEN} />
      {!SELF_SERVE_ISSUANCE_OPEN ? (
        <section className="pharos-card-shell px-4 py-5 sm:px-5 sm:py-6">
          <div className="space-y-2">
            <p className="pharos-kicker">Keyed Access</p>
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">Self-serve key issuance is closed</h2>
          </div>
          <div className="mt-4 space-y-3 text-sm leading-relaxed text-muted-foreground">
            <p>
              New keys are not issued on demand while a paid API tier is being prepared. Keys already issued keep
              working until their expiry date.
            </p>
            <p>
              If you need keyed access for a project in the meantime, describe it through the{" "}
              <Link href="/feedback/" className="pharos-prose-link">
                feedback form
              </Link>{" "}
              and it will be reviewed by hand.
            </p>
            <p>
              Integrations that deliver a freely available, non-profit service on top of Pharos data - FrankenCoin and
              Octav are examples - receive keys at no cost on request through the same form.
            </p>
          </div>
        </section>
      ) : null}
      </div>
    </FeaturePageShell>
  );
}

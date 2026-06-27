import Link from "next/link";
import { Activity, ArrowUpRight, BookOpen, Code2, Database, KeyRound, LineChart, ShieldCheck } from "lucide-react";
import { ApiKeyRequestForm } from "@/components/api-key-request-form";
import { CopyButton } from "@/components/copy-button";
import { buildPageMetadata } from "@/lib/page-metadata";
import { safeJsonLd } from "@/lib/json-ld";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import {
  PUBLIC_API_ARTIFACTS,
  PUBLIC_API_HOST,
  PUBLIC_API_KEY_HEADER,
  SELF_SERVE_API_KEY_EXPIRY_DAYS,
  SELF_SERVE_API_KEY_RATE_LIMIT_RPM,
  buildPublicApiCurlCommand,
} from "@shared/lib/public-api-contract";

export const metadata = buildPageMetadata({
  title: "Pharos Stablecoin API: Key Access & Endpoints",
  description:
    "Request a Pharos API key and use stablecoin market, peg, liquidity, depeg, and risk endpoints from the public integration lane at api.pharos.watch.",
  canonical: "/api/",
});

const ACCESS_FACTS = [
  {
    title: "Email Verified",
    description:
      "A verification link is sent before a key is issued. The API token is revealed once in the browser after verification.",
    icon: ShieldCheck,
  },
  {
    title: "External Lane",
    description:
      "Use the public API host directly for integrations. Browser pages on Pharos use a separate site-data lane.",
    icon: ArrowUpRight,
  },
  {
    title: "Reference Ready",
    description:
      "Endpoint contracts, OpenAPI, and Postman artifacts stay on the reference page for implementation work.",
    icon: BookOpen,
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
    <article className="overflow-hidden rounded-2xl border border-border/60 bg-zinc-950 text-zinc-100 shadow-[0_12px_28px_oklch(0_0_0_/0.18)]">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-400">{example.label}</span>
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
    <div className="mx-auto w-full max-w-[76rem] space-y-8">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLd({
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            itemListElement: [
              { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
              { "@type": "ListItem", position: 2, name: "API", item: new URL("/api/", SITE_URL).toString() },
            ],
          }),
        }}
      />

      <div className="space-y-3">
        <section className="grid gap-5 lg:grid-cols-[minmax(0,0.66fr)_minmax(18rem,0.34fr)] lg:items-end">
          <div className="space-y-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-1 text-xs font-medium text-muted-foreground">
              <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
              Public API Access
            </div>
            <div className="space-y-2">
              <h1 className="text-4xl font-extrabold tracking-tighter sm:text-[3.3rem]">Pharos API</h1>
              <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
                Request a self-serve key for read-only public stablecoin data. The default key is scoped to external API
                traffic, limited to {SELF_SERVE_API_KEY_RATE_LIMIT_RPM} requests per minute, and expires after{" "}
                {SELF_SERVE_API_KEY_EXPIRY_DAYS} days.
              </p>
            </div>
            <div className="flex flex-wrap gap-3 text-sm">
              <Link
                href="/about/api/"
                className="pharos-focus-ring inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-3 py-2 font-medium text-foreground hover:bg-muted/50"
              >
                <BookOpen className="h-4 w-4" aria-hidden="true" />
                API Reference
              </Link>
              <a
                href={PUBLIC_API_ARTIFACTS.openApi}
                className="pharos-focus-ring inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-3 py-2 font-medium text-foreground hover:bg-muted/50"
              >
                OpenAPI
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              </a>
              <a
                href={PUBLIC_API_ARTIFACTS.postmanCollection}
                className="pharos-focus-ring inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-3 py-2 font-medium text-foreground hover:bg-muted/50"
              >
                Postman
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              </a>
            </div>
          </div>

          <div className="rounded-2xl border border-border/60 bg-card/72 px-4 py-4">
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
          </div>
        </section>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {ACCESS_FACTS.map((fact) => {
          const Icon = fact.icon;
          return (
            <section key={fact.title} className="rounded-2xl border border-border/60 bg-card/72 px-4 py-4">
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
                className="pharos-focus-ring rounded-2xl border border-border/60 bg-card/72 px-4 py-4 transition-colors hover:bg-accent"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="inline-flex rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 font-mono tabular-nums text-[11px] font-bold leading-tight text-emerald-600 dark:text-emerald-400">
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
            <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-1 text-xs font-medium text-muted-foreground">
              <Code2 className="h-3.5 w-3.5" aria-hidden="true" />
              Working Examples
            </div>
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">Call Pharos from your stack</h2>
          </div>
          <div className="grid gap-3 lg:grid-cols-3">
            {CODE_EXAMPLES.map((example) => (
              <CodeExampleCard key={example.label} example={example} />
            ))}
          </div>
        </div>

        <aside className="rounded-2xl border border-border/60 bg-card/72 px-4 py-4">
          <p className="pharos-kicker">Auth And Limits</p>
          <ul className="mt-3 space-y-2 text-sm leading-relaxed text-muted-foreground">
            <li>
              Send{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono tabular-nums text-[0.92em] text-foreground">{PUBLIC_API_KEY_HEADER}</code>{" "}
              on protected public routes.
            </li>
            <li>
              Self-serve keys start at {SELF_SERVE_API_KEY_RATE_LIMIT_RPM} requests per minute and expire after{" "}
              {SELF_SERVE_API_KEY_EXPIRY_DAYS} days.
            </li>
            <li>
              Standard keys can have per-key limits; treat 429 as quota pressure and honor Retry-After when present.
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

      <ApiKeyRequestForm />
    </div>
  );
}

import Link from "next/link";
import { ArrowUpRight, BookOpen, KeyRound, ShieldCheck } from "lucide-react";
import { ApiKeyRequestForm } from "@/components/api-key-request-form";
import { buildPageMetadata } from "@/lib/page-metadata";
import { safeJsonLd } from "@/lib/json-ld";

export const metadata = buildPageMetadata({
  title: "Pharos API Access",
  description:
    "Request an email-verified Pharos API key, verify ownership, and use the public integration lane at api.pharos.watch.",
  canonical: "/api/",
});

const ACCESS_FACTS = [
  {
    title: "Email Verified",
    description: "A verification link is sent before a key is issued. The API token is revealed once in the browser after verification.",
    icon: ShieldCheck,
  },
  {
    title: "External Lane",
    description: "Use the public API host directly for integrations. Browser pages on Pharos use a separate site-data lane.",
    icon: ArrowUpRight,
  },
  {
    title: "Reference Ready",
    description: "Endpoint contracts, OpenAPI, and Postman artifacts stay on the reference page for implementation work.",
    icon: BookOpen,
  },
] as const;

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
              { "@type": "ListItem", position: 1, name: "Home", item: "https://pharos.watch" },
              { "@type": "ListItem", position: 2, name: "API", item: "https://pharos.watch/api/" },
            ],
          }),
        }}
      />

      <div className="space-y-3">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="pharos-focus-ring rounded-sm hover:text-foreground">
            Dashboard
          </Link>
          <span>/</span>
          <span className="text-foreground">API</span>
        </nav>

        <section className="grid gap-5 lg:grid-cols-[minmax(0,0.66fr)_minmax(18rem,0.34fr)] lg:items-end">
          <div className="space-y-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/70 px-3 py-1 text-xs font-medium text-muted-foreground">
              <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
              Public API Access
            </div>
            <div className="space-y-2">
              <h1 className="text-4xl font-extrabold tracking-tighter sm:text-[3.3rem]">Pharos API</h1>
              <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
                Request a self-serve key for read-only public stablecoin data. The default key is scoped to external API traffic, limited to 30 requests per minute, and expires after 60 days.
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
                href="/openapi.json"
                className="pharos-focus-ring inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-3 py-2 font-medium text-foreground hover:bg-muted/50"
              >
                OpenAPI
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              </a>
            </div>
          </div>

          <div className="rounded-2xl border border-border/60 bg-card/72 px-4 py-4">
            <p className="pharos-kicker">Call Pattern</p>
            <div className="mt-3 space-y-2 text-sm leading-relaxed text-muted-foreground">
              <p>
                Base URL: <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.92em] text-foreground">https://api.pharos.watch</code>
              </p>
              <p>
                Header: <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.92em] text-foreground">X-API-Key</code>
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

      <ApiKeyRequestForm />
    </div>
  );
}

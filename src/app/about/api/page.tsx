import type { ComponentProps } from "react";
import Link from "next/link";
import { BookOpen, Globe, KeyRound, ShieldCheck } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/copy-button";
import { FaqSection } from "@/components/faq-section";
import { JsonLdScript } from "@/components/json-ld-script";
import { markdownLinkComponent } from "@/components/markdown-link";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { ApiReferenceLayout } from "@/components/api-reference-layout";
import type { SidebarSection } from "@/components/api-reference-sidebar";
import {
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";
import type { FaqItem } from "@/lib/faq";
import { safeJsonLd } from "@/lib/json-ld";
import { buildApiArtifactCatalogJsonLd } from "@/lib/api-artifact-json-ld";
import { PUBLIC_DATASET_JSON_LD_DESCRIPTORS } from "@/lib/analytics-dataset-json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import {
  PUBLIC_API_ARTIFACTS,
  PUBLIC_API_HOST,
  PUBLIC_API_KEY_HEADER,
  SELF_SERVE_API_KEY_SUMMARY,
} from "@shared/lib/public-api-contract";
import {
  getConciseApiReferenceSections,
  getPublicApiEndpointSummaries,
  loadApiReferenceDocument,
  type ApiReferenceEndpointSummary,
  type MarkdownBlock,
  type ApiReferenceSection,
} from "@/lib/api-reference-doc";

export const metadata = buildPageMetadata({
  title: "Pharos API Reference: Stablecoin Data Contracts",
  description:
    "Pharos API reference for stablecoin integrations: auth model, API-key requirements, host split, endpoints, artifacts, and response contracts.",
  canonical: "/about/api/",
  ogImage: `${SITE_URL}/og-editorial-about.png`,
});

const HERO_LANES = [
  {
    title: "External API",
    icon: KeyRound,
    eyebrow: "For integrations",
    description:
      `Call \`${PUBLIC_API_HOST}\` directly. Non-exempt \`/api/*\` requests require a valid \`${PUBLIC_API_KEY_HEADER}\`; missing or invalid keys return \`401\`. Self-serve access starts at [/api/](/api/).`,
  },
  {
    title: "Website lane",
    icon: Globe,
    eyebrow: "Same-origin only",
    description:
      "Browsers on `pharos.watch`, `ops.pharos.watch`, and Pages previews use same-origin `/_site-data/*`. The lane accepts only requests whose `Origin` or `Referer` maps to an allowed site hostname; external integrations should use the public API lane.",
  },
  {
    title: "Ops lane",
    icon: ShieldCheck,
    eyebrow: "For operators",
    description:
      "Admin routes live behind Cloudflare Access on `ops.pharos.watch` and `ops-api.pharos.watch`. They do not use public API keys.",
  },
] as const;

const ABOUT_API_FAQ: FaqItem[] = [
  {
    question: "How do I get a Pharos API key?",
    answer:
      "Use the self-serve request form at https://pharos.watch/api/. It sends an email verification link and reveals the API key once after verification.",
  },
  {
    question: "Do I need an API key for every endpoint?",
    answer:
      `Almost every public data endpoint on ${PUBLIC_API_HOST} requires ${PUBLIC_API_KEY_HEADER}. The no-key exceptions are health checks, OG images, feedback submission, the Telegram webhook, Telegram Mini App session/mutation, and the self-serve API-key request and verification endpoints; Telegram still authenticates with its own secret or signed Mini App initData. Admin routes use Cloudflare Access instead of public API keys.`,
  },
  {
    question: "What is the difference between the public API lane and the website lane?",
    answer:
      `The public lane is ${PUBLIC_API_HOST} and requires a valid ${PUBLIC_API_KEY_HEADER}. The website lane is same-origin /_site-data/* for browsers on pharos.watch, ops.pharos.watch, and Pages previews; the Pages function rejects requests without an allowed Origin or Referer, so external integrations should use the public API lane.`,
  },
  {
    question: "How is admin auth handled?",
    answer:
      "Admin routes live behind Cloudflare Access on ops.pharos.watch and ops-api.pharos.watch. They do not use public API keys; access is granted through the Pharos Cloudflare Access team domain.",
  },
];

const INLINE_CODE_CLASS = "rounded bg-muted px-1.5 py-0.5 font-mono tabular-nums text-[0.92em] text-foreground [overflow-wrap:anywhere]";
const METHOD_BADGE_CLASS =
  "inline-flex shrink-0 rounded-full border px-2 py-0.5 font-mono tabular-nums text-[11px] font-bold leading-tight";
const METHOD_BADGE_STYLES = {
  section: {
    GET: "border-emerald-500/25 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    POST: "border-amber-500/25 bg-amber-500/15 text-amber-700 dark:text-amber-400",
  },
  directory: {
    GET: "border-emerald-500/25 bg-emerald-500/15 text-emerald-700 dark:text-emerald-500",
    POST: "border-amber-500/25 bg-amber-500/15 text-amber-700 dark:text-amber-500",
  },
} as const;

function stripMarkdownHeadingFormatting(text: string) {
  return text.replaceAll("`", "");
}

function InlineCode({ children }: ComponentProps<"code">) {
  return <code className={INLINE_CODE_CLASS}>{children}</code>;
}

function MethodBadge({
  method,
  tone,
}: {
  method: "GET" | "POST";
  tone: keyof typeof METHOD_BADGE_STYLES;
}) {
  return <span className={cn(METHOD_BADGE_CLASS, METHOD_BADGE_STYLES[tone][method])}>{method}</span>;
}

const inlineMarkdownComponents = {
  p: ({ children }: ComponentProps<"p">) => <>{children}</>,
  a: markdownLinkComponent({ httpOnly: true }),
  code: InlineCode,
  strong: ({ children }: ComponentProps<"strong">) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
};

function InlineMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown components={inlineMarkdownComponents} remarkPlugins={[remarkGfm]}>
      {text}
    </ReactMarkdown>
  );
}

function MarkdownBlockRenderer({
  block,
  tableId,
  tableLabel = "API reference table",
}: {
  block: MarkdownBlock;
  tableId?: string;
  tableLabel?: string;
}) {
  if (block.type === "paragraph") {
    return <p className="text-sm leading-relaxed text-muted-foreground"><InlineMarkdown text={block.text} /></p>;
  }

  if (block.type === "list") {
    const ListTag = block.ordered ? "ol" : "ul";

    return (
      <ListTag className={`space-y-2 pl-5 text-sm leading-relaxed text-muted-foreground ${block.ordered ? "list-decimal" : "list-disc"}`}>
        {block.items.map((item, index) => (
          <li key={`${index}-${item}`}><InlineMarkdown text={item} /></li>
        ))}
      </ListTag>
    );
  }

  if (block.type === "table") {
    return (
      <TableFrame
        tableId={tableId}
        testId={tableId ? `${tableId}-table` : undefined}
        chrome="content"
        density="compact"
        className="bg-background/35"
        tableClassName="min-w-full border-collapse text-left text-sm"
        tableProps={{ "aria-label": tableLabel }}
        viewportProps={{ compactBottomPadding: false, mobileScrollHint: false }}
      >
        <TableHeader className="bg-muted/35">
          <TableRow className="hover:bg-transparent">
            {block.headers.map((header, index) => (
              <TableHead
                key={`${index}-${header}`}
                scope="col"
                className="h-auto whitespace-normal border-b border-border/60 px-3 py-2 font-semibold text-foreground"
              >
                <InlineMarkdown text={header} />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {block.rows.map((row, rowIndex) => (
            <TableRow key={`row-${rowIndex}`} className="align-top hover:bg-transparent">
              {row.map((cell, cellIndex) => (
                <TableCell
                  key={`${rowIndex}-${cellIndex}`}
                  className="whitespace-normal border-t border-border/50 px-3 py-2 text-muted-foreground"
                >
                  <InlineMarkdown text={cell} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </TableFrame>
    );
  }

  if (block.type === "code") {
    return (
      <div className="overflow-hidden rounded-xl border border-border/60 bg-[var(--code-surface-bg)] text-[var(--code-surface-fg)]">
        <div className="flex items-center justify-between border-b border-[var(--code-surface-border)] px-3 py-2">
          {block.language ? (
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--code-surface-muted)]">
              {block.language}
            </span>
          ) : (
            <span />
          )}
          <CopyButton text={block.code} />
        </div>
        <pre className="overflow-x-auto px-3 py-3 text-xs leading-relaxed">
          <code>{block.code}</code>
        </pre>
      </div>
    );
  }

  return <div className="h-px bg-border/60" aria-hidden="true" />;
}

function SectionRenderer({ section }: { section: ApiReferenceSection }) {
  return (
    <section id={section.id} className="pharos-card-shell space-y-5 px-4 py-5 sm:px-5 sm:py-6">
      <div className="space-y-2">
        <p className="pharos-kicker">Reference Section</p>
        <h2 className="text-2xl font-semibold tracking-tight text-foreground"><InlineMarkdown text={section.title} /></h2>
      </div>

      {section.blocks.length > 0 ? (
        <div className="space-y-4">
          {section.blocks.map((block, index) => (
            <MarkdownBlockRenderer
              key={`${section.id}-block-${index}`}
              block={block}
              tableId={`about-api-${section.id}-table-${index}`}
              tableLabel={`${stripMarkdownHeadingFormatting(section.title)} table`}
            />
          ))}
        </div>
      ) : null}

      {section.subsections.length > 0 ? (
        <div className="space-y-4">
          {section.subsections.map((subsection) => (
            <article
              key={subsection.id}
              id={subsection.id}
              className="rounded-xl border border-border/60 bg-background/45 px-4 py-4"
            >
              <h3 className="mb-4 flex items-center gap-2 text-base font-semibold tracking-tight text-foreground">
                {subsection.method ? <MethodBadge method={subsection.method} tone="section" /> : null}
                <code className="font-mono tabular-nums text-[0.92rem]">
                  {stripMarkdownHeadingFormatting(subsection.title).replace(/^(GET|POST)\s+/, "")}
                </code>
              </h3>
              <div className="space-y-4">
                {subsection.blocks.map((block, index) => (
                  <MarkdownBlockRenderer
                    key={`${subsection.id}-block-${index}`}
                    block={block}
                    tableId={`about-api-${subsection.id}-table-${index}`}
                    tableLabel={`${stripMarkdownHeadingFormatting(subsection.title)} table`}
                  />
                ))}
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

const HIDDEN_SECTIONS = new Set(["admin-auth-and-idempotency", "admin-endpoints"]);

function EndpointDirectory({ endpoints }: { endpoints: ApiReferenceEndpointSummary[] }) {
  return (
    <section className="pharos-card-shell px-4 py-5 sm:px-5 sm:py-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <p className="pharos-kicker">Endpoint Directory</p>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">Public API routes</h2>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            This page keeps the route list scannable. The canonical field tables, examples, and edge-case contracts live in the{" "}
            <Link href="/docs/api-reference/#public-endpoints" className="pharos-prose-link">
              full API reference
            </Link>
            .
          </p>
        </div>
        <Link
          href="/docs/api-reference/"
          className="pharos-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full border border-border/60 px-3 py-2 text-sm font-medium text-foreground hover:bg-muted/60"
        >
          <BookOpen className="h-4 w-4" aria-hidden="true" />
          Full reference
        </Link>
      </div>

      <div className="mt-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {endpoints.map((endpoint) => (
          <Link
            key={endpoint.id}
            href={`/docs/api-reference/#${endpoint.docAnchor}`}
            className="pharos-focus-ring flex min-w-0 items-center gap-2 rounded-xl border border-border/55 bg-background/45 px-3 py-2 text-sm hover:bg-muted/45"
          >
            {endpoint.method ? <MethodBadge method={endpoint.method} tone="directory" /> : null}
            <code className="truncate font-mono tabular-nums text-[0.82rem] text-foreground">{endpoint.path}</code>
          </Link>
        ))}
      </div>
    </section>
  );
}

export default async function AboutApiPage() {
  const document = await loadApiReferenceDocument();
  const conciseSections = getConciseApiReferenceSections(document).filter((s) => !HIDDEN_SECTIONS.has(s.id));
  const endpoints = getPublicApiEndpointSummaries(document);
  const sidebarSections: SidebarSection[] = [
    ...conciseSections.map((section) => ({
      id: section.id,
      label: stripMarkdownHeadingFormatting(section.title),
      subsections: section.subsections.map((sub) => ({
        id: sub.id,
        label: stripMarkdownHeadingFormatting(sub.title).replace(/^(GET|POST)\s+/, ""),
        method: sub.method,
      })),
    })),
    { id: "endpoint-directory", label: "Endpoint Directory", subsections: [] },
  ];

  return (
    <FeaturePageShell
      breadcrumbName="API Reference"
      path="/about/api/"
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "About", url: "/about/" },
        { name: "API Reference", url: "/about/api/" },
      ]}
      title="API Reference"
      leadParagraphs={[
        <>
          The public integration lane is <InlineCode>{PUBLIC_API_HOST}</InlineCode>. In production, protected public
          routes require <InlineCode>{PUBLIC_API_KEY_HEADER}</InlineCode>. The website itself does not use that lane
          directly; it talks to the internal site-data proxy instead.
        </>,
        <>
          For implementation context beyond the HTTP contract, read the{" "}
          <Link href="/docs/api-reference/" className="pharos-prose-link">
            public API reference doc
          </Link>{" "}
          and the broader{" "}
          <Link href="/docs/" className="pharos-prose-link">
            documentation archive
          </Link>
          .
        </>,
        <>
          Prefer machine-readable tooling? Download the{" "}
          <a
            href={PUBLIC_API_ARTIFACTS.openApi}
            className="pharos-prose-link"
          >
            OpenAPI spec
          </a>
          , or import the{" "}
          <a
            href={PUBLIC_API_ARTIFACTS.postmanCollection}
            className="pharos-prose-link"
          >
            Pharos API collection
          </a>{" "}
          with the{" "}
          <a
            href={PUBLIC_API_ARTIFACTS.postmanEnvironment}
            className="pharos-prose-link"
          >
            production environment template
          </a>
          .
        </>,
      ]}
      preface={
        <JsonLdScript json={safeJsonLd(buildApiArtifactCatalogJsonLd())} />
      }
    >
      <div className="space-y-8">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {HERO_LANES.map((lane) => {
          const Icon = lane.icon;
          return (
            <section key={lane.title} className="pharos-card-shell px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1.5">
                  <p className="pharos-kicker">{lane.eyebrow}</p>
                  <h2 className="text-lg font-semibold tracking-tight text-foreground">{lane.title}</h2>
                </div>
                <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/75 text-foreground">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground"><InlineMarkdown text={lane.description} /></p>
            </section>
          );
        })}

        <div className="pharos-card-shell px-4 py-4">
          <p className="pharos-kicker">Quick Facts</p>
          <ul className="mt-3 space-y-2 text-sm leading-relaxed text-muted-foreground">
            <li>
              <span className="font-semibold text-foreground">Public auth:</span> <InlineCode>{PUBLIC_API_KEY_HEADER}</InlineCode>
            </li>
            <li>
              <span className="font-semibold text-foreground">No-key public routes:</span> health, OG images, feedback, self-serve key request, Telegram webhook (Telegram secret)
            </li>
            <li>
              <span className="font-semibold text-foreground">Admin auth:</span> Cloudflare Access on the ops hosts
            </li>
          </ul>
        </div>
      </div>

      <section className="pharos-card-shell px-4 py-5 sm:px-5 sm:py-6">
        <div className="space-y-2">
          <p className="pharos-kicker">Need A Key?</p>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">Request API access by email verification</h2>
        </div>
        <div className="mt-4 space-y-3 text-sm leading-relaxed text-muted-foreground">
          <p>
            If you want a public API key, use the{" "}
            <Link
              href="/api/"
              className="pharos-prose-link"
            >
              self-serve API access form
            </Link>
            .
          </p>
          <p>
            The default self-serve key is {SELF_SERVE_API_KEY_SUMMARY}, scoped to the public external API lane.
          </p>
        </div>
      </section>

      <section id="public-datasets" className="pharos-card-shell space-y-5 px-4 py-5 sm:px-5 sm:py-6">
        <div className="space-y-2">
          <p className="pharos-kicker">No API Key Required</p>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">Public dataset downloads</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            These exports are published snapshots, not live API responses. Check the JSON metadata for the snapshot
            time, row count and methodology; the latest download can be older than today.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {PUBLIC_DATASET_JSON_LD_DESCRIPTORS.map((dataset) => (
            <article key={dataset.slug} id={`dataset-${dataset.slug}`} className="space-y-2 rounded-xl border border-border/60 px-4 py-4">
              <h3 className="font-semibold text-foreground">{dataset.name}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">{dataset.description}</p>
              <ul className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
                {(["json", "csv", "ndjson"] as const).map((format) => (
                  <li key={format}>
                    <a className="pharos-prose-link" href={`/datasets/${dataset.slug}/latest.${format}`}>
                      {format.toUpperCase()}
                    </a>
                  </li>
                ))}
                <li><a className="pharos-prose-link" href={`/sheets/${dataset.slug}.csv`}>Sheets CSV</a></li>
              </ul>
            </article>
          ))}
        </div>
      </section>

      <FaqSection items={ABOUT_API_FAQ} title="API Access FAQ" includeJsonLd />

      {document.introBlocks.length > 0 ? (
        <section className="pharos-card-shell px-4 py-5 sm:px-5 sm:py-6">
          <div className="space-y-2">
            <p className="pharos-kicker">Getting Started</p>
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">Before You Call The API</h2>
          </div>
          <div className="mt-4 space-y-4">
            {document.introBlocks.map((block, index) => (
              <MarkdownBlockRenderer
                key={`intro-${index}`}
                block={block}
                tableId={`about-api-intro-table-${index}`}
                tableLabel="API reference introduction table"
              />
            ))}
          </div>
        </section>
      ) : null}

      {/* Zone 2: Two-column reference body */}
      <ApiReferenceLayout sections={sidebarSections}>
        {conciseSections.map((section) => (
          <SectionRenderer key={section.id} section={section} />
        ))}
        <div id="endpoint-directory">
          <EndpointDirectory endpoints={endpoints} />
        </div>
      </ApiReferenceLayout>
      </div>
    </FeaturePageShell>
  );
}

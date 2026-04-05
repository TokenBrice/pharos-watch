import type { ReactNode } from "react";
import Link from "next/link";
import { Globe, KeyRound, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/copy-button";
import { ApiReferenceLayout } from "@/components/api-reference-layout";
import type { SidebarSection } from "@/components/api-reference-sidebar";
import { safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { loadApiReferenceDocument, type MarkdownBlock, type ApiReferenceSection } from "@/lib/api-reference-doc";

export const metadata = buildPageMetadata({
  title: "Pharos API Reference",
  description:
    "Auth model, API-key requirements, host split, and the full Pharos endpoint reference for external integrations.",
  canonical: "/about/api/",
});

const HERO_LANES = [
  {
    title: "External API",
    icon: KeyRound,
    eyebrow: "For integrations",
    description:
      "Call `https://api.pharos.watch` directly. Protected public routes require `X-API-Key`; missing or invalid keys receive `401`.",
  },
  {
    title: "Website lane",
    icon: Globe,
    eyebrow: "For pharos.watch only",
    description:
      "Browsers on the site use same-origin `/_site-data/*`, which proxies to the internal Worker lane. External consumers should not use this path.",
  },
  {
    title: "Ops lane",
    icon: ShieldCheck,
    eyebrow: "For operators",
    description:
      "Admin routes live behind Cloudflare Access on `ops.pharos.watch` and `ops-api.pharos.watch`. They do not use public API keys.",
  },
] as const;

function stripMarkdownHeadingFormatting(text: string) {
  return text.replaceAll("`", "");
}

function renderInlineMarkdown(text: string) {
  const parts: ReactNode[] = [];
  const pattern = /(\[[^\]]+\]\((?:https?:\/\/|\/)[^)]+\)|`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null = null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    if (token.startsWith("`") && token.endsWith("`")) {
      parts.push(
        <code key={`code-${key++}`} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.92em] text-foreground">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**") && token.endsWith("**")) {
      parts.push(
        <strong key={`strong-${key++}`} className="font-semibold text-foreground">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (!linkMatch) {
        parts.push(token);
      } else {
        const [, label, href] = linkMatch;
        if (href.startsWith("/")) {
          parts.push(
            <Link key={`link-${key++}`} href={href} className="pharos-focus-ring rounded-sm underline underline-offset-4 hover:text-foreground">
              {label}
            </Link>,
          );
        } else {
          parts.push(
            <a
              key={`link-${key++}`}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="pharos-focus-ring rounded-sm underline underline-offset-4 hover:text-foreground"
            >
              {label}
            </a>,
          );
        }
      }
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

function MarkdownBlockRenderer({ block }: { block: MarkdownBlock }) {
  if (block.type === "paragraph") {
    return <p className="text-sm leading-relaxed text-muted-foreground">{renderInlineMarkdown(block.text)}</p>;
  }

  if (block.type === "list") {
    const ListTag = block.ordered ? "ol" : "ul";

    return (
      <ListTag className={`space-y-2 pl-5 text-sm leading-relaxed text-muted-foreground ${block.ordered ? "list-decimal" : "list-disc"}`}>
        {block.items.map((item, index) => (
          <li key={`${index}-${item}`}>{renderInlineMarkdown(item)}</li>
        ))}
      </ListTag>
    );
  }

  if (block.type === "table") {
    return (
      <div className="overflow-x-auto rounded-xl border border-border/60 bg-background/35">
        <table className="min-w-full border-collapse text-left text-sm">
          <thead className="bg-muted/35">
            <tr>
              {block.headers.map((header, index) => (
                <th key={`${index}-${header}`} className="border-b border-border/60 px-3 py-2 font-semibold text-foreground">
                  {renderInlineMarkdown(header)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={`${rowIndex}-${row.join("|")}`} className="align-top">
                {row.map((cell, cellIndex) => (
                  <td key={`${rowIndex}-${cellIndex}`} className="border-t border-border/50 px-3 py-2 text-muted-foreground">
                    {renderInlineMarkdown(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (block.type === "code") {
    return (
      <div className="overflow-hidden rounded-xl border border-border/60 bg-zinc-950 text-zinc-100 shadow-[0_12px_28px_oklch(0_0_0_/0.18)]">
        <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
          {block.language ? (
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-400">
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
    <section id={section.id} className="space-y-5 rounded-[1.5rem] border border-border/60 bg-card/70 px-4 py-5 shadow-[0_18px_40px_oklch(0_0_0_/0.08)] sm:px-5 sm:py-6">
      <div className="space-y-2">
        <p className="pharos-kicker">Reference Section</p>
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">{renderInlineMarkdown(section.title)}</h2>
      </div>

      {section.blocks.length > 0 ? (
        <div className="space-y-4">
          {section.blocks.map((block, index) => (
            <MarkdownBlockRenderer key={`${section.id}-block-${index}`} block={block} />
          ))}
        </div>
      ) : null}

      {section.subsections.length > 0 ? (
        <div className="space-y-4">
          {section.subsections.map((subsection) => (
            <article
              key={subsection.id}
              id={subsection.id}
              className="rounded-[1.2rem] border border-border/60 bg-background/45 px-4 py-4"
            >
              <h3 className="mb-4 flex items-center gap-2 text-base font-semibold tracking-tight text-foreground">
                {subsection.method ? (
                  <span
                    className={cn(
                      "inline-flex shrink-0 rounded-full border px-2 py-0.5 font-mono text-[11px] font-bold leading-tight",
                      subsection.method === "GET" && "border-emerald-500/25 bg-emerald-500/15 text-emerald-400",
                      subsection.method === "POST" && "border-amber-500/25 bg-amber-500/15 text-amber-400",
                    )}
                  >
                    {subsection.method}
                  </span>
                ) : null}
                <code className="font-mono text-[0.92rem]">
                  {stripMarkdownHeadingFormatting(subsection.title).replace(/^(GET|POST)\s+/, "")}
                </code>
              </h3>
              <div className="space-y-4">
                {subsection.blocks.map((block, index) => (
                  <MarkdownBlockRenderer key={`${subsection.id}-block-${index}`} block={block} />
                ))}
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export default async function AboutApiPage() {
  const document = await loadApiReferenceDocument();
  const sidebarSections: SidebarSection[] = document.sections.map((section) => ({
    id: section.id,
    label: stripMarkdownHeadingFormatting(section.title),
    subsections: section.subsections.map((sub) => ({
      id: sub.id,
      label: stripMarkdownHeadingFormatting(sub.title).replace(/^(GET|POST)\s+/, ""),
      method: sub.method,
    })),
  }));

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
              { "@type": "ListItem", position: 2, name: "About", item: "https://pharos.watch/about/" },
              { "@type": "ListItem", position: 3, name: "API Reference", item: "https://pharos.watch/about/api/" },
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
          <Link href="/about/" className="pharos-focus-ring rounded-sm hover:text-foreground">
            About
          </Link>
          <span>/</span>
          <span className="text-foreground">API Reference</span>
        </nav>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,0.72fr)_minmax(18rem,0.28fr)] xl:items-end">
          <div className="space-y-3">
            <div className="space-y-2">
              <p className="pharos-kicker">External Integrations</p>
              <h1 className="text-4xl font-extrabold tracking-tighter sm:text-[3.3rem]">API Reference</h1>
              <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
                The public integration lane is <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.92em] text-foreground">https://api.pharos.watch</code>.
                In production, protected public routes require <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.92em] text-foreground">X-API-Key</code>.
                The website itself does not use that lane directly; it talks to the internal site-data proxy instead.
              </p>
            </div>
          </div>

          <div className="rounded-2xl border border-border/60 bg-card/72 px-4 py-4">
            <p className="pharos-kicker">Quick Facts</p>
            <ul className="mt-3 space-y-2 text-sm leading-relaxed text-muted-foreground">
              <li>
                <span className="font-semibold text-foreground">Public auth:</span> <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.92em] text-foreground">X-API-Key</code>
              </li>
              <li>
                <span className="font-semibold text-foreground">Exempt public routes:</span> health, OG images, feedback, Telegram webhook
              </li>
              <li>
                <span className="font-semibold text-foreground">Admin auth:</span> Cloudflare Access on the ops hosts
              </li>
            </ul>
          </div>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {HERO_LANES.map((lane) => {
          const Icon = lane.icon;
          return (
            <section key={lane.title} className="rounded-2xl border border-border/60 bg-card/72 px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1.5">
                  <p className="pharos-kicker">{lane.eyebrow}</p>
                  <h2 className="text-lg font-semibold tracking-tight text-foreground">{lane.title}</h2>
                </div>
                <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/75 text-foreground">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{lane.description}</p>
            </section>
          );
        })}
      </div>

      <section className="rounded-[1.5rem] border border-amber-500/30 bg-amber-500/8 px-4 py-5 shadow-[0_18px_40px_oklch(0_0_0_/0.08)] sm:px-5 sm:py-6">
        <div className="space-y-2">
          <p className="pharos-kicker text-amber-700 dark:text-amber-400">Need A Key?</p>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">Request API access on Telegram</h2>
        </div>
        <div className="mt-4 space-y-3 text-sm leading-relaxed text-muted-foreground">
          <p>
            If you want a public API key, join the{" "}
            <a
              href="https://t.me/pharoswatch"
              target="_blank"
              rel="noopener noreferrer"
              className="pharos-focus-ring rounded-sm underline underline-offset-4 hover:text-foreground"
            >
              Pharos Telegram channel
            </a>{" "}
            and ask for one there.
          </p>
          <p>
            Include your intended usage in the request: what you are building, which endpoints you expect to call, your
            approximate polling cadence, and the expected request volume. That makes it possible to issue the right key
            and rate-limit profile up front.
          </p>
        </div>
      </section>

      {document.introBlocks.length > 0 ? (
        <section className="rounded-[1.5rem] border border-border/60 bg-card/70 px-4 py-5 shadow-[0_18px_40px_oklch(0_0_0_/0.08)] sm:px-5 sm:py-6">
          <div className="space-y-2">
            <p className="pharos-kicker">Base Contract</p>
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">Before You Call The API</h2>
          </div>
          <div className="mt-4 space-y-4">
            {document.introBlocks.map((block, index) => (
              <MarkdownBlockRenderer key={`intro-${index}`} block={block} />
            ))}
          </div>
        </section>
      ) : null}

      {/* Zone 2: Two-column reference body */}
      <ApiReferenceLayout sections={sidebarSections}>
        {document.sections.map((section) => (
          <SectionRenderer key={section.id} section={section} />
        ))}
      </ApiReferenceLayout>
    </div>
  );
}

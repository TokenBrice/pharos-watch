import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Newsreader } from "next/font/google";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { DigestSnapshot } from "@/components/digest-snapshot";
import { splitDigestParagraphs, EDITORIAL_BODY_STYLE } from "@/lib/digest";
import { summarizeText } from "@/lib/page-metadata";
import digests from "../../../../data/digests.json";

interface DigestEntry {
  date: string;
  title: string;
  text: string;
  extended: string;
  generatedAt: number;
  digestType?: "daily" | "weekly";
  editionNumber?: number;
}

const titleFont = Newsreader({
  weight: "variable",
  style: ["normal", "italic"],
  subsets: ["latin"],
  display: "swap",
  axes: ["opsz"],
  fallback: ["Georgia", "Times New Roman", "serif"],
});

const allDigests = digests as DigestEntry[];
const digestByDate = new Map(allDigests.map((d) => [d.date, d]));

export function generateStaticParams() {
  return allDigests.map((d) => ({ date: d.date }));
}

function formatDate(dateStr: string): string {
  const [y, m, d] = dateStr.replace(/-weekly$/, "").split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export async function generateMetadata({ params }: { params: Promise<{ date: string }> }): Promise<Metadata> {
  const { date } = await params;
  const digest = digestByDate.get(date);
  if (!digest) {
    return {
      title: "Digest Not Found | Pharos",
      robots: { index: false },
    };
  }
  const formatted = formatDate(digest.date);
  const description = summarizeText(digest.text, 160);
  return {
    title: `${digest.title} (${formatted})`,
    description,
    alternates: { canonical: `/digest/${digest.date}/` },
    openGraph: {
      title: `${digest.title} (${formatted}) | Pharos`,
      description,
      url: `/digest/${digest.date}/`,
      type: "article",
      publishedTime: new Date(digest.generatedAt * 1000).toISOString(),
      images: [{ url: "/og-card.png", width: 1200, height: 628 }],
    },
    twitter: {
      images: [{ url: "/og-card.png", width: 1200, height: 628 }],
    },
  };
}

export default async function DigestDetailPage({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params;
  const digest = digestByDate.get(date);
  if (!digest) notFound();

  const formatted = formatDate(digest.date);
  const extendedParagraphs = splitDigestParagraphs(digest.extended);
  const isWeekly = digest.digestType === "weekly";
  const editionKicker = digest.editionNumber
    ? (isWeekly ? `Weekly Recap #${digest.editionNumber}` : `Daily Digest #${digest.editionNumber}`)
    : (isWeekly ? "Weekly Recap" : undefined);

  // Find prev/next digests
  const idx = allDigests.findIndex((d) => d.date === digest.date);
  const newer = idx > 0 ? allDigests[idx - 1] : null;
  const older = idx < allDigests.length - 1 ? allDigests[idx + 1] : null;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <BreadcrumbJsonLd name={`${isWeekly ? "Weekly Recap" : "Daily Digest"}: ${formatted}`} path={`/digest/${digest.date}/`} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Article",
            headline: `${digest.title} (${formatted})`,
            datePublished: new Date(digest.generatedAt * 1000).toISOString(),
            description: summarizeText(digest.text, 160),
            author: {
              "@type": "Organization",
              name: "Pharos",
              url: "https://pharos.watch",
            },
            publisher: {
              "@type": "Organization",
              name: "Pharos",
              url: "https://pharos.watch",
              logo: "https://pharos.watch/pharos-icon.png",
            },
            mainEntityOfPage: `https://pharos.watch/digest/${digest.date}/`,
          }),
        }}
      />
      <div className="space-y-2">
        <nav aria-label="Breadcrumb">
          <ol className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <li>
              <Link href="/" className="pharos-focus-ring hover:text-foreground transition-colors">Dashboard</Link>
            </li>
            <li aria-hidden="true">/</li>
            <li>
              <Link href="/digest/" className="pharos-focus-ring hover:text-foreground transition-colors">Digest Archive</Link>
            </li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="text-foreground">{formatted}</li>
          </ol>
        </nav>
        {editionKicker && (
          <p className="pharos-kicker">
            {editionKicker}
          </p>
        )}
        <h1 className={`${titleFont.className} text-[clamp(2.2rem,5vw,3.5rem)] font-semibold leading-[0.92] tracking-[-0.04em] text-foreground/98 [text-wrap:balance]`}>{digest.title}</h1>
        <p className="text-sm text-muted-foreground">{formatted}</p>
      </div>

      <article className="space-y-6">
        <div className="pharos-card-shell rounded-[1.5rem] px-5 py-5">
          <p className="pharos-kicker">Executive Summary</p>
          <p
            className="mt-3 text-[1.1rem] leading-8 text-foreground/92"
            style={EDITORIAL_BODY_STYLE}
          >
            {digest.text}
          </p>
        </div>

        <div className="mx-auto max-w-[68ch] space-y-4">
          {extendedParagraphs.map((para, i) => {
            const headerMatch = para.match(/^\*\*(.+?)\*\*\s*/);
            const headerText = headerMatch?.[1]?.replace(/\.+$/, "");
            const bodyText = headerMatch ? para.slice(headerMatch[0].length) : para;
            return (
              <p
                key={i}
                className="text-[1.05rem] leading-8 text-foreground/92"
                style={EDITORIAL_BODY_STYLE}
              >
                {headerText && (
                  <span className="font-semibold tracking-wide">
                    {headerText}.{" "}
                  </span>
                )}
                {bodyText}
              </p>
            );
          })}
        </div>
      </article>

      <DigestSnapshot date={digest.date} />

      <nav aria-label="Digest navigation" className="flex items-center justify-between pt-4 border-t border-border/50 text-sm">
        {older ? (
          <Link
            href={`/digest/${older.date}/`}
            aria-label={`Older digest: ${formatDate(older.date)}`}
            className="pharos-focus-ring text-muted-foreground hover:text-foreground transition-colors"
          >
            &larr; {formatDate(older.date)}
          </Link>
        ) : (
          <span />
        )}
        {newer ? (
          <Link
            href={`/digest/${newer.date}/`}
            aria-label={`Newer digest: ${formatDate(newer.date)}`}
            className="pharos-focus-ring text-muted-foreground hover:text-foreground transition-colors"
          >
            {formatDate(newer.date)} &rarr;
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </div>
  );
}

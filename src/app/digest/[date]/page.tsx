import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { DigestSnapshot } from "@/components/digest-snapshot";
import digests from "../../../../data/digests.json";

interface DigestEntry {
  date: string;
  title: string;
  text: string;
  extended: string;
  generatedAt: number;
}

const allDigests = digests as DigestEntry[];
const digestByDate = new Map(allDigests.map((d) => [d.date, d]));

export function generateStaticParams() {
  return allDigests.map((d) => ({ date: d.date }));
}

function formatDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ date: string }>;
}): Promise<Metadata> {
  const { date } = await params;
  const digest = digestByDate.get(date);
  if (!digest) return {};
  const formatted = formatDate(digest.date);
  const description = digest.text.slice(0, 160);
  return {
    title: `Daily Digest: ${formatted}`,
    description,
    alternates: { canonical: `/digest/${digest.date}/` },
    openGraph: {
      title: `Daily Digest: ${formatted} | Pharos`,
      description,
      url: `/digest/${digest.date}/`,
      type: "article",
      publishedTime: new Date(digest.generatedAt * 1000).toISOString(),
    },
  };
}

export default async function DigestDetailPage({
  params,
}: {
  params: Promise<{ date: string }>;
}) {
  const { date } = await params;
  const digest = digestByDate.get(date);
  if (!digest) notFound();

  const formatted = formatDate(digest.date);

  // Find prev/next digests
  const idx = allDigests.findIndex((d) => d.date === digest.date);
  const newer = idx > 0 ? allDigests[idx - 1] : null;
  const older = idx < allDigests.length - 1 ? allDigests[idx + 1] : null;

  return (
    <div className="space-y-6">
      <BreadcrumbJsonLd name={`Daily Digest: ${formatted}`} path={`/digest/${digest.date}/`} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Article",
            headline: `${digest.title}, ${formatted}`,
            datePublished: new Date(digest.generatedAt * 1000).toISOString(),
            description: digest.text.slice(0, 160),
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
        <nav
          aria-label="Breadcrumb"
          className="flex items-center gap-1.5 text-sm text-muted-foreground"
        >
          <Link href="/" className="hover:text-foreground transition-colors">
            Dashboard
          </Link>
          <span>/</span>
          <Link href="/digest/" className="hover:text-foreground transition-colors">
            Digest Archive
          </Link>
          <span>/</span>
          <span className="text-foreground">{formatted}</span>
        </nav>
        <p className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
          {digest.title}
          <span className="font-normal tracking-wide"> &middot; {formatted}</span>
        </p>
      </div>

      <article>
        <p
          className="text-[1.15rem] leading-relaxed text-foreground/90 italic"
          style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
        >
          {digest.text}
        </p>
        {digest.extended && (
          <p
            className="text-[1.15rem] leading-relaxed text-foreground/90 italic mt-4"
            style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
          >
            {digest.extended}
          </p>
        )}
      </article>

      <DigestSnapshot date={digest.date} />

      <nav className="flex items-center justify-between pt-4 border-t border-border/50 text-sm">
        {older ? (
          <Link
            href={`/digest/${older.date}/`}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            &larr; {formatDate(older.date)}
          </Link>
        ) : (
          <span />
        )}
        {newer ? (
          <Link
            href={`/digest/${newer.date}/`}
            className="text-muted-foreground hover:text-foreground transition-colors"
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

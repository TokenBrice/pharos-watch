import dynamic from "next/dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { Skeleton } from "@/components/ui/skeleton";

const CompareClient = dynamic(
  () => import("./client").then((m) => ({ default: m.CompareClient })),
  { loading: () => <Skeleton className="h-[400px] w-full rounded-xl" /> },
);

const compareDescription = `Side-by-side comparison of stablecoin stats, supply history, and peg stability for ${TRACKED_STABLECOINS.length} tracked stablecoins.`;

export const metadata: Metadata = {
  title: "Compare Stablecoins — Side-by-Side Analysis",
  description: compareDescription,
  alternates: {
    canonical: "/compare/",
  },
  openGraph: {
    title: "Compare Stablecoins — Side-by-Side Analysis",
    description: compareDescription,
    url: "/compare/",
    images: [{ url: "https://pharos.watch/og-compare.png", width: 1200, height: 630 }],
  },
};

export default function ComparePage() {
  return (
    <div className="space-y-6">
      <BreadcrumbJsonLd name="Compare" path="/compare/" />
      <div className="space-y-2">
        <nav
          aria-label="Breadcrumb"
          className="flex items-center gap-1.5 text-sm text-muted-foreground"
        >
          <Link
            href="/"
            className="hover:text-foreground transition-colors"
          >
            Dashboard
          </Link>
          <span>/</span>
          <span className="text-foreground">Compare</span>
        </nav>
        <h1 className="text-4xl font-extrabold tracking-tighter">
          Compare Stablecoins
        </h1>
        <p className="text-sm text-muted-foreground">
          Select up to 5 stablecoins to compare side-by-side.
        </p>
      </div>
      <CompareClient />
    </div>
  );
}

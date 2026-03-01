import dynamic from "next/dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { Skeleton } from "@/components/ui/skeleton";

const YieldClient = dynamic(
  () => import("./client").then((m) => ({ default: m.YieldClient })),
  { loading: () => <Skeleton className="h-[600px] w-full rounded-xl" /> },
);

const yieldBearingCount = TRACKED_STABLECOINS.filter((m) => m.flags.yieldBearing).length;
const desc = `Risk-adjusted yield rankings for ${yieldBearingCount} yield-bearing stablecoins. Compare APY, safety grades, and the Pharos Yield Score.`;

export const metadata: Metadata = {
  title: "Yield Intelligence | Pharos",
  description: desc,
  alternates: { canonical: "/yield/" },
  openGraph: {
    title: "Stablecoin Yield Intelligence",
    description: desc,
    url: "/yield/",
  },
};

export default function YieldPage() {
  return (
    <div className="space-y-6">
      <BreadcrumbJsonLd name="Yield Intelligence" path="/yield/" />
      <div className="space-y-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
          <span>/</span>
          <span className="text-foreground">Yield Intelligence</span>
        </nav>
        <h1 className="text-4xl font-extrabold tracking-tighter">Yield Intelligence</h1>
        <p className="text-sm text-muted-foreground">
          Risk-adjusted yield rankings for {yieldBearingCount} yield-bearing stablecoins.
          Compare APY, safety grades, and the Pharos Yield Score (PYS).
        </p>
      </div>
      <YieldClient />
    </div>
  );
}

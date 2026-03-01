import dynamic from "next/dynamic";
import type { Metadata } from "next";
import Link from "next/link";
import { TRACKED_STABLECOINS } from "@/lib/stablecoins";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { Skeleton } from "@/components/ui/skeleton";

const DepegClient = dynamic(
  () => import("./client").then((m) => ({ default: m.DepegClient })),
  { loading: () => <Skeleton className="h-[400px] w-full rounded-xl" /> },
);

const depegDescription = `Live peg monitoring, deviation heatmaps, early warning scores, and depeg event tracking for ${TRACKED_STABLECOINS.length} stablecoins.`;

export const metadata: Metadata = {
  title: "Depeg Tracker: Live Peg Monitoring & Early Warnings",
  description: depegDescription,
  alternates: {
    canonical: "/depeg/",
  },
  openGraph: {
    title: "Depeg Tracker: Live Peg Monitoring & Early Warnings",
    description: depegDescription,
    url: "/depeg/",
  },
};

export default function DepegPage() {
  return (
    <div className="space-y-6">
      <BreadcrumbJsonLd name="Depeg Tracker" path="/depeg/" />
      <div className="space-y-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
          <span>/</span>
          <span className="text-foreground">Depeg Tracker</span>
        </nav>
        <h1 className="text-4xl font-extrabold tracking-tighter">Depeg Tracker</h1>
        <p className="text-sm text-muted-foreground">
          Real-time peg monitoring across {TRACKED_STABLECOINS.length} stablecoins.
          Peg scores, DEWS early warning signals, live deviation heatmaps, and a
          full history of depeg events — all in one place.
        </p>
      </div>
      <DepegClient />
    </div>
  );
}

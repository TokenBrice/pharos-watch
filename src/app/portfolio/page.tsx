import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { PortfolioClient } from "./client";

const description =
  "Build your stablecoin portfolio, see your weighted safety grade, upstream collateral exposure, and simulate how a major stablecoin failure would affect your holdings.";

export const metadata: Metadata = {
  title: "Portfolio — Personal Stablecoin Risk View",
  description,
  alternates: { canonical: "/portfolio/" },
  openGraph: {
    title: "Portfolio — Personal Stablecoin Risk View",
    description,
    url: "/portfolio/",
  },
};

export default function PortfolioPage() {
  return (
    <div className="space-y-6">
      <BreadcrumbJsonLd name="Portfolio" path="/portfolio/" />
      <div className="space-y-2">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground transition-colors">Dashboard</Link>
          <span>/</span>
          <span className="text-foreground">Portfolio</span>
        </nav>
        <h1 className="text-4xl font-extrabold tracking-tighter">Portfolio</h1>
        <p className="text-sm text-muted-foreground">
          Track your stablecoin holdings and assess your personal risk exposure.
        </p>
      </div>
      <Suspense>
        <PortfolioClient />
      </Suspense>
    </div>
  );
}

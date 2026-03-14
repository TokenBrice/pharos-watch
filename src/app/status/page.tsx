import type { Metadata } from "next";
import StatusClient from "./client";

export const metadata: Metadata = {
  title: "System Status | Pharos",
  description: "Public Pharos system health, cache freshness, and endpoint availability.",
  alternates: { canonical: "/status/" },
  robots: { index: false, follow: false },
  openGraph: {
    title: "System Status | Pharos",
    description: "Public system health dashboard.",
    type: "website",
    url: "/status/",
    images: [{ url: "/og-card.png", width: 1200, height: 628 }],
  },
  twitter: {
    images: [{ url: "/og-card.png", width: 1200, height: 628 }],
  },
};

export default function StatusPage() {
  return <StatusClient />;
}

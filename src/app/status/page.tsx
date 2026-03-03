import type { Metadata } from "next";
import StatusClient from "./client";

export const metadata: Metadata = {
  title: "System Status",
  description: "Admin status dashboard for Pharos data pipeline monitoring.",
  alternates: { canonical: "/status/" },
  robots: { index: false, follow: false },
};

export default function StatusPage() {
  return <StatusClient />;
}

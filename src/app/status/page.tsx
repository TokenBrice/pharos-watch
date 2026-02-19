import type { Metadata } from "next";
import StatusClient from "./client";

export const metadata: Metadata = {
  title: "System Status — Pharos",
  description: "Admin status dashboard for Pharos data pipeline monitoring.",
  robots: { index: false, follow: false },
};

export default function StatusPage() {
  return <StatusClient />;
}

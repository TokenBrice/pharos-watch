import type { Metadata } from "next";
import AdminClient from "./client";

export const metadata: Metadata = {
  title: "Operator Admin | Pharos",
  description: "Access-protected operator control panel for Pharos.",
  alternates: { canonical: "/admin/" },
  robots: { index: false, follow: false },
};

export default function AdminPage() {
  return <AdminClient />;
}

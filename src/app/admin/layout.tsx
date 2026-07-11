import type { Metadata } from "next";
import type { ReactNode } from "react";
import { OpsShell } from "@/components/ops-shell";
import { AdminActionExecutionProvider } from "@/components/status/admin-action-execution-provider";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <OpsShell>
      <AdminActionExecutionProvider>{children}</AdminActionExecutionProvider>
    </OpsShell>
  );
}

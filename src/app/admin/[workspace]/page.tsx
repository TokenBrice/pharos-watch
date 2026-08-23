import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { buildPageMetadata } from "@/lib/page-metadata";
import ActionsClient from "../actions/client";
import CommsClient from "../comms/client";
import CronsClient from "../crons/client";
import HistoryClient from "../history/client";
import PipelineClient from "../pipeline/client";
import ReliabilityClient from "../reliability/client";

const WORKSPACES = {
  actions: {
    title: "Operator Actions",
    description: "Access-protected recovery, audit, and backfill action workspace for Pharos operators.",
    Client: ActionsClient,
  },
  comms: {
    title: "Operator Comms",
    description: "Access-protected Telegram delivery and operator messaging workspace for Pharos operators.",
    Client: CommsClient,
  },
  crons: {
    title: "Operator Cron Lanes",
    description: "Access-protected scheduled-job health and execution workspace for Pharos operators.",
    Client: CronsClient,
  },
  history: {
    title: "Operator Incident History",
    description: "Access-protected status transitions and release-correlation workspace for Pharos operators.",
    Client: HistoryClient,
  },
  pipeline: {
    title: "Operator Pipeline",
    description: "Access-protected stablecoin pipeline health workspace for Pharos operators.",
    Client: PipelineClient,
  },
  reliability: {
    title: "Operator Reliability",
    description: "Access-protected endpoint, cache, circuit, and demand reliability workspace for Pharos operators.",
    Client: ReliabilityClient,
  },
} as const;

export function generateStaticParams() {
  return Object.keys(WORKSPACES).map((workspace) => ({ workspace }));
}

export async function generateMetadata({ params }: { params: Promise<{ workspace: string }> }): Promise<Metadata> {
  const { workspace } = await params;
  const entry = WORKSPACES[workspace as keyof typeof WORKSPACES];
  if (!entry) return { title: "Admin Workspace Not Found", robots: { index: false, follow: false } };
  return buildPageMetadata({
    title: entry.title,
    description: entry.description,
    canonical: `/admin/${workspace}/`,
    robots: { index: false, follow: false },
  });
}

export default async function AdminWorkspacePage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  const entry = WORKSPACES[workspace as keyof typeof WORKSPACES];
  if (!entry) notFound();
  const Client = entry.Client;
  return <Client />;
}

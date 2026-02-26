"use client";

import Link from "next/link";
import { ScrollText } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDigestArchive } from "@/hooks/use-digest-archive";

export function DigestArchiveSummary() {
  const { data, isLoading } = useDigestArchive();

  if (isLoading) {
    return (
      <Card className="rounded-xl border-l-[3px] border-l-violet-500">
        <CardHeader className="pb-2">
          <Skeleton className="h-4 w-32" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  const digests = data?.digests ?? [];
  const count = digests.length;
  const latest = count > 0 ? digests[0].generatedAt : null;
  const oldest = count > 0 ? digests[count - 1].generatedAt : null;

  const latestFormatted = latest
    ? new Date(latest * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "—";
  const sinceYear = oldest
    ? new Date(oldest * 1000).getFullYear()
    : "—";

  return (
    <Card className="rounded-xl border-l-[3px] border-l-violet-500">
      <CardHeader className="pb-2">
        <CardTitle as="h2" className="flex items-center justify-between">
          <span className="flex items-center gap-1.5"><ScrollText className="h-4 w-4" />Digest Archive</span>
          <Link
            href="/digest/"
            className="text-xs font-normal text-muted-foreground hover:text-foreground transition-colors"
          >
            View archive &rarr;
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4" aria-live="polite">
          <div>
            <p className="text-2xl font-bold font-mono">{count > 0 ? count : "—"}</p>
            <p className="text-xs text-muted-foreground">recaps published</p>
          </div>
          <div>
            <p className="text-2xl font-bold font-mono">{latestFormatted}</p>
            <p className="text-xs text-muted-foreground">latest entry</p>
          </div>
          <div>
            <p className="text-2xl font-bold font-mono">{sinceYear}</p>
            <p className="text-xs text-muted-foreground">archive since</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

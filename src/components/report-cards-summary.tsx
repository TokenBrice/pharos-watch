"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ClipboardCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useReportCards } from "@/hooks/use-report-cards";

export function ReportCardsSummary() {
  const { data, isLoading } = useReportCards();

  const stats = useMemo(() => {
    if (!data?.cards) return null;
    const graded = data.cards.filter((c) => c.overallGrade !== "NR" && !c.isDefunct);
    const topGrades = graded.filter((c) => c.overallGrade === "A+" || c.overallGrade === "A");
    const lowGrades = graded.filter((c) => c.overallGrade === "D" || c.overallGrade === "F");
    return { total: graded.length, top: topGrades.length, low: lowGrades.length };
  }, [data]);

  if (isLoading) {
    return (
      <Card className="rounded-2xl border-l-[3px] border-l-amber-500">
        <CardHeader>
          <Skeleton className="h-4 w-32" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-2xl border-l-[3px] border-l-amber-500">
      <CardHeader className="pb-2">
        <CardTitle as="h2" className="flex items-center justify-between">
          <span className="flex items-center gap-1.5"><ClipboardCheck className="h-4 w-4" />Report Cards</span>
          <Link
            href="/report-cards"
            className="text-xs font-normal text-muted-foreground hover:text-foreground transition-colors"
          >
            View grades &rarr;
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <p className="text-2xl font-bold font-mono">{stats?.total ?? 0}</p>
            <p className="text-xs text-muted-foreground">coins graded</p>
          </div>
          <div>
            <p className="text-2xl font-bold font-mono text-emerald-500">{stats?.top ?? 0}</p>
            <p className="text-xs text-muted-foreground">A or A+ grade</p>
          </div>
          <div>
            <p className="text-2xl font-bold font-mono text-red-500">{stats?.low ?? 0}</p>
            <p className="text-xs text-muted-foreground">D or F grade</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

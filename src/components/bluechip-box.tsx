import { ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BLUECHIP_REPORT_BASE, GRADE_ORDER } from "@/lib/bluechip";
import type { BluechipRatingsMap } from "@/lib/types";

export function BluechipBox({ stablecoinId, ratingsMap }: { stablecoinId: string; ratingsMap: BluechipRatingsMap | undefined | null }) {
  const rating = ratingsMap?.[stablecoinId];
  if (!rating) return null;

  const order = GRADE_ORDER[rating.grade] ?? 0;
  const textColor = order >= 10 ? "text-emerald-500" : order >= 7 ? "text-blue-500" : order >= 4 ? "text-amber-500" : "text-red-500";

  return (
    <Card className="rounded-xl border-l-[3px] border-l-cyan-500">
      <CardHeader className="pb-1">
        <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Bluechip Rating</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={`text-3xl font-bold font-mono tracking-tight ${textColor}`}>
          {rating.grade}
        </div>
        <p className="text-sm text-muted-foreground">
          {rating.collateralization}% collateralized
        </p>
        <a
          href={`${BLUECHIP_REPORT_BASE}/${rating.slug}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mt-1"
        >
          Full report <ExternalLink className="h-3 w-3" />
        </a>
      </CardContent>
    </Card>
  );
}

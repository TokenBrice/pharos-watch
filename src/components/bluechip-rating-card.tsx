"use client";

import { ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useBluechipRatings } from "@/hooks/use-bluechip-ratings";
import { BLUECHIP_REPORT_BASE, GRADE_ORDER } from "@/lib/bluechip";

const SMIDGE_LABELS = [
  { key: "stability", short: "S", full: "Stability" },
  { key: "management", short: "M", full: "Management" },
  { key: "implementation", short: "I", full: "Implementation" },
  { key: "decentralization", short: "D", full: "Decentralization" },
  { key: "governance", short: "G", full: "Governance" },
  { key: "externals", short: "E", full: "Externals" },
] as const;

function getGradeTier(grade: string): "green" | "blue" | "amber" | "red" {
  const order = GRADE_ORDER[grade] ?? 0;
  if (order >= 10) return "green";
  if (order >= 7) return "blue";
  if (order >= 4) return "amber";
  return "red";
}

const TIER_BORDER = {
  green: "border-l-emerald-500",
  blue: "border-l-blue-500",
  amber: "border-l-amber-500",
  red: "border-l-red-500",
};

const TIER_TEXT = {
  green: "text-emerald-500",
  blue: "text-blue-500",
  amber: "text-amber-500",
  red: "text-red-500",
};

export function BluechipRatingCard({ stablecoinId }: { stablecoinId: string }) {
  const { data: ratingsMap, isLoading } = useBluechipRatings();

  if (isLoading) {
    return (
      <Card className="rounded-2xl border-l-[3px] border-l-muted">
        <CardHeader className="pb-2">
          <Skeleton className="h-3 w-36" />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-6">
            <Skeleton className="h-12 w-12" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-28" />
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const rating = ratingsMap?.[stablecoinId];
  if (!rating) return null;

  const tier = getGradeTier(rating.grade);

  return (
    <Card className={`rounded-2xl border-l-[3px] ${TIER_BORDER[tier]}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle as="h2" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Bluechip Safety Rating
          </CardTitle>
          <a
            href={`${BLUECHIP_REPORT_BASE}/${rating.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Full Report <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-6">
          <div className={`text-4xl font-bold font-mono ${TIER_TEXT[tier]}`}>
            {rating.grade}
          </div>
          <div className="space-y-1 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Collateralization</span>
              <span className="font-mono font-medium">{rating.collateralization}%</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Smart Contract Audit</span>
              <span className={`font-medium ${rating.smartContractAudit ? "text-emerald-500" : "text-red-500"}`}>
                {rating.smartContractAudit ? "Yes" : "No"}
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {SMIDGE_LABELS.map(({ key, short, full }) => {
            const summary = rating.smidge[key as keyof typeof rating.smidge];
            return (
              <span
                key={key}
                title={summary ? `${full}: ${summary}` : `${full}: Not yet assessed`}
                className={`inline-flex items-center justify-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
                  summary
                    ? "bg-muted/50 text-foreground border-border"
                    : "bg-muted/20 text-muted-foreground border-border/50"
                }`}
              >
                <span className="sm:hidden">{short}</span>
                <span className="hidden sm:inline">{full}</span>
              </span>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

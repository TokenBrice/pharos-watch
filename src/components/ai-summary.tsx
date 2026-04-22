import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { DETAIL_SECTION_TITLE_CLASS } from "@/components/stablecoin-detail/section-title";
import type { StablecoinAiSummary } from "@shared/types";

export function AiSummary({ title, text, updatedAt }: StablecoinAiSummary) {
  const isoDate = updatedAt;
  const dateline = new Date(`${updatedAt}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle as="h2" className={DETAIL_SECTION_TITLE_CLASS}>{title}</CardTitle>
          <time className="text-xs text-muted-foreground whitespace-nowrap" dateTime={isoDate}>
            Updated {dateline}
          </time>
        </div>
      </CardHeader>
      <CardContent>
        <p className="font-serif text-[1.05rem] leading-relaxed text-foreground/90 italic">
          {text}
        </p>
      </CardContent>
    </Card>
  );
}

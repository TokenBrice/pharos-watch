import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { DETAIL_SECTION_TITLE_CLASS } from "@/components/stablecoin-detail/section-title";

interface AiSummaryProps {
  title: string;
  text: string;
  updatedAt: string;
}

export function AiSummary({ title, text, updatedAt }: AiSummaryProps) {
  const dateline = new Date(updatedAt + "T00:00:00").toLocaleString("en-US", {
    month: "short",
    year: "numeric",
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle as="h2" className={DETAIL_SECTION_TITLE_CLASS}>{title}</CardTitle>
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            Updated {dateline}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <p
          className="text-[1.05rem] leading-relaxed text-foreground/90 italic"
          style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
        >
          {text}
        </p>
      </CardContent>
    </Card>
  );
}

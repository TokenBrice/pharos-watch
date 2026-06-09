import Link from "next/link";
import { buildAiDisclosureLine, type AiDisclosureFields } from "@/components/ai-disclosure";
import { Badge } from "@/components/ui/badge";

export function AiDisclosureBadge(props: AiDisclosureFields) {
  const disclosure = buildAiDisclosureLine(props);

  if (!disclosure) {
    return null;
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Badge
        variant="outline"
        className="min-w-0 max-w-full shrink whitespace-normal break-words text-left text-[11px] font-medium leading-snug text-muted-foreground"
        data-slot="ai-disclosure-badge"
      >
        {disclosure}
      </Badge>
      <Link
        href="/about/#editorial-ai-policy"
        className="pharos-focus-ring rounded-sm text-[11px] text-muted-foreground underline decoration-dashed underline-offset-2 hover:text-foreground"
      >
        Policy →
      </Link>
    </div>
  );
}

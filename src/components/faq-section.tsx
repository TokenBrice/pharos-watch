import { ChevronDown } from "lucide-react";
import { buildFaqJsonLd, type FaqItem } from "@/lib/faq";
import { safeJsonLd } from "@/lib/json-ld";
import { JsonLdScript } from "@/components/json-ld-script";

interface FaqSectionProps {
  items: readonly FaqItem[];
  title?: string;
  includeJsonLd?: boolean;
}

export function FaqSection({
  items,
  title = "Frequently Asked Questions",
  includeJsonLd = false,
}: FaqSectionProps) {
  return (
    <>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        {items.map((item) => (
          <details key={item.question} className="group border border-border/50 rounded-lg">
            <summary className="pharos-focus-ring flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 py-3 text-sm font-medium transition-colors hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
              {item.question}
              <ChevronDown
                aria-hidden="true"
                className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
              />
            </summary>
            <p className="px-4 pb-4 text-sm text-muted-foreground">
              {item.answer}
            </p>
          </details>
        ))}
      </section>
      {includeJsonLd && (
        <JsonLdScript json={safeJsonLd(buildFaqJsonLd(items))} />
      )}
    </>
  );
}

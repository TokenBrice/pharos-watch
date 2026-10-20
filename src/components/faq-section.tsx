import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { buildFaqJsonLd, type FaqItem } from "@/lib/faq";
import { safeJsonLd } from "@/lib/json-ld";
import { JsonLdScript } from "@/components/json-ld-script";

interface FaqSectionProps {
  items: readonly FaqItem[];
  title?: string;
  includeJsonLd?: boolean;
  renderAnswer?: (answer: string) => ReactNode;
  /**
   * Folds the whole block behind one native disclosure whose summary carries
   * the title and question count. The answers stay in the server HTML, so the
   * content and its FAQPage JSON-LD remain crawlable.
   */
  collapsed?: boolean;
}

export function FaqSection({
  items,
  title = "Frequently asked questions",
  includeJsonLd = false,
  collapsed = false,
  renderAnswer,
}: FaqSectionProps) {
  const questions = items.map((item) => (
    <details key={item.question} className="group border border-border/50 rounded-lg">
      <summary className="pharos-focus-ring flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 py-3 text-sm font-medium transition-colors hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
        {item.question}
        <ChevronDown
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      <p className="px-4 pb-4 text-sm text-muted-foreground">
        {renderAnswer ? renderAnswer(item.answer) : item.answer}
      </p>
    </details>
  ));
  return (
    <>
      {collapsed ? (
        <details className="group/faq">
          <summary className="pharos-focus-ring flex cursor-pointer list-none items-center gap-2 rounded-lg py-1 [&::-webkit-details-marker]:hidden">
            <h2 className="text-lg font-semibold">{title}</h2>
            <span className="text-sm tabular-nums text-muted-foreground">{items.length}</span>
            <ChevronDown
              aria-hidden="true"
              className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open/faq:rotate-180 motion-reduce:transition-none"
            />
          </summary>
          <div className="mt-3 space-y-3">{questions}</div>
        </details>
      ) : (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          {questions}
        </section>
      )}
      {includeJsonLd && (
        <JsonLdScript json={safeJsonLd(buildFaqJsonLd(items))} />
      )}
    </>
  );
}

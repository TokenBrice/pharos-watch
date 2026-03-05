import { buildFaqJsonLd, type FaqItem } from "@/lib/faq";

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
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
              {item.question}
            </summary>
            <p className="px-4 pb-4 text-sm text-muted-foreground">
              {item.answer}
            </p>
          </details>
        ))}
      </section>
      {includeJsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(buildFaqJsonLd(items)) }}
        />
      )}
    </>
  );
}

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
    <div className="border-t border-b border-border/50 py-5 mt-6">
      <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground mb-3">
        {title}
        <span className="font-normal tracking-wide"> · Last updated {dateline}</span>
      </p>
      <p
        className="text-[1.1rem] leading-relaxed text-foreground/90"
        style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
      >
        {text}
      </p>
    </div>
  );
}

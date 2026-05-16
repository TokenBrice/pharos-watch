import { cn } from "@/lib/utils";

interface SectionBannerProps {
  id: string;
  label: string;
  className?: string;
}

export function SectionBanner({ id, label, className }: SectionBannerProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-4 text-muted-foreground",
        className,
      )}
      role="presentation"
    >
      <span aria-hidden className="h-px flex-1 bg-border" />
      <h2
        id={id}
        className="scroll-mt-32 text-[12px] font-semibold uppercase tracking-[0.18em] text-foreground sm:text-[13px]"
      >
        {label}
      </h2>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}

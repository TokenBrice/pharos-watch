import { cn } from "@/lib/utils";

interface CalloutBannerProps {
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function CalloutBanner({ icon, children, className }: CalloutBannerProps) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-lg border border-border/60 bg-muted/20 px-4 py-3 text-sm text-muted-foreground",
        className,
      )}
    >
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <p className="leading-relaxed">{children}</p>
    </div>
  );
}

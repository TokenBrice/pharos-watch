import { cn } from "@/lib/utils";

const STATUS_CONFIG = {
  healthy: {
    label: "Healthy",
    border: "border-emerald-500/35",
    shell: "bg-[linear-gradient(135deg,rgba(5,46,22,0.82),rgba(2,6,23,0.92)_58%,rgba(2,6,23,0.98))]",
    text: "text-emerald-200 dark:text-emerald-200",
    chip: "border-emerald-400/25 bg-emerald-500/12 text-emerald-100",
    line: "from-emerald-300/70 via-emerald-300/18 to-transparent",
    glowStrong: "bg-emerald-400/20",
    glowSoft: "bg-emerald-400/10",
    dot: "bg-emerald-300",
    ghost: "text-emerald-300/8",
  },
  degraded: {
    label: "Degraded",
    border: "border-amber-500/35",
    shell: "bg-[linear-gradient(135deg,rgba(69,26,3,0.86),rgba(2,6,23,0.92)_58%,rgba(2,6,23,0.98))]",
    text: "text-amber-100 dark:text-amber-100",
    chip: "border-amber-300/25 bg-amber-500/12 text-amber-100",
    line: "from-amber-300/70 via-amber-300/18 to-transparent",
    glowStrong: "bg-amber-400/22",
    glowSoft: "bg-amber-400/10",
    dot: "bg-amber-300",
    ghost: "text-amber-200/8",
  },
  stale: {
    label: "Stale",
    border: "border-red-500/35",
    shell: "bg-[linear-gradient(135deg,rgba(69,10,10,0.9),rgba(2,6,23,0.92)_58%,rgba(2,6,23,0.98))]",
    text: "text-red-100 dark:text-red-100",
    chip: "border-red-300/25 bg-red-500/12 text-red-100",
    line: "from-red-300/70 via-red-300/18 to-transparent",
    glowStrong: "bg-red-400/22",
    glowSoft: "bg-red-400/10",
    dot: "bg-red-300",
    ghost: "text-red-200/8",
  },
} as const;

interface StatusBannerProps {
  status: "healthy" | "degraded" | "stale";
  timestamp: number;
  availabilityStatus: "healthy" | "degraded" | "stale";
  dataQualityStatus: "healthy" | "degraded" | "stale";
  rawStatus: "healthy" | "degraded" | "stale";
  confidence: number;
}

export function StatusBanner({
  status,
  timestamp,
  availabilityStatus,
  dataQualityStatus,
  rawStatus,
  confidence,
}: StatusBannerProps) {
  const config = STATUS_CONFIG[status];
  const time = new Date(timestamp * 1000).toLocaleString();
  const statusDetails = [
    { label: "Raw", value: rawStatus },
    { label: "Availability", value: availabilityStatus },
    { label: "Data quality", value: dataQualityStatus },
  ];

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[1.7rem] border px-5 py-5 shadow-[0_28px_80px_oklch(0_0_0_/0.22)]",
        config.border,
        config.shell,
      )}
    >
      <div className="pointer-events-none absolute inset-0 opacity-[0.08] [background-image:linear-gradient(to_right,rgba(148,163,184,0.35)_1px,transparent_1px),linear-gradient(to_bottom,rgba(148,163,184,0.18)_1px,transparent_1px)] [background-size:3.6rem_3.6rem]" />
      <div className={cn("pointer-events-none absolute inset-x-5 top-0 h-px bg-gradient-to-r", config.line)} />
      <div className={cn("pointer-events-none absolute -left-10 top-2 h-40 w-40 rounded-full blur-[95px]", config.glowStrong)} />
      <div className={cn("pointer-events-none absolute right-12 top-10 h-32 w-32 rounded-full blur-[110px]", config.glowSoft)} />
      <div className="pointer-events-none absolute inset-y-5 right-[13rem] hidden w-px bg-white/10 lg:block" />
      <div className={cn("pointer-events-none absolute -bottom-6 right-4 hidden font-mono text-[6.8rem] font-semibold uppercase tracking-[-0.08em] lg:block", config.ghost)}>
        {config.label}
      </div>

      <div className="relative grid gap-5 lg:grid-cols-[minmax(0,1fr)_13rem] lg:items-end">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] uppercase tracking-[0.28em]", config.chip)}>
              <span className={cn("h-2.5 w-2.5 rounded-full", config.dot)} />
              System posture
            </span>
            <span className="font-mono text-xs uppercase tracking-[0.22em] text-white/60">
              confidence {(confidence * 100).toFixed(1)}%
            </span>
          </div>

          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1">
              <div className="text-[11px] uppercase tracking-[0.32em] text-white/45">Overall status</div>
              <div className={cn("text-[clamp(2.6rem,7vw,5.2rem)] font-semibold leading-none tracking-[-0.08em]", config.text)}>
                {config.label}
              </div>
            </div>
            <div className="pb-1 text-sm text-white/70">
              <div className="font-mono">raw {rawStatus}</div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {statusDetails.map((detail) => (
              <span
                key={detail.label}
                className="rounded-full border border-white/12 bg-white/6 px-3 py-1.5 text-xs text-white/78"
              >
                <span className="uppercase tracking-[0.2em] text-white/45">{detail.label}</span>
                <span className="ml-2 font-mono uppercase">{detail.value}</span>
              </span>
            ))}
          </div>
        </div>

        <div className="rounded-[1.25rem] border border-white/12 bg-black/18 px-4 py-4 backdrop-blur-[2px]">
          <div className="text-[11px] uppercase tracking-[0.3em] text-white/45">Last sweep</div>
          <div className="mt-3 text-base font-medium leading-snug text-white/92">{time}</div>
          <div className="mt-3 border-t border-white/10 pt-3 text-xs leading-relaxed text-white/62">
            Latest worker evaluation stamped into this operator view.
          </div>
        </div>
      </div>
    </div>
  );
}

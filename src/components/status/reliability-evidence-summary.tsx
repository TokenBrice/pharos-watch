import { RELIABILITY_MODES, type ReliabilityEvidenceGap } from "@/lib/reliability-workspace-model";

export function ReliabilityEvidenceSummary({ gaps }: { gaps: ReliabilityEvidenceGap[] }) {
  if (gaps.length === 0) return null;

  return (
    <section
      aria-labelledby="reliability-evidence-title"
      className="border-y border-amber-500/30 bg-amber-500/[0.06] px-3 py-3 text-amber-950 dark:text-amber-100"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="reliability-evidence-title" className="text-sm font-semibold">
          Reliability evidence is incomplete
        </h3>
        <span className="text-xs opacity-80">
          {gaps.length} {gaps.length === 1 ? "source" : "sources"} unavailable across all views
        </span>
      </div>
      <ul className="mt-2 grid gap-x-5 gap-y-2 text-xs sm:grid-cols-2 xl:grid-cols-3">
        {gaps.map((gap) => (
          <li key={gap.rawCode} className="min-w-0 leading-relaxed">
            <span className="font-medium">{gap.label}</span>{" "}
            <span className="opacity-85">
              ({RELIABILITY_MODES.find((mode) => mode.id === gap.mode)?.label ?? gap.mode}): {gap.message}
            </span>
            <span className="mt-0.5 block break-all font-mono text-[10px] opacity-70">
              {gap.rawCode} · {gap.code}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

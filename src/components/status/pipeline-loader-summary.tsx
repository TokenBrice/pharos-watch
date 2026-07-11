import type { PipelineLoaderError } from "@/lib/pipeline-workspace-model";
import { PIPELINE_MODES } from "@/lib/pipeline-workspace-model";

export function PipelineLoaderSummary({ errors }: { errors: PipelineLoaderError[] }) {
  if (errors.length === 0) return null;

  return (
    <section
      aria-labelledby="pipeline-loader-summary-title"
      className="border-y border-amber-500/30 bg-amber-500/[0.06] px-3 py-3 text-amber-950 dark:text-amber-100"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="pipeline-loader-summary-title" className="text-sm font-semibold">
          Loader coverage is incomplete
        </h3>
        <span className="text-xs opacity-80">
          {errors.length} {errors.length === 1 ? "pipeline loader" : "pipeline loaders"} affected across all views
        </span>
      </div>
      <ul className="mt-2 grid gap-x-5 gap-y-2 text-xs sm:grid-cols-2 xl:grid-cols-3">
        {errors.map((error) => (
          <li key={`${error.rawKey}-${error.code}`} className="min-w-0 leading-relaxed">
            <span className="font-medium">{error.label}</span>{" "}
            <span className="opacity-85">
              ({PIPELINE_MODES.find((mode) => mode.id === error.mode)?.label ?? error.mode}): {error.message}
            </span>
            <span className="mt-0.5 block break-all font-mono text-[10px] opacity-70">
              {error.rawKey} · {error.code}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

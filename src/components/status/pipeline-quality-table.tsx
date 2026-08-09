import { TableBody, TableCaption, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { StatusPill } from "@/components/status/severity-pill";
import { PIPELINE_STATE_META } from "@/lib/pipeline-workspace-model";
import type { PipelineQualityModel } from "@/lib/pipeline-workspace-model";

export function PipelineQualityTable({ model }: { model: PipelineQualityModel }) {
  return (
    <div className="space-y-4">
      <section aria-labelledby="quality-threshold-title" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 id="quality-threshold-title" className="text-base font-semibold text-foreground">
              Quality thresholds
            </h3>
            <p id="quality-threshold-description" className="mt-1 max-w-4xl text-xs leading-relaxed text-muted-foreground">
              Each row names its own eligible population because cache, blacklist, and on-chain ratios use different
              denominators. Missing populations and inactive confidence gates remain Unknown even when raw counters are
              zero.
            </p>
          </div>
        </div>

        <TableFrame
          tableId="pipeline-quality-thresholds"
          testId="pipeline-quality-thresholds"
          chrome="content"
          density="compact"
          tableProps={{
            "aria-label": "Pipeline quality thresholds",
            "aria-describedby": "quality-threshold-description",
          }}
        >
          <TableCaption className="sr-only">
            Current pipeline quality metrics, their eligible populations, warning and stale thresholds, state, and
            available trend context.
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Metric</TableHead>
              <TableHead scope="col">Current</TableHead>
              <TableHead scope="col">Eligible population</TableHead>
              <TableHead scope="col">Warning</TableHead>
              <TableHead scope="col">Stale</TableHead>
              <TableHead scope="col">State</TableHead>
              <TableHead scope="col">Last change / trend</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {model.rows.map((row) => {
              const state = PIPELINE_STATE_META[row.state];
              return (
                <TableRow key={row.id}>
                  <TableCell className="min-w-48 align-top">
                    <div className="font-medium text-foreground">{row.label}</div>
                    <code className="mt-0.5 block text-[10px] text-muted-foreground">{row.rawCode}</code>
                  </TableCell>
                  <TableCell className="whitespace-nowrap align-top font-mono text-xs tabular-nums">
                    {row.currentValue}
                  </TableCell>
                  <TableCell className="min-w-56 align-top text-xs text-muted-foreground">
                    {row.eligiblePopulation}
                  </TableCell>
                  <TableCell className="whitespace-nowrap align-top font-mono text-xs">{row.warningThreshold}</TableCell>
                  <TableCell className="whitespace-nowrap align-top font-mono text-xs">{row.staleThreshold}</TableCell>
                  <TableCell className="min-w-40 align-top">
                    <StatusPill className={state.className}>{state.label}</StatusPill>
                    <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{row.stateDetail}</div>
                  </TableCell>
                  <TableCell className="min-w-48 align-top text-xs text-muted-foreground">{row.trend}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </TableFrame>
      </section>

      <aside className="border-l-2 border-sky-500 bg-sky-500/[0.06] px-3 py-2.5" aria-label="Active depegs">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <span className="text-sm font-medium text-foreground">Active depegs</span>
            <code className="ml-2 text-[10px] text-muted-foreground">{model.activeDepegs.rawCode}</code>
          </div>
          <span className="font-mono text-sm tabular-nums text-foreground">{model.activeDepegs.currentValue}</span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{model.activeDepegs.detail}</p>
      </aside>
    </div>
  );
}

import { TableBody, TableCaption, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { StatusPill } from "@/components/status/severity-pill";
import { PIPELINE_STATE_META } from "@/lib/pipeline-workspace-model";
import type { PipelineIntegrityModel, PipelineIntegrityRow } from "@/lib/pipeline-workspace-model";

function IntegrityTable({ caption, label, rows }: { caption: string; label: string; rows: PipelineIntegrityRow[] }) {
  return (
    <section aria-label={label} className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground">{label}</h3>
      <TableFrame
        tableId={`pipeline-integrity-${label.toLowerCase().replaceAll(" ", "-")}`}
        chrome="content"
        density="compact"
        viewportClassName="max-w-full"
        viewportProps={{ style: { contain: "paint" } }}
        tableProps={{ "aria-label": label }}
      >
        <TableCaption className="sr-only">{caption}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Signal</TableHead>
            <TableHead scope="col">Current</TableHead>
            <TableHead scope="col">State</TableHead>
            <TableHead scope="col">Evidence</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const state = PIPELINE_STATE_META[row.state];
            return (
              <TableRow key={row.id}>
                <TableCell className="min-w-52 align-top">
                  <div className="font-medium text-foreground">{row.label}</div>
                  <code className="mt-0.5 block break-all text-[10px] text-muted-foreground">{row.rawCode}</code>
                </TableCell>
                <TableCell className="whitespace-nowrap align-top font-mono text-xs tabular-nums">
                  {row.currentValue}
                </TableCell>
                <TableCell className="align-top">
                  <StatusPill className={state.className}>{state.label}</StatusPill>
                </TableCell>
                <TableCell className="min-w-72 align-top text-xs leading-relaxed text-muted-foreground">
                  {row.detail}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </TableFrame>
    </section>
  );
}

export function PipelineIntegrityPanel({ model }: { model: PipelineIntegrityModel }) {
  return (
    <div className="space-y-5">
      <div className="max-w-4xl">
        <h3 className="text-base font-semibold text-foreground">Publication and dependency integrity</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Follows produced data from publication ledgers through dependency consumers. Human-readable labels lead;
          machine identifiers and failure codes remain visible in each evidence row.
        </p>
      </div>
      <IntegrityTable
        label="Pipeline controls"
        caption="Stablecoin publication coverage and outstanding repair debt."
        rows={model.controlRows}
      />
      <IntegrityTable
        label="Publication surfaces"
        caption="Latest publication state for each reported pipeline surface."
        rows={model.publicationRows}
      />
      <IntegrityTable
        label="Dependencies"
        caption="Health of pipeline dependencies and their consuming surfaces."
        rows={model.dependencyRows}
      />
    </div>
  );
}

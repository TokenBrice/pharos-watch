import type { ReactNode } from "react";
import {
  formatMethodologyDisplayDate,
  toMethodologyVersionLabel,
} from "@shared/lib/methodology-versions/base";
import type { MethodologyChangelogDetailBlock, MethodologyChangelogEntry, MethodologyChangelogRichText } from "@shared/types/editorial-content";
import { slugifyId } from "@shared/lib/format";
import { DisclosurePanel } from "@/components/disclosure-panel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ContentTable } from "@/components/table";

export function scoringAnchorId(version: string) {
  return `scoring-${slugifyId(version)}`;
}

function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-block rounded-full border border-border/60 bg-muted/55 px-2.5 py-0.5 text-xs pharos-numeric font-medium text-foreground">
      {children}
    </span>
  );
}

export const changelogTableClassNames = {
  head: "h-auto whitespace-normal px-0 py-2 pr-4 text-left font-medium text-foreground last:pr-0",
  cell: "whitespace-normal px-0 py-2 pr-4 align-top last:pr-0",
  rowHeader: "whitespace-normal px-0 py-2 pr-4 align-top font-medium text-foreground last:pr-0",
  numericHead: "h-auto whitespace-normal px-0 py-2 pr-4 text-right font-medium text-foreground last:pr-0",
  numericCell: "pharos-numeric whitespace-normal px-0 py-2 pr-4 text-right align-top last:pr-0",
};

function ChangelogRichText({ text }: { text: MethodologyChangelogRichText }) {
  const segments = typeof text === "string" ? [text] : text;
  return (
    <>
      {segments.map((segment, index) => {
        if (typeof segment === "string") return segment;
        if ("code" in segment) {
          return (
            <code key={index} className="rounded-sm bg-muted/70 px-1 py-0.5 font-mono text-xs text-foreground">
              {segment.code}
            </code>
          );
        }
        if ("emphasis" in segment) {
          return (
            <span key={index} className="text-foreground font-medium">
              {segment.emphasis}
            </span>
          );
        }
        return (
          <span key={index} className="pharos-numeric">
            {segment.numeric}
          </span>
        );
      })}
    </>
  );
}

function ChangelogDetailBlocks({ blocks }: { blocks: readonly MethodologyChangelogDetailBlock[] }) {
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "paragraph":
            return (
              <p key={index}>
                <ChangelogRichText text={block.text} />
              </p>
            );
          case "list":
            return (
              <ul key={index} className="list-disc list-inside space-y-1">
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>
                    <ChangelogRichText text={item} />
                  </li>
                ))}
              </ul>
            );
          case "formula":
            return (
              <div
                key={index}
                className="overflow-x-auto rounded-lg border border-border/60 bg-muted/40 px-4 py-3 text-xs leading-relaxed text-foreground pharos-numeric"
              >
                {block.text}
              </div>
            );
          case "weights":
            return <WeightRow key={index} values={block.values} />;
          case "table":
            return (
              <ContentTable
                key={index}
                id={block.tableId}
                chrome="embedded"
                tableProps={block.ariaLabel ? { "aria-label": block.ariaLabel } : undefined}
                tableId={block.tableId}
                testId={block.testId}
                columns={block.columns.map(({ label, headClassName, cellClassName, ...column }) => ({
                  ...column,
                  header: label,
                  headerClassName: headClassName ?? changelogTableClassNames.head,
                  cellClassName:
                    cellClassName ??
                    (column.rowHeader ? changelogTableClassNames.rowHeader : changelogTableClassNames.cell),
                }))}
                rows={block.rows}
              />
            );
          case "section":
            return (
              <div key={index} className="space-y-2">
                <h3 className="text-foreground font-medium">{block.heading}</h3>
                <ChangelogDetailBlocks blocks={block.blocks} />
              </div>
            );
        }
      })}
    </>
  );
}

/**
 * Renders a changelog entry straight from its structured
 * `shared/data/methodology-changelogs/` record: the ordered `detail` body when
 * the published card carries headings, tables or formulas, and `summary` plus
 * `impact` otherwise.
 */
export function StructuredChangelogDetail({ entry }: { entry: MethodologyChangelogEntry }) {
  return (
    <div className="space-y-4 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:tracking-tight [&_h3]:text-foreground">
      {entry.detail ? (
        <ChangelogDetailBlocks blocks={entry.detail} />
      ) : (
        <>
          <p>{entry.summary}</p>
          <ul className="list-disc list-inside space-y-1">
            {entry.impact.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function VersionCard({
  entry,
  children,
  versionLabel = toMethodologyVersionLabel(entry.version),
}: {
  entry: MethodologyChangelogEntry;
  children: ReactNode;
  versionLabel?: string;
}) {
  const anchorId = scoringAnchorId(versionLabel);
  const dateLabel = formatMethodologyDisplayDate(entry.date);

  return (
    <Card id={anchorId} variant="shell" className="scroll-mt-36">
      <CardHeader className="space-y-2.5 border-b border-border/50 pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <Pill>{versionLabel}</Pill>
          <Pill>{dateLabel}</Pill>
          {entry.reconstructed && <Pill>Reconstructed</Pill>}
        </div>
        <CardTitle as="h2" className="pharos-section-title">
          {entry.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm leading-relaxed text-muted-foreground">
        {children}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5 border-t border-border/50 pt-3 text-xs text-muted-foreground">
          <span>
            {entry.reconstructed
              ? "Reconstructed from git commit history."
              : "Contemporaneous release record."}
          </span>
          {entry.commits.length === 0 ? (
            <span>Commit provenance not recorded</span>
          ) : entry.commits.length <= 4 ? (
            <span className="break-words">
              Commits: <span className="pharos-numeric text-foreground/85">{entry.commits.join(", ")}</span>
            </span>
          ) : (
            <DisclosurePanel
              variant="plain"
              chevronPosition="end"
              summary={
                <span className="pharos-numeric">
                  {entry.commits.length} commits
                </span>
              }
            >
              <p className="break-words pharos-numeric text-xs text-foreground/85">
                {entry.commits.join(", ")}
              </p>
            </DisclosurePanel>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function WeightRow({ values }: { values: readonly [string, string, string, string, string, string] }) {
  const headers = ["Peg", "Liquidity", "Safety", "Resilience", "Decentralization", "Dep Risk"];
  return (
    <ContentTable
      chrome="embedded"
      columns={headers.map((header) => ({
        id: header,
        header,
        headerClassName: changelogTableClassNames.numericHead,
        cellClassName: changelogTableClassNames.numericCell,
      }))}
      rows={[{ id: "weights", cells: Object.fromEntries(headers.map((header, index) => [header, values[index]])) }]}
    />
  );
}

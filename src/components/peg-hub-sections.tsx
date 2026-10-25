import Link from "next/link";
import { ContentTable, type ContentTableColumn, type ContentTableRow } from "@/components/table/content-table";
import type { FormerPegCoinEntry, PegAtAGlanceRow, UpcomingPegCoinEntry } from "@/lib/peg-hub-content";

/**
 * Static, registry-only sections of a `/stablecoins/<peg>/` hub. Server
 * components: every row is in the prerendered HTML and none carries a live
 * figure, so crawlers and no-JS readers get the same facts as hydrated readers.
 */

const LINK_CLASS = "pharos-focus-ring rounded-sm font-medium text-foreground underline-offset-2 hover:underline";

function SectionHeading({ id, title, description }: { id: string; title: string; description: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h2 id={id} className="pharos-label">{title}</h2>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

export function PegAtAGlanceSection({
  shortLabel,
  rows,
  total,
  showMica,
}: {
  shortLabel: string;
  rows: readonly PegAtAGlanceRow[];
  total: number;
  showMica: boolean;
}) {
  if (rows.length === 0) return null;
  const columns: ContentTableColumn[] = [
    { id: "coin", header: "Stablecoin", rowHeader: true },
    { id: "backing", header: "Backing" },
    { id: "governance", header: "Governance" },
    { id: "freeze", header: "Freeze capability" },
    { id: "launch", header: "Launched" },
    { id: "chains", header: "Chains" },
    ...(showMica ? [{ id: "mica", header: "MiCA status" }] : []),
  ];
  const tableRows: ContentTableRow[] = rows.map((row) => ({
    id: row.id,
    cells: {
      coin: (
        <Link href={row.href} className={LINK_CLASS}>
          {row.name} ({row.symbol})
        </Link>
      ),
      backing: row.backing,
      governance: row.governance,
      freeze: row.freeze,
      launch: row.launchYear,
      chains: row.chains,
      ...(showMica ? { mica: row.mica ?? "Not reviewed" } : {}),
    },
  }));
  const bound = rows.length < total ? `the first ${rows.length} of ${total}` : `all ${total}`;

  return (
    <section aria-labelledby="peg-at-a-glance" className="space-y-3">
      <SectionHeading
        id="peg-at-a-glance"
        title={`${shortLabel} stablecoins at a glance`}
        description={`Registry facts for ${bound} tracked ${shortLabel} stablecoins, in registry order. These are design facts, not live data; the live table above carries market and risk figures.`}
      />
      <ContentTable
        tableProps={{ "aria-labelledby": "peg-at-a-glance" }}
        viewportProps={{ mobileScrollHint: "Swipe sideways for more columns" }}
        columns={columns}
        rows={tableRows}
      />
    </section>
  );
}

export function UpcomingPegCoinsSection({
  shortLabel,
  entries,
}: {
  shortLabel: string;
  entries: readonly UpcomingPegCoinEntry[];
}) {
  if (entries.length === 0) return null;
  return (
    <section aria-labelledby="peg-upcoming" className="space-y-3">
      <SectionHeading
        id="peg-upcoming"
        title={`Upcoming ${shortLabel} stablecoins`}
        description={
          <>
            Announced coins Pharos tracks before launch, with each issuer&apos;s launch phase and current target. See
            every launch on{" "}
            <Link href="/upcoming/" className={LINK_CLASS}>
              Upcoming stablecoins
            </Link>
            .
          </>
        }
      />
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map((entry) => (
          <li key={entry.id} className="rounded-xl border border-border/60 bg-background/60 px-3 py-3 text-sm">
            <Link href={entry.href} className={LINK_CLASS}>
              {entry.name} ({entry.symbol})
            </Link>
            <span className="mt-1 block text-xs text-muted-foreground">{entry.status}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const FORMER_PREVIEW_COUNT = 24;

function FormerCoinChips({ entries }: { entries: readonly FormerPegCoinEntry[] }) {
  return (
    <ul className="flex flex-wrap gap-2">
      {entries.map((entry) => (
        <li key={entry.id}>
          <Link
            href={entry.href}
            className="pharos-focus-ring inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent"
          >
            {entry.name} ({entry.symbol})
            <span className="font-normal text-muted-foreground">{entry.note}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function FormerPegCoinsSection({
  shortLabel,
  entries,
}: {
  shortLabel: string;
  entries: readonly FormerPegCoinEntry[];
}) {
  if (entries.length === 0) return null;
  return (
    <section aria-labelledby="peg-former" className="space-y-3">
      <SectionHeading
        id="peg-former"
        title={`Former ${shortLabel} stablecoins`}
        description={
          <>
            Frozen profiles and{" "}
            <Link href="/cemetery/" className={LINK_CLASS}>
              cemetery
            </Link>{" "}
            records for this peg, newest first.
          </>
        }
      />
      <FormerCoinChips entries={entries.slice(0, FORMER_PREVIEW_COUNT)} />
      {entries.length > FORMER_PREVIEW_COUNT ? (
        <details className="rounded-lg border border-border/60 bg-muted/20">
          <summary className="pharos-focus-ring cursor-pointer px-4 py-3 text-sm font-medium">
            Show the remaining {entries.length - FORMER_PREVIEW_COUNT} former {shortLabel} stablecoins
          </summary>
          <div className="px-4 pb-4">
            <FormerCoinChips entries={entries.slice(FORMER_PREVIEW_COUNT)} />
          </div>
        </details>
      ) : null}
    </section>
  );
}

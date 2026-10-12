import Link from "next/link";
import { BreadcrumbJsonLd, type BreadcrumbItem } from "@/components/breadcrumb-json-ld";
import { cn } from "@/lib/utils";

export interface FeaturePageShellProps {
  breadcrumbName: string;
  path: string;
  breadcrumbItems?: BreadcrumbItem[];
  title: string;
  variant?: "standard" | "longform" | "auth-gated";
  containerClassName?: string;
  methodology?: {
    version: string;
    changelogPath: string;
  };
  headerActions?: React.ReactNode;
  leadParagraphs?: readonly React.ReactNode[];
  /** Let lead paragraphs span the container instead of the prose-width cap. */
  leadFullWidth?: boolean;
  headerSupplement?: React.ReactNode;
  preface?: React.ReactNode;
  /**
   * `instrument`: the rail-page header grammar — H1, a one-line 16px deck, then
   * one compact meta row (methodology version + history on the left, header
   * actions on the right). Lead paragraphs after the first fold into a
   * disclosure so the hero KPI stays above the mobile fold.
   */
  header?: "standard" | "instrument";
  /** Summary label for the instrument header's folded lead paragraphs. */
  leadDisclosureLabel?: string;
  children: React.ReactNode;
}

export function FeaturePageShell({
  breadcrumbName,
  path,
  breadcrumbItems,
  title,
  variant = "standard",
  containerClassName,
  methodology,
  headerActions,
  leadParagraphs = [],
  leadFullWidth = false,
  headerSupplement,
  preface,
  header = "standard",
  leadDisclosureLabel = "How to read this page",
  children,
}: FeaturePageShellProps) {
  const variantClassName =
    variant === "longform"
      ? "mx-auto w-full max-w-3xl space-y-6"
      : variant === "auth-gated"
        ? "mx-auto w-full max-w-5xl space-y-6"
        : "space-y-6";

  return (
    <div className={cn(variantClassName, containerClassName)}>
      <BreadcrumbJsonLd
        items={
          breadcrumbItems ?? [
            { name: "Home", url: "/" },
            { name: breadcrumbName, url: path },
          ]
        }
      />
      {preface}
      {header === "instrument" ? (
        <InstrumentHeader
          title={title}
          methodology={methodology}
          headerActions={headerActions}
          leadParagraphs={leadParagraphs}
          leadDisclosureLabel={leadDisclosureLabel}
          headerSupplement={headerSupplement}
        />
      ) : (
        <div className="space-y-2.5">
          <div className="flex max-w-full flex-wrap items-start justify-between gap-x-3 gap-y-3">
            <div className="flex min-w-0 max-w-4xl flex-wrap items-center gap-x-3 gap-y-2">
              <h1 className="pharos-page-title">{title}</h1>
            </div>
            {headerActions}
          </div>
          {methodology && (
            <p className="pharos-meta">
              Methodology {methodology.version}.{" "}
              <Link
                href={methodology.changelogPath}
                className="pharos-focus-ring rounded-sm underline underline-offset-4 hover:text-foreground"
              >
                Version history &rarr;
              </Link>
            </p>
          )}
          {leadParagraphs.length > 0 ? (
            <div className={leadFullWidth ? "space-y-2" : "max-w-4xl space-y-2"}>
              {leadParagraphs.map((paragraph, index) => (
                <p key={index} className={index === 0 ? "pharos-page-deck" : "pharos-lead"}>
                  {paragraph}
                </p>
              ))}
            </div>
          ) : null}
          {headerSupplement}
        </div>
      )}
      {children}
    </div>
  );
}

function InstrumentHeader({
  title,
  methodology,
  headerActions,
  leadParagraphs,
  leadDisclosureLabel,
  headerSupplement,
}: Pick<FeaturePageShellProps, "title" | "methodology" | "headerActions" | "headerSupplement"> & {
  leadParagraphs: readonly React.ReactNode[];
  leadDisclosureLabel: string;
}) {
  const [deck, ...more] = leadParagraphs;
  return (
    <header className="space-y-2">
      <h1 className="pharos-page-title text-balance">{title}</h1>
      {deck ? <p className="pharos-page-deck max-w-3xl">{deck}</p> : null}
      {methodology || headerActions ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          {methodology ? (
            <p className="pharos-meta">
              Methodology {methodology.version} &middot;{" "}
              <Link
                href={methodology.changelogPath}
                className="pharos-focus-ring rounded-sm underline underline-offset-4 hover:text-foreground"
              >
                Version history &rarr;
              </Link>
            </p>
          ) : (
            <span />
          )}
          {headerActions ? <div className="flex flex-wrap items-center gap-2">{headerActions}</div> : null}
        </div>
      ) : null}
      {more.length > 0 ? (
        <details className="group max-w-4xl">
          <summary className="pharos-focus-ring w-fit cursor-pointer rounded-sm text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            {leadDisclosureLabel}
          </summary>
          <div className="mt-2 space-y-2">
            {more.map((paragraph, index) => (
              <p key={index} className="pharos-lead">
                {paragraph}
              </p>
            ))}
          </div>
        </details>
      ) : null}
      {headerSupplement}
    </header>
  );
}

"use client";

import { useMemo, useState } from "react";
import {
  type CitationInput,
  formatAPA7,
  formatBibTeX,
  formatChicago,
  formatPlain,
} from "@shared/lib/citation/formats";
import { formatPharosUrn, type PharosUrnEntityClass } from "@shared/lib/citation/urn";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { CopyButton } from "@/components/copy-button";
import sitemapDates from "@/generated/sitemap-dates.json";
import { cn } from "@/lib/utils";

const FORMAT_TABS = [
  { value: "bibtex", label: "BibTeX" },
  { value: "apa", label: "APA 7" },
  { value: "chicago", label: "Chicago" },
  { value: "plain", label: "URL + URN" },
] as const;

type FormatTab = (typeof FORMAT_TABS)[number]["value"];

export interface CitationBlockProps {
  /** URN entity class for this surface. */
  entityClass: PharosUrnEntityClass;
  /** Canonical id for the entity (e.g. `usdc-circle`, `dews`). */
  id: string;
  /** Optional URN qualifier (version or date). */
  qualifier?: string;
  /** Title rendered into the citation. */
  title: string;
  /** Canonical URL. */
  url: string;
  /** Methodology / changelog version for the citation body. */
  version?: string;
  /**
   * Override for the accessed date. Defaults to the build's
   * sitemap-dates manifest entry for this URL's path (falling back to today).
   */
  accessedDate?: string;
  /** Optional class for the wrapper card. */
  className?: string;
}

const ISO_DATE_REGEX = /^(\d{4}-\d{2}-\d{2})/;

function urlToPath(url: string): string {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    return pathname.endsWith("/") ? pathname : `${pathname}/`;
  } catch {
    return url;
  }
}

function resolveAccessedDate(url: string, override?: string): string {
  if (override && ISO_DATE_REGEX.test(override)) {
    return override.slice(0, 10);
  }
  const path = urlToPath(url);
  const dates = sitemapDates as Record<string, string>;
  const stamp = dates[path];
  if (stamp) {
    const match = stamp.match(ISO_DATE_REGEX);
    if (match) return match[1];
  }
  return new Date().toISOString().slice(0, 10);
}

export function CitationBlock(props: CitationBlockProps) {
  const [activeTab, setActiveTab] = useState<FormatTab>("bibtex");

  const accessedDate = useMemo(
    () => resolveAccessedDate(props.url, props.accessedDate),
    [props.url, props.accessedDate],
  );

  const urn = useMemo(
    () => formatPharosUrn(props.entityClass, props.id, props.qualifier),
    [props.entityClass, props.id, props.qualifier],
  );

  const citation: CitationInput = useMemo(
    () => ({
      title: props.title,
      url: props.url,
      urn,
      version: props.version,
      accessedDate,
    }),
    [props.title, props.url, urn, props.version, accessedDate],
  );

  const renders = useMemo(
    () => ({
      bibtex: formatBibTeX(citation),
      apa: formatAPA7(citation),
      chicago: formatChicago(citation),
      plain: formatPlain(citation),
    }),
    [citation],
  );

  const activeText = renders[activeTab];

  return (
    <Card className={cn("border-border/60 bg-card/60", props.className)} data-slot="citation-block">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="text-sm font-semibold text-foreground">Cite this page</p>
            <p className="text-xs text-muted-foreground">
              Accessed {accessedDate}. <code className="font-mono text-[11px]">{urn}</code>
            </p>
          </div>
          <ToggleGroup
            type="single"
            value={activeTab}
            onValueChange={(value) => {
              if (!value) return;
              setActiveTab(value as FormatTab);
            }}
            variant="outline"
            size="sm"
            aria-label="Citation format"
          >
            {FORMAT_TABS.map((tab) => (
              <ToggleGroupItem
                key={tab.value}
                value={tab.value}
                className="text-xs data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
              >
                {tab.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </CardHeader>
      <CardContent>
        <div className="relative">
          <pre
            className="overflow-x-auto rounded-md border border-border/40 bg-muted/30 px-3 py-3 pr-12 text-xs leading-relaxed text-foreground/90 whitespace-pre-wrap break-words"
            data-format={activeTab}
          >
            {activeText}
          </pre>
          <div className="absolute right-2 top-2">
            <CopyButton text={activeText} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

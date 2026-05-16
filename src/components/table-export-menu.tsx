"use client";

import { useCallback, useState } from "react";
import { Check, ClipboardCopy, Download, FileJson } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { CsvColumn } from "@/lib/exports/csv";
import { downloadCsvWithPreamble } from "@/lib/exports/csv";
import { downloadNdjsonWithPreamble } from "@/lib/exports/ndjson";
import { copyMarkdownWithPreamble } from "@/lib/exports/markdown";
import type { ExportPreamble } from "@/lib/exports/preamble";

type Status = "idle" | "copied" | "error";

export interface TableExportMenuProps<T> {
  /** Rows to export. */
  data: T[];
  /** Column descriptors. Each provides a header and an accessor. */
  columns: CsvColumn<T>[];
  /** Short stem for the downloaded filename (date is appended automatically). */
  filename: string;
  /** Short endpoint label written into the preamble, e.g. "stablecoins". */
  endpoint: string;
  /** Methodology label written into the preamble, e.g. "safety-score v7.25". */
  methodologyLabel: string;
  /** Optional trigger label override; defaults to "Export". */
  triggerLabel?: string;
  /** Optional class override for the trigger button. */
  triggerClassName?: string;
}

function buildPreamble(endpoint: string, methodologyLabel: string): ExportPreamble {
  return {
    endpoint,
    asOfISO: new Date().toISOString(),
    sourceUrl: typeof window === "undefined" ? "" : window.location.href,
    methodologyLabel,
  };
}

export function TableExportMenu<T>({
  data,
  columns,
  filename,
  endpoint,
  methodologyLabel,
  triggerLabel = "Export",
  triggerClassName,
}: TableExportMenuProps<T>): React.ReactElement {
  const [status, setStatus] = useState<Status>("idle");

  const resetStatusAfterDelay = useCallback(() => {
    setTimeout(() => setStatus("idle"), 2000);
  }, []);

  const handleCsv = useCallback(() => {
    downloadCsvWithPreamble(data, columns, filename, buildPreamble(endpoint, methodologyLabel));
  }, [columns, data, endpoint, filename, methodologyLabel]);

  const handleNdjson = useCallback(() => {
    downloadNdjsonWithPreamble(data, columns, filename, buildPreamble(endpoint, methodologyLabel));
  }, [columns, data, endpoint, filename, methodologyLabel]);

  const handleMarkdown = useCallback(async () => {
    const ok = await copyMarkdownWithPreamble(
      data,
      columns,
      buildPreamble(endpoint, methodologyLabel),
    );
    setStatus(ok ? "copied" : "error");
    resetStatusAfterDelay();
  }, [columns, data, endpoint, methodologyLabel, resetStatusAfterDelay]);

  const triggerText =
    status === "copied" ? "Copied!" : status === "error" ? "Copy failed" : triggerLabel;
  const TriggerIcon = status === "copied" ? Check : Download;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={triggerClassName}
          aria-label={`Export table as CSV, NDJSON, or Markdown`}
        >
          <TriggerIcon />
          <span>{triggerText}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={handleCsv}>
          <Download />
          Download CSV
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleNdjson}>
          <FileJson />
          Download NDJSON
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleMarkdown}>
          <ClipboardCopy />
          Copy as Markdown
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

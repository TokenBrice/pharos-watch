"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, ExternalLink } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FilterSearchInput } from "@/components/filter-search-input";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { useLogos } from "@/hooks/use-logos";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { trackEvent, trackSearch } from "@/lib/analytics";
import { buildStablecoinUrl } from "@/lib/urls";
import { PEG_FILTER_OPTIONS, PEG_METADATA } from "@shared/lib/classification";
import {
  MICA_AUTHORIZATION_TYPE_LABELS,
  MICA_STATUS_BADGE_STYLES,
  MICA_STATUS_DESCRIPTIONS,
  MICA_TOKEN_TYPE_BADGE_STYLES,
  MICA_TOKEN_TYPE_LABELS,
} from "@shared/lib/mica";
import type { MicaStatus, MicaTokenType, PegCurrency } from "@shared/types";
import {
  MICA_STATUS_FILTER_OPTIONS,
  MICA_TOKEN_TYPE_FILTER_OPTIONS,
  buildMicaViewModel,
  normalizeMicaStatusFilter,
  normalizeMicaTokenTypeFilter,
  type MicaRow,
} from "./model";

function normalizePegFilter(value: string): PegCurrency | "all" {
  return value === "all" || value in PEG_METADATA ? (value as PegCurrency | "all") : "all";
}

export function MicaClient() {
  const { data: logos } = useLogos();
  const { getParam, setParam } = useUrlFilters();

  const statusFilter = normalizeMicaStatusFilter(getParam("status", "all"));
  const tokenTypeFilter = normalizeMicaTokenTypeFilter(getParam("type", getParam("tokenType", "all")));
  const pegFilter = normalizePegFilter(getParam("peg", getParam("pegCurrency", "all")));

  const setStatusFilter = useCallback(
    (v: MicaStatus | "all") => {
      trackEvent("filter_applied", { page: "mica", filter_type: "status", filter_value: v });
      setParam("status", v);
    },
    [setParam],
  );
  const setTokenTypeFilter = useCallback(
    (v: MicaTokenType | "all") => {
      trackEvent("filter_applied", { page: "mica", filter_type: "type", filter_value: v });
      setParam("type", v);
    },
    [setParam],
  );
  const setPegFilter = useCallback(
    (v: PegCurrency | "all") => {
      trackEvent("filter_applied", { page: "mica", filter_type: "peg", filter_value: v });
      setParam("peg", v);
    },
    [setParam],
  );

  // Search: local state for instant input, deferred for filtering, debounced URL sync.
  const [searchInput, setSearchInput] = useState(() => getParam("q"));
  const deferredSearch = useDeferredValue(searchInput);
  const urlSyncTimer = useRef<ReturnType<typeof setTimeout>>(null);
  useEffect(() => {
    if (urlSyncTimer.current) clearTimeout(urlSyncTimer.current);
    urlSyncTimer.current = setTimeout(() => {
      setParam("q", deferredSearch);
      if (deferredSearch) trackSearch("mica", deferredSearch.length);
    }, 300);
    return () => {
      if (urlSyncTimer.current) clearTimeout(urlSyncTimer.current);
    };
  }, [deferredSearch, setParam]);

  const { rows, totalTracked } = useMemo(
    () =>
      buildMicaViewModel({
        status: statusFilter,
        tokenType: tokenTypeFilter,
        peg: pegFilter,
        search: deferredSearch,
      }),
    [statusFilter, tokenTypeFilter, pegFilter, deferredSearch],
  );

  return (
    <div className="space-y-6">
      <section id="data" aria-label="Data table" tabIndex={-1} className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="pharos-kicker">
            {rows.length === totalTracked
              ? `${totalTracked.toLocaleString()} assessed stablecoins`
              : `${rows.length.toLocaleString()}/${totalTracked.toLocaleString()} matching`}
          </h2>
          <div className="flex flex-wrap items-center gap-3">
            <ToggleGroup
              type="single"
              value={statusFilter}
              onValueChange={(v) => v && setStatusFilter(v as MicaStatus | "all")}
              className="flex flex-wrap gap-1"
              aria-label="Filter by MiCA status"
            >
              {MICA_STATUS_FILTER_OPTIONS.map((f) => (
                <ToggleGroupItem
                  key={f.value}
                  value={f.value}
                  variant="outline"
                  size="sm"
                  className="text-xs min-h-[44px] md:min-h-0"
                >
                  {f.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <ToggleGroup
              type="single"
              value={tokenTypeFilter}
              onValueChange={(v) => v && setTokenTypeFilter(v as MicaTokenType | "all")}
              className="flex gap-1"
              aria-label="Filter by token type"
            >
              {MICA_TOKEN_TYPE_FILTER_OPTIONS.map((f) => (
                <ToggleGroupItem
                  key={f.value}
                  value={f.value}
                  variant="outline"
                  size="sm"
                  className="text-xs min-h-[44px] md:min-h-0"
                >
                  {f.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <ToggleGroup
              type="single"
              value={pegFilter}
              onValueChange={(v) => v && setPegFilter(v as PegCurrency | "all")}
              className="flex gap-1"
              aria-label="Filter by peg currency"
            >
              {PEG_FILTER_OPTIONS.map((f) => (
                <ToggleGroupItem
                  key={f.value}
                  value={f.value}
                  variant="outline"
                  size="sm"
                  className="text-xs min-h-[44px] md:min-h-0"
                >
                  {f.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <FilterSearchInput
              value={searchInput}
              onValueChange={setSearchInput}
              placeholder="Search..."
              className="relative w-full sm:w-44"
              inputClassName="pl-8 h-11 md:h-8 text-xs"
              ariaLabel="Search stablecoins by name or symbol"
            />
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="rounded-2xl border border-border/60 bg-card/40 px-4 py-10 text-center text-sm text-muted-foreground">
            No stablecoins match these filters.
          </div>
        ) : (
          <div className="rounded-2xl border border-border/60 bg-card/40">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Coin</TableHead>
                  <TableHead>MiCA Status</TableHead>
                  <TableHead>Token Type</TableHead>
                  <TableHead>Competent Authority</TableHead>
                  <TableHead>Authorized Entity</TableHead>
                  <TableHead className="text-center">Significant</TableHead>
                  <TableHead className="text-right">Sources</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <MicaTableRow key={row.id} row={row} logo={logos?.[row.id]} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}

function MicaTableRow({ row, logo }: { row: MicaRow; logo: string | undefined }) {
  const status = MICA_STATUS_BADGE_STYLES[row.status];
  const tokenType = row.tokenType ? MICA_TOKEN_TYPE_BADGE_STYLES[row.tokenType] : null;

  return (
    <TableRow>
      <TableCell>
        <Link
          href={buildStablecoinUrl(row.id)}
          className="pharos-focus-ring inline-flex min-w-0 items-center gap-2 rounded-sm hover:text-foreground"
        >
          <StablecoinLogo src={logo} name={row.name} size={28} />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{row.symbol}</span>
            <span className="block truncate text-xs text-muted-foreground">{row.name}</span>
          </span>
        </Link>
      </TableCell>
      <TableCell>
        <span
          title={MICA_STATUS_DESCRIPTIONS[row.status]}
          className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${status.cls}`}
        >
          {status.label}
        </span>
      </TableCell>
      <TableCell>
        {tokenType ? (
          <span
            title={MICA_TOKEN_TYPE_LABELS[row.tokenType!]}
            className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${tokenType.cls}`}
          >
            {tokenType.label}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        {row.competentAuthority ? (
          <span className="text-sm">
            {row.competentAuthority}
            {row.authorizationType ? (
              <span className="block text-xs text-muted-foreground">
                {MICA_AUTHORIZATION_TYPE_LABELS[row.authorizationType]}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        {row.authorizedEntity ? (
          <span className="text-sm">{row.authorizedEntity}</span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-center">
        {row.significant ? (
          <span
            title="EBA-supervised significant EMT/ART"
            className="inline-flex items-center gap-1 rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-xs font-semibold text-blue-700 dark:text-blue-400"
          >
            <Check className="h-3 w-3" aria-hidden="true" />
            Significant
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        {row.references.length > 0 ? (
          <div className="flex flex-wrap justify-end gap-2">
            {row.references.map((reference) => (
              <a
                key={`${reference.label}:${reference.url}`}
                href={reference.url}
                target="_blank"
                rel="noopener noreferrer"
                className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm text-xs text-frost-blue hover:underline"
              >
                {reference.label}
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            ))}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}

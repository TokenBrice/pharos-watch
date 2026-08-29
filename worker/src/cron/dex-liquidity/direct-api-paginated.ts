import { USER_AGENT } from "../../lib/constants";
import { cancelUnsuccessfulResponseBodyQuietly } from "../../lib/response-body";
import { readDexApiJson } from "./direct-api-json";
import {
  DIRECT_API_DEFAULT_MAX_PAGES,
  DIRECT_API_REQUEST_TIMEOUT_MS,
  buildDirectApiRequestSignal,
} from "./direct-api-policy";
import { toErrorMessage } from "@shared/lib/error-utils";
import { rethrowIfAborted } from "../../lib/abort";

export interface PaginatedFetchOptions<TRow> {
  source: string;
  buildUrl: (page: number) => string;
  pageSize: number;
  startPage?: number;
  maxPages?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  parsePage: (body: unknown, page: number) => unknown[] | { rows: unknown[] } | { error: string } | null;
  mapRow: (raw: unknown, context: { page: number }) => TRow | null;
  afterPage?: (context: {
    errors: string[];
    warnings: string[];
    mappedRows: TRow[];
    page: number;
    rawRows: unknown[];
    successfulPages: number;
  }) => "stop" | void;
  extraHeaders?: Record<string, string>;
}

export interface PaginatedFetchResult<TRow> {
  rows: TRow[];
  errors: string[];
  warnings: string[];
  successfulPages: number;
  completed: boolean;
  nextPage: number | null;
}

export async function runPaginatedDirectApiFetch<TRow>(
  opts: PaginatedFetchOptions<TRow>,
): Promise<PaginatedFetchResult<TRow>> {
  const {
    source,
    buildUrl,
    pageSize,
    startPage = 1,
    maxPages = DIRECT_API_DEFAULT_MAX_PAGES,
    timeoutMs = DIRECT_API_REQUEST_TIMEOUT_MS,
    signal,
    parsePage,
    mapRow,
    afterPage,
    extraHeaders,
  } = opts;

  const rows: TRow[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  let successfulPages = 0;
  let completed = false;
  let nextPage: number | null = startPage;

  const lastPage = startPage + maxPages - 1;
  for (let page = startPage; page <= lastPage; page++) {
    const url = buildUrl(page);
    nextPage = page;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, ...extraHeaders },
        signal: buildDirectApiRequestSignal(signal, timeoutMs),
      });
    } catch (err) {
      rethrowIfAborted(err, signal);
      const message = toErrorMessage(err);
      errors.push(`${source} page ${page} request failed: ${message}`);
      break;
    }

    if (!res.ok) {
      await cancelUnsuccessfulResponseBodyQuietly(res);
      errors.push(`${source} page ${page} returned ${res.status}`);
      break;
    }

    const parsed = await readDexApiJson(res, `${source} page ${page}`);
    if (!parsed.ok) {
      errors.push(parsed.error);
      break;
    }

    const parsedPage = parsePage(parsed.data, page);
    if (parsedPage === null) {
      errors.push(`${source} page ${page} invalid root shape`);
      break;
    }
    if (!Array.isArray(parsedPage) && "error" in parsedPage) {
      errors.push(parsedPage.error);
      break;
    }
    const pageRows = Array.isArray(parsedPage) ? parsedPage : parsedPage.rows;

    successfulPages++;
    if (pageRows.length === 0) {
      completed = true;
      nextPage = null;
      break;
    }

    const mappedRows: TRow[] = [];
    for (const raw of pageRows) {
      const mapped = mapRow(raw, { page });
      if (mapped !== null) {
        rows.push(mapped);
        mappedRows.push(mapped);
      }
    }

    const afterPageResult = afterPage?.({
      errors,
      warnings,
      mappedRows,
      page,
      rawRows: pageRows,
      successfulPages,
    });
    if (afterPageResult === "stop") {
      nextPage = page + 1;
      break;
    }

    if (pageRows.length < pageSize) {
      completed = true;
      nextPage = null;
      break;
    }

    if (page === lastPage) {
      nextPage = page + 1;
      errors.push(`${source} pagination cap reached at page ${page}; resumeFromPage=${nextPage}`);
      break;
    }
  }

  return { rows, errors, warnings, successfulPages, completed, nextPage };
}

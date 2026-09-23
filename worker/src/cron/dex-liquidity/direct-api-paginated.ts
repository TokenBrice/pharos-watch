import { USER_AGENT } from "../../lib/constants";
import { cancelUnsuccessfulResponseBodyQuietly } from "../../lib/response-body";
import { rethrowIfAborted, yieldToEventLoop } from "../../lib/abort";
import { readDexApiJson } from "./direct-api-json";
import {
  DIRECT_API_DEFAULT_MAX_PAGES,
  DIRECT_API_DEFAULT_MAX_RESPONSE_BYTES,
  DIRECT_API_REQUEST_TIMEOUT_MS,
  buildDirectApiRequestSignal,
} from "./direct-api-policy";
import { toErrorMessage } from "@shared/lib/error-utils";

type PaginatedRequest = {
  url: string;
  init?: Omit<RequestInit, "headers" | "signal"> & { headers?: Record<string, string> };
};

type PaginatedRequestSource =
  | { buildUrl: (page: number) => string; buildRequest?: never }
  | { buildUrl?: never; buildRequest: (page: number) => PaginatedRequest };

export type PaginatedFetchOptions<TRow> = PaginatedRequestSource & {
  source: string;
  pageSize: number;
  startPage?: number;
  maxPages?: number;
  timeoutMs?: number;
  /** Hard per-page body cap; defaults to `DIRECT_API_DEFAULT_MAX_RESPONSE_BYTES`. */
  maxResponseBytes?: number;
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
  pageContext?: (page: number) => string;
  formatRequestError?: (page: number, message: string) => string;
  formatResponseError?: (page: number, status: number) => string;
  formatPaginationCapError?: (page: number, nextPage: number) => string;
};

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
    buildRequest,
    pageSize,
    startPage = 1,
    maxPages = DIRECT_API_DEFAULT_MAX_PAGES,
    timeoutMs = DIRECT_API_REQUEST_TIMEOUT_MS,
    maxResponseBytes = DIRECT_API_DEFAULT_MAX_RESPONSE_BYTES,
    signal,
    parsePage,
    mapRow,
    afterPage,
    extraHeaders,
    pageContext = (page) => `${source} page ${page}`,
    formatRequestError = (page, message) => `${source} page ${page} request failed: ${message}`,
    formatResponseError = (page, status) => `${source} page ${page} returned ${status}`,
    formatPaginationCapError = (page, next) =>
      `${source} pagination cap reached at page ${page}; resumeFromPage=${next}`,
  } = opts;

  const rows: TRow[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  let successfulPages = 0;
  let completed = false;
  let nextPage: number | null = startPage;

  const lastPage = startPage + maxPages - 1;
  for (let page = startPage; page <= lastPage; page++) {
    const request = buildRequest?.(page) ?? { url: buildUrl!(page) };
    nextPage = page;

    let res: Response;
    try {
      res = await fetch(request.url, {
        ...request.init,
        headers: { "User-Agent": USER_AGENT, ...extraHeaders, ...request.init?.headers },
        signal: buildDirectApiRequestSignal(signal, timeoutMs),
      });
    } catch (err) {
      rethrowIfAborted(err, signal);
      const message = toErrorMessage(err);
      errors.push(formatRequestError(page, message));
      break;
    }

    if (!res.ok) {
      await cancelUnsuccessfulResponseBodyQuietly(res);
      errors.push(formatResponseError(page, res.status));
      break;
    }

    const parsed = await readDexApiJson(res, pageContext(page), maxResponseBytes);
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
      errors.push(formatPaginationCapError(page, nextPage));
      break;
    }

    // Row mapping over a full page is synchronous; yield before requesting the
    // next page so slot heartbeats and abort timers keep firing during a
    // multi-page sweep instead of waiting for the whole provider to drain.
    await yieldToEventLoop(signal);
  }

  return { rows, errors, warnings, successfulPages, completed, nextPage };
}

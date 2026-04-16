import { USER_AGENT } from "../../lib/constants";
import { readDexApiJson } from "./direct-api-json";

export interface PaginatedFetchOptions<TRow> {
  source: string;
  buildUrl: (page: number) => string;
  pageSize: number;
  maxPages?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  parsePage: (body: unknown) => unknown[] | null;
  mapRow: (raw: unknown) => TRow | null;
  extraHeaders?: Record<string, string>;
}

export interface PaginatedFetchResult<TRow> {
  rows: TRow[];
  errors: string[];
  successfulPages: number;
}

export async function runPaginatedDirectApiFetch<TRow>(
  opts: PaginatedFetchOptions<TRow>,
): Promise<PaginatedFetchResult<TRow>> {
  const {
    source,
    buildUrl,
    pageSize,
    maxPages = 50,
    timeoutMs = 15_000,
    signal,
    parsePage,
    mapRow,
    extraHeaders,
  } = opts;

  const rows: TRow[] = [];
  const errors: string[] = [];
  let successfulPages = 0;

  for (let page = 1; page <= maxPages; page++) {
    const url = buildUrl(page);

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, ...extraHeaders },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${source} page ${page} request failed: ${message}`);
      break;
    }

    if (!res.ok) {
      errors.push(`${source} page ${page} returned ${res.status}`);
      break;
    }

    const parsed = await readDexApiJson(res, `${source} page ${page}`);
    if (!parsed.ok) {
      errors.push(parsed.error);
      break;
    }

    const pageRows = parsePage(parsed.data);
    if (pageRows === null) {
      errors.push(`${source} page ${page} invalid root shape`);
      break;
    }

    successfulPages++;
    if (pageRows.length === 0) break;

    for (const raw of pageRows) {
      const mapped = mapRow(raw);
      if (mapped !== null) rows.push(mapped);
    }

    if (pageRows.length < pageSize) break;
  }

  return { rows, errors, successfulPages };
}

/** A page the provider could not serve. Rows already read are kept, paging stops, and the scan stays incomplete. */
export interface PagedTokenPoolsPageFailure {
  pageFailed: true;
}

export interface FetchPagedTokenPoolsOptions<TPool> {
  maxPages: number;
  pageSize: number;
  fetchPage(page: number): Promise<TPool[] | PagedTokenPoolsPageFailure>;
}

export interface PagedTokenPoolsResult<TPool> {
  rows: TPool[];
  /**
   * The run-scoped contiguity claim: true only when this run read a page
   * shorter than `pageSize`. A full page at the cap, and a page that failed,
   * both leave it false — the absence of a next-page marker is never a
   * completeness claim.
   */
  complete: boolean;
  /** Paging stopped because `maxPages` was reached while pages were still full. */
  cappedAtMaxPages: boolean;
  /** Rows already accumulated when a page failed; null when no page failed. */
  failedAfterRows: number | null;
}

export async function fetchPagedTokenPools<TPool>(
  options: FetchPagedTokenPoolsOptions<TPool>,
): Promise<PagedTokenPoolsResult<TPool>> {
  const rows: TPool[] = [];

  for (let page = 1; page <= options.maxPages; page++) {
    const pagePools = await options.fetchPage(page);
    if (!Array.isArray(pagePools)) {
      return { rows, complete: false, cappedAtMaxPages: false, failedAfterRows: rows.length };
    }
    rows.push(...pagePools);
    if (pagePools.length < options.pageSize) {
      return { rows, complete: true, cappedAtMaxPages: false, failedAfterRows: null };
    }
  }

  return { rows, complete: false, cappedAtMaxPages: true, failedAfterRows: null };
}

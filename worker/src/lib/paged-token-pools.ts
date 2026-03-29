export interface FetchPagedTokenPoolsOptions<TPool> {
  maxPages: number;
  pageSize: number;
  fetchPage(page: number): Promise<TPool[]>;
}

export async function fetchPagedTokenPools<TPool>(
  options: FetchPagedTokenPoolsOptions<TPool>,
): Promise<TPool[]> {
  const pools: TPool[] = [];

  for (let page = 1; page <= options.maxPages; page++) {
    const pagePools = await options.fetchPage(page);
    if (pagePools.length === 0) break;
    pools.push(...pagePools);
    if (pagePools.length < options.pageSize) break;
  }

  return pools;
}

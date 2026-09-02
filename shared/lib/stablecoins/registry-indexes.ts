interface StablecoinRegistryIndexOptions<T, L extends string> {
  canonicalOrder?: readonly string[];
  normalize?: (row: T) => T;
  isActive: (row: T) => boolean;
  canonicalOrderErrorPrefix?: string;
  lifecyclePredicates?: Record<L, (row: T) => boolean>;
}

export interface StablecoinRegistryIndex<T> {
  stablecoins: readonly T[];
  metaById: Map<string, T>;
  ids: Set<string>;
}

export function buildStablecoinRegistryIndexes<T extends { id: string }, L extends string = never>(
  rows: readonly T[],
  options: StablecoinRegistryIndexOptions<T, L>,
) {
  const normalized = options.normalize ? rows.map(options.normalize) : rows;
  const sourceById = new Map(normalized.map((row) => [row.id, row]));
  const tracked = options.canonicalOrder?.map((id) => {
    const row = sourceById.get(id);
    if (!row) throw new Error(`${options.canonicalOrderErrorPrefix ?? ""}canonical-order.json references unknown stablecoin ID: ${id}`);
    return row;
  }) ?? normalized;
  const active = tracked.filter(options.isActive);
  const index = (stablecoins: readonly T[]): StablecoinRegistryIndex<T> => ({
    stablecoins,
    metaById: new Map(stablecoins.map((row) => [row.id, row])),
    ids: new Set(stablecoins.map((row) => row.id)),
  });
  const lifecycle = {} as Record<L, StablecoinRegistryIndex<T>>;
  const predicates = options.lifecyclePredicates;
  if (predicates) for (const name in predicates) lifecycle[name] = index(tracked.filter(predicates[name]));
  return { tracked: index(tracked), active: index(active), lifecycle };
}

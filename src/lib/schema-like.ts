export interface SchemaLikeIssue {
  path: readonly PropertyKey[];
  message: string;
}

export type SchemaLikeResult<T> =
  | { success: true; data: T }
  | { success: false; error: { issues: readonly SchemaLikeIssue[] } };

export interface SchemaLike<T> {
  safeParse(data: unknown): SchemaLikeResult<T>;
}

export type SchemaLikeLoader<T> = () => Promise<SchemaLike<T>>;
export type SchemaLikeSource<T> = SchemaLike<T> | SchemaLikeLoader<T>;

export function createLazySchema<T>(loader: () => Promise<SchemaLike<T>>): SchemaLikeLoader<T> {
  let cached: Promise<SchemaLike<T>> | null = null;
  return () => {
    cached ??= loader();
    return cached;
  };
}

export function isSchemaLike<T>(value: SchemaLikeSource<T>): value is SchemaLike<T> {
  return typeof value === "object" && value !== null && typeof value.safeParse === "function";
}

export async function resolveSchemaLike<T>(
  source: SchemaLikeSource<T> | undefined,
): Promise<SchemaLike<T> | undefined> {
  if (!source) return undefined;
  return isSchemaLike(source) ? source : source();
}

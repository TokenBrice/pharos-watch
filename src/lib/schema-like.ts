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

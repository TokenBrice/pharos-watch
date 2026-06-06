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

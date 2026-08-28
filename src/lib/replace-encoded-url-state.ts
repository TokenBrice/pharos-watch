export type ReplaceEncodedUrlStateOptions =
  | {
      clear: "all";
      schemaKeys: readonly string[];
    }
  | {
      clear: "key";
      key: string;
    };

/** Replace encoded state in a mutable query while preserving unrelated params. */
export function replaceEncodedUrlState(
  params: URLSearchParams,
  encoded: string,
  options: ReplaceEncodedUrlStateOptions,
): void {
  const keysToClear = options.clear === "all" ? options.schemaKeys : [options.key];
  for (const key of keysToClear) params.delete(key);
  for (const [key, value] of new URLSearchParams(encoded)) params.set(key, value);
}

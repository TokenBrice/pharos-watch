/** A dedicated permanent bucket; no dataset or capture expiry policy applies. */
export const SOCIAL_PREVIEW_BUCKET_NAME = "pharos-social-previews";
export const SOCIAL_PREVIEW_ASSET_OBJECT_PREFIX = "evergreen/v2/";
export const SOCIAL_SCORECARD_OBJECT_PREFIX = "scorecards/v1/";

/** Pages needs only this request-scoped subset of the R2 binding. */
export interface SocialPreviewBucket {
  get(key: string): Promise<{
    arrayBuffer(): Promise<ArrayBuffer>;
    text(): Promise<string>;
    customMetadata?: Record<string, string>;
  } | null>;
  put(
    key: string,
    value: string | ArrayBuffer | Uint8Array,
    options: {
      onlyIf: { etagDoesNotMatch: string };
      httpMetadata?: { contentType?: string; cacheControl?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<{ etag: string } | null>;
}

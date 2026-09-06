import {
  BoundedStreamOverflowError,
  bufferReadableStream,
  parseDeclaredLength,
} from "@shared/lib/bounded-stream";

export type BoundedRequestBodyResult =
  | { status: "ok"; bytes: Uint8Array<ArrayBuffer> }
  | { status: "too-large" }
  | { status: "unreadable" };

export async function readBoundedRequestBody(
  request: Request,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<BoundedRequestBodyResult> {
  const declared = parseDeclaredLength(request.headers.get("Content-Length"));
  if (
    (declared.status === "valid" && declared.value > maxBytes) ||
    (declared.status === "invalid" && declared.reason === "unsafe")
  ) {
    return { status: "too-large" };
  }
  if (!request.body) {
    return { status: "ok", bytes: new Uint8Array() };
  }

  try {
    const { bytes } = await bufferReadableStream(request.body, {
      maxBytes,
      signal,
      overflowCancelReason: () => "Body too large",
    });
    return { status: "ok", bytes };
  } catch (error) {
    return error instanceof BoundedStreamOverflowError
      ? { status: "too-large" }
      : { status: "unreadable" };
  }
}

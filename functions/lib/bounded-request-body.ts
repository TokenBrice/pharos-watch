import {
  BoundedStreamOverflowError,
  bufferReadableStream,
  parseDeclaredLength,
} from "@shared/lib/bounded-stream";

export type BoundedRequestBodyResult =
  | { status: "ok"; bytes: Uint8Array }
  | { status: "too-large" }
  | { status: "unreadable" };

export async function readBoundedRequestBody(
  request: Request,
  maxBytes: number,
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
      overflowCancelReason: () => "Body too large",
    });
    return { status: "ok", bytes };
  } catch (error) {
    return error instanceof BoundedStreamOverflowError
      ? { status: "too-large" }
      : { status: "unreadable" };
  }
}

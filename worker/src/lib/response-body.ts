export async function drainResponseBody(response: Response): Promise<void> {
  if (response.bodyUsed || !response.body) {
    return;
  }

  try {
    await response.arrayBuffer();
  } catch {
    try {
      await response.body.cancel();
    } catch {
      /* expected: body already consumed or stream cancelled */
    }
  }
}

export async function cancelResponseBodyQuietly(response: Response | null | undefined): Promise<void> {
  if (!response?.body || response.bodyUsed) {
    return;
  }

  try {
    await response.body.cancel();
  } catch {
    /* best-effort cancellation only */
  }
}

export async function cancelUnsuccessfulResponseBodyQuietly(response: Response | null | undefined): Promise<void> {
  if (!response || response.ok) {
    return;
  }

  await cancelResponseBodyQuietly(response);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function cancelResponseBodyForAbort(response: Response): void {
  if (!response.body) return;
  void response.body.cancel().catch(() => {
    /* best-effort cancellation only */
  });
}

async function readResponseBodyWithSignal<TResult>(
  response: Response,
  signal: AbortSignal | undefined,
  read: () => Promise<TResult>,
): Promise<TResult> {
  if (!signal) return await read();
  if (signal.aborted) {
    cancelResponseBodyForAbort(response);
    throw abortReason(signal);
  }

  let onAbort: (() => void) | null = null;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      cancelResponseBodyForAbort(response);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([read(), abortPromise]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function readResponseJsonWithSignal<TResult = unknown>(
  response: Response,
  signal?: AbortSignal,
): Promise<TResult> {
  return await readResponseBodyWithSignal(response, signal, async () => await response.json() as TResult);
}

export async function readResponseTextWithSignal(
  response: Response,
  signal?: AbortSignal,
): Promise<string> {
  return await readResponseBodyWithSignal(response, signal, async () => await response.text());
}

export async function readResponseTextBoundedWithSignal(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  let onAbort: (() => void) | null = null;
  let abortPromise: Promise<never> | null = null;

  if (signal) {
    if (signal.aborted) {
      await reader.cancel(abortReason(signal)).catch(() => undefined);
      throw abortReason(signal);
    }
    abortPromise = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        void reader.cancel(abortReason(signal)).catch(() => undefined);
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  try {
    for (;;) {
      if (signal?.aborted) {
        throw abortReason(signal);
      }
      const result = abortPromise
        ? await Promise.race([reader.read(), abortPromise])
        : await reader.read();
      const { done, value } = result;
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      const remaining = maxBytes - total;
      if (remaining <= 0) {
        await reader.cancel();
        break;
      }
      const slice = chunk.byteLength > remaining ? chunk.slice(0, remaining) : chunk;
      total += slice.byteLength;
      text += decoder.decode(slice, { stream: total < maxBytes });
      if (chunk.byteLength > remaining || total >= maxBytes) {
        await reader.cancel();
        break;
      }
    }
    if (signal?.aborted) {
      throw abortReason(signal);
    }
    text += decoder.decode();
    return text;
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

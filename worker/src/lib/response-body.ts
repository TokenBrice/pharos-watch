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
  if (!response?.body) {
    return;
  }

  try {
    await response.body.cancel();
  } catch {
    /* best-effort cancellation only */
  }
}

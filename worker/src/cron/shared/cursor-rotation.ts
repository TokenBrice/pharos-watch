export interface RotateFromCursorResult<T> {
  items: T[];
  startIndex: number;
  cursorFound: boolean;
}

export function rotateFromCursor<T>(
  values: readonly T[],
  cursor: string | null | undefined,
  keyFn: (value: T) => string,
  options: { startAfterCursor?: boolean } = {},
): RotateFromCursorResult<T> {
  if (values.length === 0) {
    return { items: [], startIndex: 0, cursorFound: false };
  }

  if (!cursor) {
    return { items: [...values], startIndex: 0, cursorFound: false };
  }

  const cursorIndex = values.findIndex((value) => keyFn(value) === cursor);
  if (cursorIndex < 0) {
    return { items: [...values], startIndex: 0, cursorFound: false };
  }

  const startIndex = (cursorIndex + (options.startAfterCursor ? 1 : 0)) % values.length;
  return {
    items: [...values.slice(startIndex), ...values.slice(0, startIndex)],
    startIndex,
    cursorFound: true,
  };
}

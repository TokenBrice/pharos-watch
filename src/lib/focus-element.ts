/**
 * Return focus to `element` on the next microtask — after React has committed
 * the state change that closed the dialog, panel, or row the focus is coming
 * back from. Focusing synchronously inside the same handler races that commit.
 *
 * The `isConnected` guard skips elements that unmounted in the same commit
 * (e.g. the row that opened a dialog was filtered out by a refresh), which
 * would otherwise be a silent no-op on a detached node.
 *
 * Hoisted from three copies in the admin surface (WS8.5); two of them omitted
 * the guard.
 */
export function focusElement(element: HTMLElement | null | undefined) {
  queueMicrotask(() => {
    if (element?.isConnected) element.focus();
  });
}

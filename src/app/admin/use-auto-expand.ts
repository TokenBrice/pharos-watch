import { useState } from "react";

export interface AutoExpandDisclosure {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  /**
   * True when the signal turned on after the initial evaluation while the
   * disclosure is collapsed. Callers should badge the summary instead of
   * forcing the section open.
   */
  hasNewSignal: boolean;
}

/**
 * Manages a boolean open/closed state for a `<details>` element that
 * auto-opens only on the first definite `signal` evaluation.
 *
 * Pass `null` while the signal cannot be evaluated yet (evidence still
 * loading). The first non-null value decides the initial expansion during
 * that same render, so the shell paints in its final state without a
 * post-render layout shift. Later signal changes never force the section
 * open or closed; they surface through `hasNewSignal` so the UI can badge
 * the collapsed summary instead of moving the operator mid-task.
 */
export function useAutoExpand(signal: boolean | null): AutoExpandDisclosure {
  const [isOpen, setIsOpen] = useState(false);
  const [hasEvaluatedInitial, setHasEvaluatedInitial] = useState(false);

  if (signal != null && !hasEvaluatedInitial) {
    setHasEvaluatedInitial(true);
    if (signal) setIsOpen(true);
  }

  return {
    isOpen,
    setIsOpen,
    hasNewSignal: hasEvaluatedInitial && signal === true && !isOpen,
  };
}

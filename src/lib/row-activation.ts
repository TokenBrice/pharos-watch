type RowActivationEvent = Pick<MouseEvent,
  "defaultPrevented" | "target" | "currentTarget" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "button"
>;

const INTERACTIVE = 'a,button,input,select,textarea,summary,[role="button"],[role="link"],[role="textbox"],[role="combobox"],[role="slider"],[role="checkbox"],[role="switch"],[contenteditable]:not([contenteditable="false"]),[tabindex]';

export function isRowActivation(event: RowActivationEvent): boolean {
  if (event.defaultPrevented || event.button !== 0 ||
    event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  const { target, currentTarget } = event;
  // React portal events bubble through the row without belonging to its DOM subtree.
  if (!(target instanceof Node) || !(currentTarget instanceof Element) || !currentTarget.contains(target)) return false;
  const element = target instanceof Element ? target : target.parentElement;
  const control = element?.closest(INTERACTIVE);
  if (control && control !== currentTarget && currentTarget.contains(control)) return false;
  const selection = target.ownerDocument?.getSelection();
  return !selection || selection.isCollapsed || !selection.rangeCount ||
    !selection.getRangeAt(0).intersectsNode(currentTarget);
}

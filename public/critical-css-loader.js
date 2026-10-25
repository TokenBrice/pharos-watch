(() => {
  const activate = (link) => {
    link.media = "all";
    link.dataset.pharosCriticalCss = "loaded";
  };

  document.querySelectorAll('link[data-pharos-critical-css="async"]').forEach((link) => {
    link.addEventListener("load", () => activate(link), { once: true });
    if (link.sheet) activate(link);
  });

  const activateStylesheets = () => {
    document
      .querySelectorAll('link[data-pharos-critical-css="async"][media="print"]')
      .forEach(activate);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", activateStylesheets, { once: true });
    return;
  }

  activateStylesheets();
})();

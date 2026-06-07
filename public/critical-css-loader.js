(() => {
  const activateStylesheets = () => {
    document
      .querySelectorAll('link[data-pharos-critical-css="async"][media="print"]')
      .forEach((link) => {
        link.media = "all";
        link.dataset.pharosCriticalCss = "loaded";
      });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", activateStylesheets, { once: true });
    return;
  }

  activateStylesheets();
})();

(function () {
  var pending = false;
  var params = new URLSearchParams(window.location.search);
  if (params.get("p") || params.get("coins")) {
    pending = true;
  } else {
    try {
      var stored = JSON.parse(localStorage.getItem("pharos:portfolio") || "null");
      pending = Array.isArray(stored) && stored.length > 0;
    } catch {}
  }
  // This selects a placeholder only; usePortfolio still validates every holding.
  document.documentElement.toggleAttribute("data-portfolio-empty", !pending);
})();

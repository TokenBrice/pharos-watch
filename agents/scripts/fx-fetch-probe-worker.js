const TARGETS = [
  {
    key: "frankfurter",
    url: "https://api.frankfurter.app/latest?from=USD&to=EUR,GBP,CHF,BRL,JPY,IDR,SGD,TRY,AUD,ZAR,CAD,CNY,PHP,MXN",
  },
  {
    key: "jsdelivr-secondary",
    url: "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json",
  },
  {
    key: "pagesdev-secondary",
    url: "https://latest.currency-api.pages.dev/v1/currencies/usd.min.json",
  },
  {
    key: "exchange-rate-api",
    url: "https://open.er-api.com/v6/latest/USD",
  },
];

async function probeUrl(target) {
  const startedAt = Date.now();
  try {
    const res = await fetch(target.url, {
      headers: {
        "User-Agent": "Pharos/1.0 (stablecoin analytics)",
      },
    });
    const text = await res.text();
    return {
      key: target.key,
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      durationMs: Date.now() - startedAt,
      bodyPreview: text.slice(0, 240),
    };
  } catch (error) {
    return {
      key: target.key,
      ok: false,
      status: null,
      statusText: null,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const parallel = url.searchParams.get("parallel") === "1";
    const holdCount = Number.parseInt(url.searchParams.get("hold") ?? "0", 10);
    const holdUrl = url.searchParams.get("holdUrl") ?? TARGETS[1].url;
    const heldResponses = [];

    if (Number.isFinite(holdCount) && holdCount > 0) {
      for (let index = 0; index < holdCount; index++) {
        try {
          const response = await fetch(holdUrl, {
            headers: {
              "User-Agent": "Pharos/1.0 (stablecoin analytics)",
            },
          });
          heldResponses.push({
            ok: response.ok,
            status: response.status,
            bodyUsed: response.bodyUsed,
          });
        } catch (error) {
          heldResponses.push({
            ok: false,
            status: null,
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          });
        }
      }
    }

    const results = parallel
      ? await Promise.all(TARGETS.map((target) => probeUrl(target)))
      : await TARGETS.reduce(
          async (promise, target) => [...await promise, await probeUrl(target)],
          Promise.resolve([]),
        );

    return new Response(JSON.stringify({
      now: new Date().toISOString(),
      parallel,
      holdCount,
      holdUrl,
      heldResponses,
      results,
    }, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
    });
  },
};

import { afterEach, describe, expect, it, vi } from "vitest";
import { createR2MeasurementsClient } from "../lib/r2-measurements-client";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import sharp from "sharp";
import { R2ObjectExistsError, SignedR2ObjectClient, type R2PutOptions } from "../lib/r2-object-client";
import { publishSocialPreviews, runSocialPreviewPublisherCli } from "../maintenance/publish-social-previews";
import { SOCIAL_PREVIEW_MAP_PATH } from "../lib/social-preview-build";
import { SOCIAL_PREVIEW_BUCKET_NAME } from "../../shared/lib/social-preview-storage";
import { createTempRepoTracker } from "./helpers/test-state";

const { makeRoot, cleanup } = createTempRepoTracker("social-preview-publisher");
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const credentials = {
  accountId: "account-123",
  accessKeyId: "access-key",
  secretAccessKey: "secret-key",
  now: () => new Date("2026-09-03T12:34:56.000Z"),
};

describe("R2 measurements client", () => {
  it("matches an independent SigV4 vector for reserved URI bytes and normalized headers", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const client = createR2MeasurementsClient({ ...credentials, fetch: fetchMock });
    await client.put("captures/a b!+?#.json.gz", new TextEncoder().encode("body"), {
      contentType: " application/json;  \tcharset=utf-8 ",
      contentEncoding: "gzip",
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(url).toBe("https://account-123.r2.cloudflarestorage.com/pharos-measurements/captures/a%20b%21%2B%3F%23.json.gz");
    expect(init?.method).toBe("PUT");
    expect(init?.body).toEqual(Buffer.from("body"));
    const headers = new Headers(init?.headers);
    // Independently calculated with Python hashlib/hmac from the literal canonical request.
    expect(headers.get("x-amz-content-sha256")).toBe("230d8358dc8e8890b4c58deeb62912ee2f20357ae92a5cc861b98e68fe31acb5");
    expect(headers.get("authorization")).toBe("AWS4-HMAC-SHA256 Credential=access-key/20260903/auto/s3/aws4_request, SignedHeaders=content-encoding;content-type;host;x-amz-content-sha256;x-amz-date, Signature=fc0a531814821839f4e4642379d0c1eb1db7b7545eb4f71468c847835fa6bee3");
  });

  it("returns GET bytes and distinguishes missing objects from successful HEAD metadata", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("compressed"))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { headers: {
        etag: '"version-1"', "content-length": "123", "content-type": "application/gzip",
      } }));
    const client = createR2MeasurementsClient({ ...credentials, fetch: fetchMock });
    await expect(client.get("capture.gz")).resolves.toEqual(Buffer.from("compressed"));
    await expect(client.get("missing.gz")).resolves.toBeNull();
    await expect(client.head("missing.gz")).resolves.toBeNull();
    await expect(client.head("capture.gz")).resolves.toEqual({
      etag: '"version-1"', contentLength: 123, contentType: "application/gzip", customMetadata: {},
    });
  });

  it("refuses traversal and absolute keys before fetching", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = createR2MeasurementsClient({ ...credentials, fetch: fetchMock });
    for (const key of ["../capture", "captures/../secret", "/absolute", "captures\\secret"]) {
      await expect(client.get(key)).rejects.toThrow(/relative path/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires each credential before fetching", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    expect(() => createR2MeasurementsClient({ ...credentials, accountId: "", fetch: fetchMock })).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    for (const field of ["accessKeyId", "secretAccessKey"] as const) {
      const client = createR2MeasurementsClient({ ...credentials, [field]: "", fetch: fetchMock });
      await expect(client.get("capture.gz")).rejects.toThrow(/Missing R2_MEASUREMENTS_/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates non-404 HTTP failures for every method", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }));
    const client = createR2MeasurementsClient({ ...credentials, fetch: fetchMock });
    await expect(client.put("capture.gz", new Uint8Array())).rejects.toThrow(/PUT.*503/);
    await expect(client.get("capture.gz")).rejects.toThrow(/GET.*503/);
    await expect(client.head("capture.gz")).rejects.toThrow(/HEAD.*503/);
  });
});

describe("shared R2 object transport", () => {
  it("signs create-only conditions and image metadata for the dedicated bucket", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 412 }))
      .mockResolvedValueOnce(new Response(null, { headers: {
        "content-length": "4", "content-type": "image/png", "x-amz-meta-png-sha256": "original-hash",
      } }));
    const client = new SignedR2ObjectClient({
      ...credentials, fetch: fetchMock, bucket: SOCIAL_PREVIEW_BUCKET_NAME,
      accessKeyEnv: "R2_SOCIAL_PREVIEWS_ACCESS_KEY_ID", secretKeyEnv: "R2_SOCIAL_PREVIEWS_SECRET_ACCESS_KEY",
    });
    await expect(client.put("evergreen/v2/card.png", Buffer.from("body"), {
      ifNoneMatch: "*", contentType: "image/png", cacheControl: "public, max-age=31536000, immutable",
      customMetadata: { "png-sha256": "original-hash" },
    })).rejects.toBeInstanceOf(R2ObjectExistsError);
    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(url).toContain("/pharos-social-previews/evergreen/v2/card.png");
    expect(init?.redirect).toBe("error");
    expect(headers.get("if-none-match")).toBe("*");
    expect(headers.get("authorization")).toContain("SignedHeaders=cache-control;content-type;host;if-none-match;x-amz-content-sha256;x-amz-date;x-amz-meta-png-sha256");
    expect((await client.head("evergreen/v2/card.png"))?.customMetadata).toEqual({ "png-sha256": "original-hash" });
  });

  it("lists a prefix across continuation pages with signed canonical queries", async () => {
    const page = (keys: string[], token?: string) => new Response(`<ListBucketResult>${keys.map((key) => `<Contents><Key>${key}</Key></Contents>`).join("")}<IsTruncated>${token !== undefined}</IsTruncated>${token === undefined ? "" : `<NextContinuationToken>${token}</NextContinuationToken>`}</ListBucketResult>`);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(page(["evergreen/v2/a.png"], "a+b/c="))
      .mockResolvedValueOnce(page(["evergreen/v2/b&amp;c.png"]))
      .mockResolvedValueOnce(new Response("denied", { status: 403 }));
    const client = new SignedR2ObjectClient({
      ...credentials, fetch: fetchMock, bucket: SOCIAL_PREVIEW_BUCKET_NAME,
      accessKeyEnv: "R2_SOCIAL_PREVIEWS_ACCESS_KEY_ID", secretKeyEnv: "R2_SOCIAL_PREVIEWS_SECRET_ACCESS_KEY",
    });
    await expect(client.list("evergreen/v2/")).resolves.toEqual(["evergreen/v2/a.png", "evergreen/v2/b&c.png"]);
    const [[first, firstInit], [second, secondInit]] = fetchMock.mock.calls;
    expect(first).toBe("https://account-123.r2.cloudflarestorage.com/pharos-social-previews?list-type=2&prefix=evergreen%2Fv2%2F");
    expect(second).toBe("https://account-123.r2.cloudflarestorage.com/pharos-social-previews?continuation-token=a%2Bb%2Fc%3D&list-type=2&prefix=evergreen%2Fv2%2F");
    // Independently calculated with Python hashlib/hmac from the literal canonical requests.
    expect(new Headers(firstInit?.headers).get("authorization")).toContain("Signature=bbd01e504270fd78a9f5c1965f51d9731844c77b8e34ab50ec6573a2d9534f39");
    expect(new Headers(secondInit?.headers).get("authorization")).toContain("Signature=06dfd24c8c13589c79abe2e10505180332ca29ecfa3d3dbbf1d7db24cdbb41dc");
    await expect(client.list("evergreen/v2/")).rejects.toThrow(/LIST.*403/);
  });
});

function productionBinding(layout: "legacy" | "unified", name = "SOCIAL_PREVIEWS", bucket = SOCIAL_PREVIEW_BUCKET_NAME) {
  return layout === "legacy"
    ? { r2_buckets: { [name]: { name: bucket } } }
    : { bindings: [{ type: "r2_bucket", name, bucket_name: bucket }] };
}

async function publicationFixture(assets = 1) {
  const repoRoot = makeRoot();
  const bytes = await sharp({ create: { width: 1200, height: 630, channels: 4, background: "#15283b" } }).png().toBuffer();
  const urls = Array.from({ length: assets }, (_, index) => `/og/v2/image-${createHash("sha256").update(`${index}`).digest("hex")}.png`);
  const url = urls[0];
  const write = (path: string, value: string | Uint8Array) => {
    mkdirSync(dirname(join(repoRoot, path)), { recursive: true });
    writeFileSync(join(repoRoot, path), value);
  };
  // Routes sharing a drawing share one image.
  write(SOCIAL_PREVIEW_MAP_PATH, JSON.stringify({ "/shared/": { url }, ...Object.fromEntries(urls.map((url, index) => [`/${index}/`, { url }])) }));
  for (const assetUrl of urls) write(`out${assetUrl}`, bytes);
  const accountStatePath = "scripts/ci/cloudflare-account-state-manifest.json";
  const accountState = JSON.parse(readFileSync(join(process.cwd(), accountStatePath), "utf8"));
  write(accountStatePath, JSON.stringify(accountState));
  const env = { CLOUDFLARE_ACCOUNT_ID: "account-123", CLOUDFLARE_API_TOKEN: "configuration-read-token" };
  const events: string[] = [];
  const responses: Partial<Record<"project" | "lifecycle", Response | Error>> = {};
  const project = (production: unknown) => Response.json({ success: true, result: {
    name: accountState.pages.project, deployment_configs: { production },
  } });
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const resource = path === `/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${accountState.pages.project}`
      ? "project"
      : path === `/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${SOCIAL_PREVIEW_BUCKET_NAME}/lifecycle`
        ? "lifecycle" : null;
    if (!resource) throw new Error(`Unexpected configuration URL: ${input}`);
    events.push(resource);
    const response = responses[resource];
    if (response instanceof Error) throw response;
    return response ?? (resource === "project"
      ? project(productionBinding("legacy"))
      : Response.json({ success: true, result: { rules: [] } }));
  });
  const stored = new Map<string, { bytes: Buffer; options: R2PutOptions }>();
  const client = {
    list: vi.fn(async (prefix: string) => {
      events.push("list");
      return [...stored.keys()].filter((key) => key.startsWith(prefix));
    }),
    put: vi.fn(async (key: string, body: Uint8Array, options: R2PutOptions = {}) => {
      events.push("put");
      if (options.ifNoneMatch !== "*") throw new Error("unconditional write refused");
      if (stored.has(key)) throw new R2ObjectExistsError(key);
      stored.set(key, { bytes: Buffer.from(body), options });
    }),
  };
  const publish = (options: Parameters<typeof publishSocialPreviews>[0] = {}) =>
    publishSocialPreviews({ repoRoot, client, env, fetchImpl, ...options });
  const noS3 = () => {
    for (const operation of Object.values(client)) expect(operation).not.toHaveBeenCalled();
  };
  const rejectBeforeS3 = async (message: string | RegExp, options = {}) => {
    await expect(publish({ execute: true, ...options })).rejects.toThrow(message);
    noS3();
  };
  return { repoRoot, bytes, url, write, client, stored, env, fetchImpl, events, accountState,
    accountStatePath, responses, project, publish, noS3, rejectBeforeS3 };
}

async function rejectConfiguration(resource: "project" | "lifecycle", response: Response | Error, message: string | RegExp) {
  const { responses, rejectBeforeS3 } = await publicationFixture();
  responses[resource] = response;
  await rejectBeforeS3(message);
}

describe("permanent social preview publication", () => {
  it("runs local-only dry runs in Node and rejects invalid CLI usage before effects", async () => {
    const { repoRoot, publish, noS3, fetchImpl } = await publicationFixture();
    const result = { assets: 1, created: 0, existing: 0, dryRun: true };
    await expect(publish({ env: {} })).resolves.toEqual(result);
    noS3();
    expect(fetchImpl).not.toHaveBeenCalled();
    const node = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
      import { publishSocialPreviews } from ${JSON.stringify(new URL("../maintenance/publish-social-previews.ts", import.meta.url).href)};
      process.stdout.write(JSON.stringify(await publishSocialPreviews({ repoRoot: ${JSON.stringify(repoRoot)}, env: {} })));
    `], { cwd: resolve(import.meta.dirname, "../.."), encoding: "utf8" });
    expect(node.status, node.stderr).toBe(0);
    expect(JSON.parse(node.stdout)).toEqual(result);
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(runSocialPreviewPublisherCli(["--help"])).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    for (const argv of [["--unknown"], ["--execute", "--dry-run"], ["--out-dir"], ["--out-dir=out", "--out-dir=other"]]) {
      await expect(runSocialPreviewPublisherCli(argv)).rejects.toThrow();
    }
  });

  it("lists once, then creates only missing current images with create-only writes", async () => {
    const { accountState, accountStatePath, write, publish, stored, bytes, url, events, fetchImpl, env, client } = await publicationFixture();
    accountState.pages.project = "manifest-selected-project";
    write(accountStatePath, JSON.stringify(accountState));
    await expect(publish({ execute: true })).resolves.toEqual({ assets: 1, created: 1, existing: 0, dryRun: false });
    await expect(publish({ execute: true })).resolves.toEqual({ assets: 1, created: 0, existing: 1, dryRun: false });
    expect(new Set(events.slice(0, 2))).toEqual(new Set(["project", "lifecycle"]));
    expect(events.slice(2, 4)).toEqual(["list", "put"]);
    expect(new Set(events.slice(4, 6))).toEqual(new Set(["project", "lifecycle"]));
    expect(events.slice(6)).toEqual(["list"]);
    expect(client.list).toHaveBeenCalledWith("evergreen/v2/");
    expect(stored.get(`evergreen/v2/${url.slice(7)}`)).toEqual({ bytes, options: {
      ifNoneMatch: "*", contentType: "image/png", cacheControl: "public, max-age=31536000, immutable",
      customMetadata: { "png-sha256": createHash("sha256").update(bytes).digest("hex") },
    } });
    for (const [request, init] of fetchImpl.mock.calls) {
      expect(new URL(String(request)).origin).toBe("https://api.cloudflare.com");
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${env.CLOUDFLARE_API_TOKEN}`);
    }
  });

  it("issues Pages project and R2 lifecycle preflight GETs concurrently before any S3 call", async () => {
    const { publish, fetchImpl, project, events, client } = await publicationFixture();
    const projectGate = Promise.withResolvers<Response>();
    const lifecycleGate = Promise.withResolvers<Response>();
    fetchImpl.mockImplementation(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.includes("/pages/projects/")) {
        events.push("project");
        return projectGate.promise;
      }
      if (path.endsWith("/lifecycle")) {
        events.push("lifecycle");
        return lifecycleGate.promise;
      }
      throw new Error(`Unexpected URL: ${input}`);
    });
    const pending = publish({ execute: true });
    try {
      await vi.waitFor(() => expect(events).toEqual(["project", "lifecycle"]));
      expect(client.list).not.toHaveBeenCalled();
      expect(client.put).not.toHaveBeenCalled();
      lifecycleGate.resolve(Response.json({ success: true, result: { rules: [] } }));
      await Promise.resolve();
      expect(client.list).not.toHaveBeenCalled();
      projectGate.resolve(project(productionBinding("legacy")));
      await expect(pending).resolves.toEqual({ assets: 1, created: 1, existing: 0, dryRun: false });
      expect(events.slice(2)).toEqual(["list", "put"]);
    } finally {
      projectGate.resolve(project(productionBinding("legacy")));
      lifecycleGate.resolve(Response.json({ success: true, result: { rules: [] } }));
    }
  });

  it.each([
    ["CLOUDFLARE_ACCOUNT_ID", {}],
    ["CLOUDFLARE_API_TOKEN", { CLOUDFLARE_ACCOUNT_ID: "account-123" }],
  ])("requires %s before configuration requests or S3 operations", async (name, env) => {
    const { rejectBeforeS3, fetchImpl } = await publicationFixture();
    await rejectBeforeS3(`${name} is required`, { env });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe.each(["project", "lifecycle"] as const)("%s preflight", (resource) => {
    const message = resource === "project" ? "Cloudflare Pages project lookup" : /lifecycle|object deletion/;
    it.each([
      [403, '{"success":false}'], [404, '{"success":false}'], [500, '{"success":false}'],
      [200, '{"success":false}'], [200, "not JSON"], [200, '{"success":true,"result":null}'],
    ])("blocks S3 on unreadable configuration (HTTP %s, %s)", async (status, body) => {
      await rejectConfiguration(resource, new Response(body, { status }), message);
    });
    it("blocks S3 on connection failure", async () => {
      const error = `${resource} configuration connection failed`;
      await rejectConfiguration(resource, new Error(error), error);
    });
  });

  it.each([
    { name: "wrong-project", deployment_configs: { production: {} } },
    { name: "stablecoin-dashboard" },
  ])("blocks S3 on malformed Pages project identity %j", async (result) => {
    await rejectConfiguration("project", Response.json({ success: true, result }), "Cloudflare Pages project lookup");
  });

  it.each([
    { r2_buckets: {} },
    productionBinding("legacy", "OTHER_PREVIEWS"),
    productionBinding("legacy", "SOCIAL_PREVIEWS", "wrong-bucket"),
    productionBinding("unified", "OTHER_PREVIEWS"),
    productionBinding("unified", "SOCIAL_PREVIEWS", "wrong-bucket"),
  ])("refuses publication when production Pages binding identity differs: %j", async (production) => {
    const { responses, project, rejectBeforeS3 } = await publicationFixture();
    responses.project = project(production);
    await rejectBeforeS3("pages.production.r2Bindings.SOCIAL_PREVIEWS");
  });

  it.each([
    {},
    { rules: [] },
    { rules: [{ id: "abort-incomplete", enabled: true, conditions: { prefix: "" },
      abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 604800 } } }] },
    { rules: [{ id: "disabled-deletion", enabled: false, conditions: { prefix: "" }, deleteObjectsTransition: {} }] },
  ])("publishes with a unified binding and legitimate non-expiring lifecycle %j", async (result) => {
    const { responses, project, publish, client } = await publicationFixture();
    responses.project = project(productionBinding("unified"));
    responses.lifecycle = Response.json({ success: true, result });
    await expect(publish({ execute: true })).resolves.toMatchObject({ created: 1, dryRun: false });
    expect(client.put).toHaveBeenCalled();
  });

  it.each([
    undefined,
    { rules: null },
    { rules: [{}] },
    { rules: [{ id: "other-prefix-expiry", enabled: true, conditions: { prefix: "unrelated/" },
      deleteObjectsTransition: { condition: { type: "Age", maxAge: 86400 } } }] },
  ])("blocks S3 on deletion or malformed lifecycle %j", async (result) => {
    await rejectConfiguration("lifecycle", Response.json({ success: true, result }), /lifecycle|object deletion/);
  });

  it("accepts a racing create of the same identity but fails on any other create error", async () => {
    const { publish, client } = await publicationFixture();
    client.put.mockRejectedValueOnce(new R2ObjectExistsError("evergreen/v2/raced.png"));
    await expect(publish({ execute: true })).resolves.toMatchObject({ created: 0, existing: 1 });
    client.put.mockRejectedValueOnce(new Error("R2 PUT returned HTTP 500"));
    await expect(publish({ execute: true })).rejects.toThrow("HTTP 500");
  });

  it("bounds publication to four workers and drains in-flight creates before rejecting", async () => {
    const { publish, client } = await publicationFixture(8);
    const fail = Promise.withResolvers<void>(), drain = Promise.withResolvers<void>();
    let puts = 0, active = 0, peak = 0, settled = false;
    client.put.mockImplementation(async () => {
      const first = puts++ === 0;
      peak = Math.max(peak, ++active);
      await (first ? fail.promise : drain.promise);
      active--;
      if (first) throw new Error("R2 PUT returned HTTP 500");
    });
    const publication = publish({ execute: true }).finally(() => { settled = true; });
    const rejection = expect(publication).rejects.toThrow("HTTP 500");
    try {
      await vi.waitFor(() => expect(puts).toBe(4));
      expect(peak).toBe(4);
      fail.resolve();
      await vi.waitFor(() => expect(active).toBe(3));
      expect(settled).toBe(false);
    } finally {
      fail.resolve();
      drain.resolve();
    }
    await rejection;
    expect(puts).toBe(4);
    expect(active).toBe(0);
  });

  it("rejects a current image missing from or malformed in the export before any remote call", async () => {
    const { write, url, repoRoot, rejectBeforeS3, fetchImpl } = await publicationFixture();
    write(`out${url}`, "<html>not a png</html>");
    await rejectBeforeS3("Invalid social preview PNG");
    rmSync(join(repoRoot, `out${url}`));
    await rejectBeforeS3(/ENOENT/);
    write(SOCIAL_PREVIEW_MAP_PATH, JSON.stringify({ "/": { url: "/og-card.png" } }));
    await rejectBeforeS3("Invalid social preview route map URL");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

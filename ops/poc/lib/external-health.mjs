function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function validateExternalHealthConfig({
  baseUrl,
  revision,
  clientId,
  clientSecret,
}) {
  let origin;
  try {
    origin = new URL(baseUrl);
  } catch {
    throw new Error("POC_BASE_URL must be a valid HTTPS origin");
  }
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("POC_BASE_URL must be an HTTPS origin without a path");
  }
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error(
      "APP_REVISION must be a lowercase 40-character Git revision",
    );
  }
  if (
    typeof clientId !== "string" ||
    clientId.length === 0 ||
    typeof clientSecret !== "string" ||
    clientSecret.length === 0
  ) {
    throw new Error("Cloudflare Access service-token credentials are required");
  }
  return {
    baseUrl: origin.origin,
    revision,
    clientId,
    clientSecret,
  };
}

async function probe({
  label,
  url,
  expectedStatus,
  headers,
  requestTimeoutMs,
  fetchImpl,
}) {
  try {
    const response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    let body;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    return {
      label,
      httpStatus: response.status,
      status: typeof body?.status === "string" ? body.status : undefined,
      revision: typeof body?.revision === "string" ? body.revision : undefined,
      ready: response.ok && body?.status === expectedStatus,
    };
  } catch (error) {
    return {
      label,
      error: error instanceof Error ? error.message : String(error),
      ready: false,
    };
  }
}

function describeProbe(result) {
  if (result.error) return `${result.label}=error(${result.error})`;
  const state = result.status ? ` ${result.status}` : "";
  const revision = result.revision ? `@${result.revision}` : "";
  return `${result.label}=${result.httpStatus}${state}${revision}`;
}

export async function verifyAccessProtection({
  baseUrl,
  fetchImpl = fetch,
  requestTimeoutMs = 10_000,
}) {
  const origin = new URL(baseUrl);
  if (origin.protocol !== "https:") {
    throw new Error("Access protection verification requires HTTPS");
  }

  const response = await fetchImpl(new URL("/healthz", origin), {
    redirect: "manual",
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (response.status === 401 || response.status === 403) return;

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (location) {
      const login = new URL(location, origin);
      if (
        login.protocol === "https:" &&
        login.hostname.endsWith(".cloudflareaccess.com") &&
        login.pathname.startsWith("/cdn-cgi/access/")
      ) {
        return;
      }
    }
  }

  let body;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (response.ok && body?.status === "ok") {
    throw new Error(
      "POC origin health is publicly reachable without Cloudflare Access protection",
    );
  }
  throw new Error(
    `Could not prove Cloudflare Access protection; unauthenticated /healthz returned HTTP ${response.status}`,
  );
}

export async function waitForExternalRevision({
  baseUrl,
  revision,
  clientId,
  clientSecret,
  timeoutMs,
  intervalMs,
  fetchImpl = fetch,
  delay = sleep,
}) {
  const validated = validateExternalHealthConfig({
    baseUrl,
    revision,
    clientId,
    clientSecret,
  });
  const deadline = Date.now() + timeoutMs;
  const requestTimeoutMs = Math.max(1, Math.min(10_000, timeoutMs || 10_000));
  const headers = {
    "CF-Access-Client-Id": validated.clientId,
    "CF-Access-Client-Secret": validated.clientSecret,
  };
  const origin = new URL(validated.baseUrl);
  let lastObserved = "no response";

  do {
    const [web, api] = await Promise.all([
      probe({
        label: "web",
        url: new URL("/healthz", origin),
        expectedStatus: "ok",
        headers,
        requestTimeoutMs,
        fetchImpl,
      }),
      probe({
        label: "api",
        url: new URL("/api/readyz", origin),
        expectedStatus: "ready",
        headers,
        requestTimeoutMs,
        fetchImpl,
      }),
    ]);

    const mismatched =
      web.revision && api.revision && web.revision !== api.revision;
    lastObserved = `${describeProbe(web)}; ${describeProbe(api)}${
      mismatched ? "; revision mismatch" : ""
    }`;
    if (
      web.ready &&
      api.ready &&
      web.revision === revision &&
      api.revision === revision
    ) {
      return;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(intervalMs, remaining));
  } while (true);

  throw new Error(
    `Timed out waiting for external revision ${revision}. Last observed: ${lastObserved}`,
  );
}

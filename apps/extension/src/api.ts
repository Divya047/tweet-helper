export const DEFAULT_BACKEND_URL = "http://127.0.0.1:4317";
/** Default wait for normal backend calls. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;
/** Score + draft flows can include a Codex CLI run and one JSON-repair retry. */
export const LONG_REQUEST_TIMEOUT_MS = 180_000;

export async function getBackendUrl(): Promise<string> {
  if (typeof chrome !== "undefined" && chrome?.storage?.local) {
    const stored = await chrome.storage.local.get({ backendUrl: DEFAULT_BACKEND_URL });
    return typeof stored.backendUrl === "string" ? stored.backendUrl : DEFAULT_BACKEND_URL;
  }
  return DEFAULT_BACKEND_URL;
}

export async function setBackendUrl(backendUrl: string): Promise<void> {
  if (typeof chrome !== "undefined" && chrome?.storage?.local) {
    await chrome.storage.local.set({ backendUrl });
  }
}

export async function postJson<T>(
  path: string,
  body: unknown,
  options: { timeoutMs?: number } = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const safari = await safariDirectConnection();
  if (safari) return fetchJson<T>(safari.backendUrl, path, "POST", body, timeoutMs, safari.authToken);
  const native = await nativeRequest<T>(path, "POST", body);
  if (native.used) return native.value;
  const backendUrl = await getBackendUrl();
  return fetchJson<T>(backendUrl, path, "POST", body, timeoutMs);
}

export async function getJson<T>(path: string): Promise<T> {
  const safari = await safariDirectConnection();
  if (safari) return fetchJson<T>(safari.backendUrl, path, "GET", undefined, DEFAULT_REQUEST_TIMEOUT_MS, safari.authToken);
  const native = await nativeRequest<T>(path, "GET");
  if (native.used) return native.value;
  const backendUrl = await getBackendUrl();
  return fetchJson<T>(backendUrl, path, "GET", undefined, DEFAULT_REQUEST_TIMEOUT_MS);
}

async function fetchJson<T>(
  backendUrl: string,
  path: string,
  method: "GET" | "POST",
  body: unknown,
  timeoutMs: number,
  authToken = ""
): Promise<T> {
  let response: Response;
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (method === "POST") headers["Content-Type"] = "application/json";
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    response = await fetch(`${backendUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error("Backend request timed out. Try again in a moment.");
    }
    throw error;
  }
  const json = (await response.json().catch(() => null)) as T | { error?: { message?: string } } | null;
  if (!response.ok) {
    const message = isErrorResponse(json) ? json.error?.message : undefined;
    throw new Error(message ?? `Backend request failed with HTTP ${response.status}.`);
  }
  return json as T;
}

type SafariConnection = { backendUrl: string; authToken: string };
let safariConnectionPromise: Promise<SafariConnection | undefined> | undefined;

/**
 * Keep native messaging short-lived: read shared configuration once, then let
 * Safari fetch the private HTTPS endpoint directly for long generation calls.
 */
async function safariDirectConnection(): Promise<SafariConnection | undefined> {
  if (!isMobileSafariExtension() || !chrome.runtime?.sendMessage) return undefined;
  safariConnectionPromise ??= chrome.runtime.sendMessage({ type: "NATIVE_CONFIG_REQUEST" })
    .then((response: { nativeBridge?: boolean; ok?: boolean; backendUrl?: string; authToken?: string; error?: string } | undefined) => {
      if (!response?.nativeBridge) return undefined;
      if (!response.ok) throw new Error(response.error ?? "Could not read the iPhone app settings.");
      if (!response.backendUrl?.startsWith("https://")) return undefined;
      return { backendUrl: response.backendUrl.replace(/\/$/, ""), authToken: response.authToken ?? "" };
    });
  return safariConnectionPromise;
}

/**
 * Raw HTTP configurations retain the native URLSession bridge as a compatibility
 * fallback. Private HTTPS configurations use Safari directly above.
 */
async function nativeRequest<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<
  { used: false } | { used: true; value: T }
> {
  if (!isMobileSafariExtension() || !chrome.runtime?.sendMessage) return { used: false };
  const response = await chrome.runtime.sendMessage({
    type: "NATIVE_API_REQUEST",
    path,
    method,
    ...(body === undefined ? {} : { body })
  }).catch(() => undefined) as
    | { nativeBridge?: boolean; ok?: boolean; data?: T; error?: string; status?: number }
    | undefined;
  if (!response?.nativeBridge) return { used: false };
  if (!response.ok) throw new Error(response.error ?? `Backend request failed with HTTP ${response.status ?? "?"}.`);
  return { used: true, value: response.data as T };
}

function isMobileSafariExtension(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/i.test(navigator.userAgent) && /Safari/i.test(navigator.userAgent);
}

function isErrorResponse(value: unknown): value is { error?: { message?: string } } {
  return typeof value === "object" && value !== null && "error" in value;
}

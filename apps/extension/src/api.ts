export const DEFAULT_BACKEND_URL = "http://127.0.0.1:4317";

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

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const backendUrl = await getBackendUrl();
  const response = await fetch(`${backendUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = (await response.json().catch(() => null)) as T | { error?: { message?: string } } | null;
  if (!response.ok) {
    const message = isErrorResponse(json) ? json.error?.message : undefined;
    throw new Error(message ?? `Backend request failed with HTTP ${response.status}.`);
  }
  return json as T;
}

export async function getJson<T>(path: string): Promise<T> {
  const backendUrl = await getBackendUrl();
  const response = await fetch(`${backendUrl}${path}`);
  const json = (await response.json().catch(() => null)) as T | { error?: { message?: string } } | null;
  if (!response.ok) {
    const message = isErrorResponse(json) ? json.error?.message : undefined;
    throw new Error(message ?? `Backend request failed with HTTP ${response.status}.`);
  }
  return json as T;
}

function isErrorResponse(value: unknown): value is { error?: { message?: string } } {
  return typeof value === "object" && value !== null && "error" in value;
}

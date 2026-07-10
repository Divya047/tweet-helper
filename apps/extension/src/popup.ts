import { DEFAULT_BACKEND_URL, getBackendUrl, getJson, setBackendUrl } from "./api.js";

const backendInput = document.getElementById("backendUrl") as HTMLInputElement;
const saveButton = document.getElementById("save") as HTMLButtonElement;
const checkButton = document.getElementById("check") as HTMLButtonElement;
const status = document.getElementById("status") as HTMLDivElement;

backendInput.value = await getBackendUrl();

saveButton.addEventListener("click", () => {
  void saveBackendUrl();
});

checkButton.addEventListener("click", () => {
  status.textContent = "Checking...";
  setBusy(true);
  void saveBackendUrl({ quiet: true })
    .then(() => getJson<{ ok: boolean }>("/health"))
    .then((result) => {
      status.textContent = result.ok ? "Connected." : "Backend did not report healthy.";
    })
    .catch((error: unknown) => {
      status.textContent =
        error instanceof TypeError
          ? "Could not reach the backend. Start it locally and confirm the URL."
          : error instanceof Error
            ? error.message
            : "Backend check failed.";
    })
    .finally(() => {
      setBusy(false);
    });
});

async function saveBackendUrl(options: { quiet?: boolean } = {}): Promise<void> {
  const value = normalizeBackendUrl(backendInput.value);
  backendInput.value = value;
  await setBackendUrl(value);
  if (!options.quiet) {
    status.textContent = "Saved.";
  }
}

function normalizeBackendUrl(value: string): string {
  const trimmed = value.trim() || DEFAULT_BACKEND_URL;
  try {
    const url = new URL(trimmed);
    return url.origin;
  } catch {
    return DEFAULT_BACKEND_URL;
  }
}

function setBusy(busy: boolean): void {
  saveButton.disabled = busy;
  checkButton.disabled = busy;
}

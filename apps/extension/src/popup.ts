import { DEFAULT_BACKEND_URL, getBackendUrl, getJson, setBackendUrl } from "./api.js";

const backendInput = document.getElementById("backendUrl") as HTMLInputElement;
const saveButton = document.getElementById("save") as HTMLButtonElement;
const checkButton = document.getElementById("check") as HTMLButtonElement;
const status = document.getElementById("status") as HTMLDivElement;

backendInput.value = await getBackendUrl();

saveButton.addEventListener("click", () => {
  const value = backendInput.value.trim() || DEFAULT_BACKEND_URL;
  void setBackendUrl(value).then(() => {
    status.textContent = "Saved.";
  });
});

checkButton.addEventListener("click", () => {
  status.textContent = "Checking...";
  void getJson<{ ok: boolean; model: string }>("/health")
    .then((result) => {
      status.textContent = result.ok ? `Connected. Model: ${result.model}` : "Backend did not report healthy.";
    })
    .catch((error: unknown) => {
      status.textContent = error instanceof Error ? error.message : "Backend check failed.";
    });
});

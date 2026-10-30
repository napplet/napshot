"use strict";

const command = document.querySelector("#install-command");
const copyButton = document.querySelector("#copy-command");
const copyFeedback = document.querySelector("#copy-feedback");

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(command.textContent);
    copyFeedback.textContent = "Command copied.";
  } catch {
    copyFeedback.textContent = "Select the command above and copy it manually.";
  }
});

/** Only display the public status contract; never inject service strings as markup. */
async function showStatus() {
  const state = document.querySelector("#service-state");
  try {
    const response = await fetch("/api/status", {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("Status unavailable");
    const data = await response.json();
    const counts = data.counts;
    if (
      !counts ||
      !["pending", "done", "failed"].every(
        (key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0,
      )
    ) {
      throw new Error("Invalid status");
    }
    for (const key of ["pending", "done", "failed"]) {
      document.querySelector(`#${key}-count`).textContent = String(counts[key]);
    }
    const pubkey =
      typeof data.pubkey === "string" && /^[0-9a-f]{64}$/.test(data.pubkey)
        ? data.pubkey
        : null;
    document.querySelector("#signer-key").textContent =
      pubkey ?? "Not configured";
    const lastScan =
      Number.isSafeInteger(data.lastScan) && data.lastScan > 0
        ? new Date(data.lastScan * 1000)
        : null;
    document.querySelector("#last-scan").textContent =
      lastScan && !Number.isNaN(lastScan.getTime())
        ? lastScan.toLocaleString()
        : "No completed scan";
    state.textContent = pubkey
      ? "Status endpoint reachable"
      : "No signer configured";
    document.querySelector("#service-details").hidden = false;
  } catch {
    state.textContent = "Live status unavailable";
    document.querySelector("#service-details").hidden = true;
  }
}

void showStatus();

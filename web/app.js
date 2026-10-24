"use strict";

const checkButton = document.getElementById("check-cloud");
const statusText = document.getElementById("cloud-status");

checkButton.addEventListener("click", async () => {
  checkButton.disabled = true;
  statusText.textContent = "Checking hosted service. Please wait…";
  try {
    const response = await fetch("/api/status", {
      method: "GET", cache: "no-store", headers: { Accept: "application/json" }
    });
    const result = await response.json();
    if (response.ok && result.connected === true) {
      statusText.textContent = "Connected. The Railway backend is responding independently in the cloud.";
    } else if (result.reason === "not_configured") {
      statusText.textContent = "The Vercel backend URL is not configured yet.";
    } else {
      statusText.textContent = "The cloud backend is not responding. Check Railway and the Vercel BACKEND_URL setting.";
    }
  } catch (_) {
    statusText.textContent = "Unable to check right now. Try again after deployment.";
  } finally {
    checkButton.disabled = false;
  }
});

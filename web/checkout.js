"use strict";

// Stage 3D-A: browser speech recognition is a clearly labelled optional preview.
// It is NOT N-ATLAS. No transcript, LLM output or recognized words may approve or
// capture a transaction; the fixed price and payment confirmation are deliberate UI actions.
const language = document.getElementById("pilot-language");
const transcript = document.getElementById("voice-transcript");
const speakButton = document.getElementById("pilot-mic");
const listenButton = document.getElementById("pilot-listen");
const voiceStatus = document.getElementById("pilot-voice-status");
const confirm = document.getElementById("pilot-confirm");
const start = document.getElementById("pilot-start");
const checkoutStatus = document.getElementById("pilot-checkout-status");

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizing = false;
let recognition = null;
if (!Recognition) {
  speakButton.disabled = true;
  voiceStatus.textContent = "Browser speech recognition is unavailable here. Type an optional note instead. Hosted N-ATLAS voice input has not been connected yet.";
}

confirm.addEventListener("change", () => {
  start.disabled = !confirm.checked;
});
language.addEventListener("change", () => {
  confirm.checked = false;
  start.disabled = true;
  voiceStatus.textContent = "Selected language: " + language.options[language.selectedIndex].text +
    ". Browser speech support may vary. Review the fixed USD 5.00 amount again.";
});
transcript.addEventListener("input", () => {
  confirm.checked = false;
  start.disabled = true;
});

speakButton.addEventListener("click", () => {
  if (!Recognition || recognizing) return;
  recognition = new Recognition();
  recognizing = true;
  recognition.lang = language.value;
  recognition.interimResults = false;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;
  speakButton.disabled = true;
  voiceStatus.textContent = "Listening via your browser's speech service. Please avoid private financial information.";
  recognition.onresult = (event) => {
    const words = event.results?.[0]?.[0]?.transcript;
    if (!words) return;
    transcript.value = String(words).slice(0, 240);
    confirm.checked = false;
    start.disabled = true;
    voiceStatus.textContent = "Transcript available for review. Browser transcription can be wrong and never authorizes a payment.";
  };
  recognition.onerror = () => {
    voiceStatus.textContent = "Browser recognition could not understand this language or recording. You may type a note instead.";
  };
  recognition.onend = () => {
    recognizing = false;
    speakButton.disabled = false;
  };
  try { recognition.start(); }
  catch {
    recognizing = false;
    speakButton.disabled = false;
    voiceStatus.textContent = "Microphone unavailable. Try typed input.";
  }
});

listenButton.addEventListener("click", () => {
  if (!("speechSynthesis" in window)) {
    voiceStatus.textContent = "Device speech playback is unavailable. Read the on-screen payment summary.";
    return;
  }
  window.speechSynthesis.cancel();
  const message = new SpeechSynthesisUtterance(
    "This is a simulated PayPal sandbox transaction for five US dollars. " +
    "No real money moves. Review the amount and explicitly confirm before proceeding."
  );
  message.lang = "en-NG";
  message.rate = 0.92;
  window.speechSynthesis.speak(message);
  voiceStatus.textContent = "Playing an English device-generated summary. Translations and N-ATLAS voices are not yet enabled.";
});

start.addEventListener("click", async () => {
  if (!confirm.checked || start.disabled) return;
  start.disabled = true;
  checkoutStatus.textContent = "Creating your fixed-price sandbox order securely. Please wait…";
  try {
    const response = await fetch("/api/checkout", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "VoiceBridgePay"
      },
      body: JSON.stringify({
        action: "create", item_code: "financial-literacy-demo", confirm: true
      }),
      cache: "no-store"
    });
    const data = await response.json();
    if (!response.ok || data.ok !== true) {
      if (data.reason === "checkout_not_configured") {
        checkoutStatus.textContent = "Checkout is still being configured in Railway and Vercel. No order has been created.";
      } else if (data.reason === "order_already_in_progress") {
        checkoutStatus.textContent = "This browser already has a sandbox order in progress. Return to its PayPal checkout or wait for the session to expire before starting another.";
      } else {
        checkoutStatus.textContent = "Unable to create a sandbox order right now. Please try later.";
      }
      return;
    }
    const approval = new URL(data.approve_url);
    if (approval.origin !== "https://www.sandbox.paypal.com" ||
        data.currency !== "USD" || String(data.amount) !== "5.00") {
      checkoutStatus.textContent = "Unexpected checkout details. No redirect performed.";
      return;
    }
    checkoutStatus.textContent = "Opening secure PayPal Sandbox approval…";
    window.location.assign(approval.toString());
  } catch {
    checkoutStatus.textContent = "Network problem. Sandbox checkout could not be started.";
  } finally {
    start.disabled = !confirm.checked;
  }
});

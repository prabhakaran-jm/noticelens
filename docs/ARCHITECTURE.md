# Hybrid architecture

**Status: the local app is implemented. Production Send is disabled.** On-device Read uses `InferenceMode.ONLY_ON_DEVICE` and keeps a result only when `inferenceSource` is `on_device`. It does not silently fall back to the cloud. The model name for that Read was not reported. This note does not claim Gemini Nano 4.

Two recorded tests from 20 November 2026 are separate. They are described at the end of this note. The sections below keep the earlier phase record, with the sentences that are no longer current corrected.

```text
Input (pasted text or a bundled fictional notice)
  |
  v
Firebase AI Logic: ONLY_ON_DEVICE
  | -> Kept only when inferenceSource is on_device. The model name is not reported.
  v
Local verification against the notice text
  | -> Withhold amounts or dates the text does not support
  v
Closed v2 brief and an explicit privacy review
  |
  v
Production Send stays disabled
  |
  v
Source-linked actions and a comparison that can leave the relationship unverified
```

A separate recorded diagnostic used `ONLY_IN_CLOUD`. The ordinary app does not make that call.

## Original spike checklist

This checklist is the historical gate. It is not an instruction to start a new model call.

1. Create a Firebase Web project and register a Web App.
2. Configure Firebase AI Logic and App Check in supported modes.
3. Confirm the Chrome version, on-device model availability, and supported configuration.
4. Use `ONLY_ON_DEVICE` through Firebase AI Logic for structured extraction.
5. Keep the actual returned `inferenceSource`.
6. Start with pasted text. Images and PDFs are outside the current Read path.
7. A general offline claim was not made.
8. A separate `ONLY_IN_CLOUD` diagnostic was later recorded. Production Send stays disabled.

## Security and correctness boundaries

- **Do not use `PREFER_ON_DEVICE` on a raw notice.** That mode can fall back to the cloud. The Read path uses `ONLY_ON_DEVICE`.
- **Local AI unavailable:** the screen shows Limited Mode. Amounts, dates, and quotes come from local checks. The notice is not sent to a cloud model to fill that gap.
- **Source quotes:** local code compares quotes with the notice text.
- **Cloud brief:** the closed v2 schema has no free-text fields. It carries category, ISO dates, amounts, action IDs, goal and guidance IDs. Notice prose, names, addresses, and account references are not fields. The brief still contains the notice's amounts and dates. Production Send does not transmit it.
- **User outcomes:** the product explains a household notice. It does not decide a legal payment, and it does not recover money.
- **Monitoring:** avoid logging raw notice text or the approved brief to analytics.

## Technologies in the app

Firebase AI Logic Web SDK, Firebase App Check, TypeScript, React, and Vite. Firebase Hosting is not configured. Sync and Firebase Remote Config are not part of this app.

## Current code, Phase 5C-4

On-device reading stays in the browser. Cloud drafting is a separate Firebase AI Logic call with `ONLY_IN_CLOUD`. The client requires an App Check site key before that call. The production screen can reach it only for the two exact synthetic notices, only after the privacy modal approves the exact v2 bytes, and only when a test probe is present. `CLOUD_SUBMISSION_ENABLED` remains false, so the shipped Send control does not make the call. The in-flight lock lasts until delivery stops, and aborting it does not prove the HTTP request has settled. App Check does not prove the payload is one of those notices. The output guard checks recognised amounts, including decimal fractions, against the approved brief. It does not catch every monetary expression, personal-data expression, unrecognised identifier, date, URL, or promise. R5-2, R5-3, R5-4, and R5-5 stay open. Production Send stays disabled.

The sentences that used to say a live Chrome check was still pending described Phase 5C-4. The later recorded tests are below. They do not enable Send.

## Phase 5C-5

A loopback development diagnostic can call the same Firebase path when `VITE_NOTICELENS_REAL_CLOUD_DIAGNOSTIC` is exactly `1`. It is not available in the production build, and a URL or localStorage value cannot enable it. One earlier Chrome run on 127.0.0.1 reached `firebasevertexai.googleapis.com` once, with HTTP 200, and the parsed body contained the approved canonical v2 string without the raw notice markers. The model JSON was rejected because the reply template matched the greeting identifier pattern. That draft was not shown. Replays that omitted the API key and app ID returned HTTP 403. Those results are inconclusive and are not App Check enforcement. Console enforcement is still unconfirmed because the Firebase CLI token refresh returned 400. A held second request aborted with `net::ERR_ABORTED`. `CLOUD_SUBMISSION_ENABLED` stays false. R5-2, R5-3, R5-4, and R5-5 stay open. £1,280 and £520 stay independent, and the comparison does not establish a recovered £760.

This section is that earlier inconclusive run. It is not the accepted diagnostic recorded below.

## Phase 5C-6

The greeting check accepts only a complete line of "Dear Sir or Madam,", "Dear Sir/Madam,", or "Dear Customer Services,", including that line followed by a letter. A name after the comma fails closed. "Dear [RECIPIENT_NAME]" and "Dear [RECIPIENT_NAME]," stay allowed. The prompt asks for 'Dear Sir or Madam,' on its own line and forbids invented names. A name that is not on a Dear line is still not detected, so R5-2 stays open. Negative App Check probes are not sent and do not replay the approved generation. HTTP 401 or 403 alone is not enforcement. The owner confirmed Firebase AI Logic Basic Enforced and Replay Off for project noticelens-2026, so manual Console enforcement is PASS. The automated CLI read stays BLOCKED (HTTP 401). SDK App Check header attachment and header-varying probes are NOT TESTED. This is not a live token-verification pass. Production Send stays disabled.

At the time of Phase 5C-6, the accepted cloud draft recorded below had not yet been run. Production Send stayed disabled after that draft.

## Recorded tests, 20 November 2026

These two tests are separate. They are not one session.

- **On-device.** One Read of the £1,280 sample in Chrome `158.0.8127.36`, through `ONLY_ON_DEVICE`. The runtime source was `on_device`. Structured extraction passed, and the screen accepted the result. The Read took about 56.7 seconds. No cloud-generation request was observed in that browser context. The model that answered was not named. This is not verification of Gemini Nano 4.
- **Cloud.** A separate, earlier loopback diagnostic used `ONLY_IN_CLOUD` and `gemini-3.5-flash-lite`. It returned HTTP 200 with `inferenceSource` `in_cloud`. The request matched the approved canonical v2 brief, and `cloudOutputGuard` accepted the draft. Production Send stayed disabled.

Judging steps are in [docs/JUDGING.md](JUDGING.md).

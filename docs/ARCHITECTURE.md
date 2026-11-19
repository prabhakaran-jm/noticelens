# Proposed hybrid architecture

**Status: design only — unimplemented.**

```text
Input (pasted text / locally extracted document text)
  |
  v
Firebase AI Logic: ONLY_ON_DEVICE + Gemini Nano (compatible Chrome)
  | -> Structured obligations, amounts, deadlines, quotes and local entity candidates
  v
Local verification against independent source text
  | -> Discard/flag unsupported quotations
  v
Local identifiers redaction + structural schema generation
  | -> Explicit user review of exactly what leaves the browser
  v
Firebase AI Logic: ONLY_IN_CLOUD + supported Gemini cloud model
  | -> Response options and source-linked reply template with placeholders
  v
Local personalisation + explicit human approval
  |
  v
Source-linked action history / revised notice comparison
```

## Non-negotiable first technical spike

1. Create Firebase Web project and register Web App.
2. Configure Firebase AI Logic and App Check in supported modes.
3. Confirm Chrome version, on-device model availability/download and supported configuration.
4. Use `ONLY_ON_DEVICE` through Firebase AI Logic to extract a small structured JSON test fixture.
5. Log/confirm the **actual** returned `inferenceSource`.
6. Check on-device support for input formats: start with pasted text; enable images only after testing. For PDFs, extract text locally or render to accepted images without uploading the raw document.
7. Repeat offline after caching the model and application assets (no claim of general offline capability until demonstrated).
8. Make a separate `ONLY_IN_CLOUD` call on a fixed, non-sensitive structural payload.

## Security and correctness boundaries

- **Do not use `PREFER_ON_DEVICE` on a raw sensitive notice:** fallback may send it to cloud.
- **Local AI unavailable:** display Limited mode, allow manual structured entry or rule-assisted redaction, preview content, and require consent before any cloud call. Regex alone does not guarantee that all personal information was removed.
- **Source quotes:** compare against independently available document text. The model's own transcription of an image is not independent evidence.
- **Cloud payload:** include only approved notice type, relevant dates/periods, minimally necessary redacted clauses, selected response goal, and curated guidance excerpts. Exclude raw documents and any local PII mapping.
- **User outcomes:** the product explains response options; it does not decide legal rights or submit documents automatically.
- **Monitoring:** avoid logging raw document text, local personal information or sensitive payloads to analytics or crash tooling.

## Potential technologies

Firebase AI Logic Web SDK, Firebase App Check, Firebase Hosting, TypeScript, React, browser-native local state. Sync and Firebase Remote Config are optional, not MVP requirements.

## Current code, Phase 5C-4

On-device reading stays in the browser. Cloud drafting is a separate Firebase AI Logic call with `ONLY_IN_CLOUD`. The client requires an App Check site key before that call. The production screen can reach it only for the two exact synthetic notices, only after the privacy modal approves the exact v2 bytes, and only when a test probe is present. `CLOUD_SUBMISSION_ENABLED` remains false, so the shipped Send control does not make the call. The in-flight lock lasts until delivery stops, and aborting it does not prove the HTTP request has settled. App Check does not prove the payload is one of those notices, and a live Chrome check of that attestation is still pending. The output guard checks recognised amounts, including decimal fractions, against the approved brief. It does not catch every monetary expression, personal-data expression, unrecognised identifier, date, URL, or promise. Real Chrome verification is still required before the flag can change. R5-2, R5-3, R5-4, and R5-5 stay open. Production Send stays disabled.

## Phase 5C-5

A loopback development diagnostic can call the same Firebase path when `VITE_NOTICELENS_REAL_CLOUD_DIAGNOSTIC` is exactly `1`. It is not available in the production build, and a URL or localStorage value cannot enable it. One Chrome run on 127.0.0.1 reached `firebasevertexai.googleapis.com` once, with HTTP 200, and the parsed body contained the approved canonical v2 string without the raw notice markers. The model JSON was rejected because the reply template matched the greeting identifier pattern. That draft was not shown. Missing and invalid App Check headers on that URL returned HTTP 403. Console enforcement is still unconfirmed because the Firebase CLI token refresh returned 400. A held second request aborted with `net::ERR_ABORTED`. `CLOUD_SUBMISSION_ENABLED` stays false. R5-2, R5-3, R5-4, and R5-5 stay open. £1,280 and £520 stay independent, and the comparison does not establish a recovered £760.

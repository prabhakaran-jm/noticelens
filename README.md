# NoticeLens

**Understand the notice. Know your next step.**

NoticeLens is a privacy-conscious hybrid AI web app for fictional UK electricity notices. It keeps the first reading on the device, links actions to the notice text, compares a second notice without treating the two amounts as one verified debt, and can prepare an approved response brief. Optional cloud drafting is a separate step. It is not available from the production Send control.

NoticeLens explains a household notice. It does not decide what someone legally has to pay, and it does not promise a financial outcome.

## What you can do

The app has four screens: Read the notice, Action plan, Prepare a reply, and Compare an update.

1. **Read on this device.** Paste notice text or load a synthetic sample. On a supported desktop Chrome setup, **Read on this device** calls Firebase AI Logic with `InferenceMode.ONLY_ON_DEVICE`. The result is kept only when the runtime `inferenceSource` is `on_device`. There is no silent cloud fallback for that reading.
2. **Check the actions.** Local code compares extracted quotes with the notice and withholds amounts or dates that the text does not support. An action is source-linked. It is not a legal determination.
3. **Prepare a brief.** The reply screen builds a redacted structural brief. The privacy review shows the exact payload. The cloud brief uses a closed v2 schema with no free-text fields: category, ISO dates, amounts, action IDs, goal and guidance IDs. Notice prose, names, addresses and account references are not fields in it. The brief still contains the notice's amounts and dates.
4. **Compare an update.** A revised notice stays beside the original. For the two samples below, the app says the relationship needs review and shows no verified change.

If this browser has not made an on-device model available, Read stays in Limited Mode. Amounts, dates, and quotes then come from local checks. The notice is not sent to a cloud model to fill that gap.

The production screen says cloud sending is disabled. `CLOUD_SUBMISSION_ENABLED` is fixed `false`. No URL parameter, localStorage value, or production build turns Send on.

## Synthetic notices

Both files in `examples/` are fictional.

| File | Amount |
| --- | --- |
| `examples/energy-backbill-original.txt` | £1,280 |
| `examples/energy-backbill-revised.txt` | £520 |

They are separate notices. The comparison does not verify that one replaced or settled the other, and it does not show a recovered £760.

## Recorded on-device Read

On 20 November 2026, one Read of the £1,280 sample ran in Chrome `158.0.8127.36` through Firebase AI Logic `ONLY_ON_DEVICE`.

- The runtime source was `on_device`.
- Structured extraction passed, and the NoticeLens screen accepted the result.
- The browser context under test made no cloud-generation request. That observation covers that context only. It does not prove every Chrome process was offline.
- The Read took about 56.7 seconds.

That machine had Chrome’s experimental Gemma 4 built-in AI flag enabled, and component `2026.11.3.1140` was installed. Those are configuration facts. The Read receipt did not name the model that answered. This is not verification of Gemini Nano 4. The Gemma 4 flag is not a requirement for every user.

Firebase’s hybrid web guide requires the Firebase AI Logic JavaScript SDK 12.5.0 or newer and desktop Chrome 139 or newer for on-device inference. This repository depends on `firebase` `^13.3.0`. On-device inference uses Chrome’s Prompt API. The model has its own hardware and storage requirements, and it is downloaded separately from Chrome. JavaScript cannot ask Chrome for the installed model version.

## Recorded cloud draft

A separate local diagnostic on the same day, not the same session, sent one approved brief.

- Mode: `ONLY_IN_CLOUD`.
- Model label: `gemini-3.5-flash-lite`.
- HTTP 200. Runtime source: `in_cloud`.
- The request matched the approved canonical v2 brief, and `cloudOutputGuard` accepted the draft.
- Exactly one generation. A registered App Check debug token was used on loopback.
- Production Send stayed disabled.

That diagnostic is development-only. It runs only when `VITE_NOTICELENS_REAL_CLOUD_DIAGNOSTIC` is `1`, the build is a Vite dev build, and the host is loopback. A URL or localStorage value cannot enable it. The authorised run has already been made. This README does not include a command to repeat it.

## Setup

Judging steps are in [How to judge NoticeLens](docs/JUDGING.md).

Use Node.js 24.12 or newer. The Firebase 13 packages used by this project declare Node.js 24.12.0 or newer as their minimum supported runtime. npm comes with Node.js.

```bash
npm ci
copy .env.example .env.local
npm run dev
```

`npm run dev` serves the app at `http://127.0.0.1:5173`. On macOS or Linux, use `cp .env.example .env.local`.

The local screens run without Firebase config. Only for the optional on-device Read, put your own Firebase web config in the untracked `.env.local`. The names in `.env.example` are:

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_APP_ID`
- `VITE_FIREBASE_APPCHECK_SITE_KEY`

Leave `VITE_NOTICELENS_REAL_CLOUD_DIAGNOSTIC` empty for the normal app. Do not commit `.env.local`, an App Check debug token, or a service account. App Check is required before a cloud call. For local development, register a debug token in the Firebase console for the judge’s own project and keep that value only in the untracked env file. This README does not contain a token or a key.

Checks:

```bash
npm test
npm run typecheck
npm run build
```

`npm test` runs Vitest. `npm run typecheck` runs `tsc --noEmit`. `npm run build` typechecks and writes a production bundle. The production bundle does not enable the dev diagnostic, and it does not enable Send.

## Three ways to run it

- **Normal app.** `npm run dev`, then Read, the action plan, and Compare. Cloud Send stays off.
- **Dev-only diagnostic.** A loopback dev process can be opted into one real cloud call. Production builds omit that path. The recorded call above is the consumed authorised run.
- **Production-disabled Send.** `CLOUD_SUBMISSION_ENABLED` is `false as const`. The reply screen tells the user that cloud sending is disabled.

## Limitations

- Gemini Nano 4 has not been verified. An `on_device` receipt does not name the Chrome model.
- On-device Read needs a desktop Chrome build and an installed Prompt API model. Hardware, disk space, and model availability can block it. Limited Mode does not send the raw notice to the cloud.
- The accepted cloud draft exists only as that local diagnostic. It is not a hosted or production drafting service.
- R5-2, R5-3, R5-4, and R5-5 remain open. Local checks can miss names, addresses, and account details. They do not prove that personal information was removed. The user still has to review the exact brief and any draft.
- NoticeLens does not recover money and does not decide a legal right.

## Repository

```text
examples/     fictional notices
src/          app, Firebase adapters, and domain checks
tests/        Vitest suites
scripts/      local Chrome diagnostics
docs/         design notes; some sections still describe earlier plans
assets/       hackathon thumbnail
```

## Licence

MIT. See [LICENSE](LICENSE).

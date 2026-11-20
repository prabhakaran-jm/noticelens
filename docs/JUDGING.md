# How to judge NoticeLens

NoticeLens is a privacy-conscious hybrid AI web app for fictional UK electricity notices. Local reading, source-linked actions, comparison, and an approved response brief are in the app. Optional on-device Read is separate from cloud drafting. Production Send is disabled. NoticeLens does not decide what someone legally has to pay, and it does not promise a financial outcome.

The licence is MIT. See [LICENSE](../LICENSE).

## Prerequisites

- Node.js 24.12 or newer, and npm.
- A desktop browser for the local screens.
- Desktop Chrome 139 or newer, and a Prompt API model already downloaded in that Chrome profile, only if you choose the optional Read. Hardware, disk space, and model availability can block that Read. This repository does not claim that the model is Gemini Nano 4.

There is no hosted app URL.

## Clone and run without credentials

The clone URL is `https://github.com/prabhakaran-jm/noticelens.git`. It can be used only after the owner publishes the repository.

```bash
git clone https://github.com/prabhakaran-jm/noticelens.git
cd noticelens
npm ci
npm run dev
```

`npm run dev` serves the app at `http://127.0.0.1:5173`.

Leave `.env.local` absent for local exploration. The four screens, the two fictional notices, the action plan, the comparison, and the disabled reply brief do not need Firebase credentials.

## The two notices

| File | Amount |
| --- | --- |
| `examples/energy-backbill-original.txt` | £1,280 |
| `examples/energy-backbill-revised.txt` | £520 |

They are separate fictional notices. The comparison says the relationship needs review. It does not show a verified change, and it does not show a recovered £760.

## What you can check with no model

- **Limited Mode.** If this browser has not made an on-device model available, Read stays in Limited Mode. Amounts, dates, and quotes then come from local checks. The notice is not sent to a cloud model to fill that gap.
- **Source-linked actions.** The action plan keeps an action only when the notice text supports it. An action is not a legal determination.
- **Closed v2 brief.** Prepare Reply shows a closed v2 schema with no free-text fields: category, ISO dates, amounts, action IDs, goal and guidance IDs. Notice prose, names, addresses, and account references are not fields in it. The brief still contains the notice's amounts and dates. Local checks can miss identifiers. They do not prove that personal information was removed.
- **Send stays off.** `CLOUD_SUBMISSION_ENABLED` is fixed `false`. The Send, copy, and download controls stay disabled. No URL parameter, localStorage value, or production build turns Send on.

## Optional on-device Read

This step is optional. It uses your own Firebase project, not the owner's project. Copy `.env.example` to `.env.local` and set only:

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_APP_ID`

Leave `VITE_NOTICELENS_REAL_CLOUD_DIAGNOSTIC` empty. Do not put an App Check debug token in the repository. This page does not include a command that starts a model generation.

When you choose Read in the app, the call uses `InferenceMode.ONLY_ON_DEVICE`. The result is kept only when `inferenceSource` is `on_device`. There is no silent cloud fallback. A browser that cannot run the model stays in Limited Mode. If Chrome reports the model as downloadable, Read can start Chrome's model download on this device.

`on_device` and `in_cloud` are different receipts. The ordinary app does not produce `in_cloud`.

## Recorded tests

These are two separate tests from 20 November 2026. They are not one session, and this judging setup does not rerun them.

- **On-device.** One Read of the £1,280 sample in Chrome `158.0.8127.36`, through `ONLY_ON_DEVICE`. The runtime source was `on_device`. Structured extraction passed, and the screen accepted the result. The Read took about 56.7 seconds. No cloud-generation request was observed in that browser context. The model that answered was not named. That is not verification of Gemini Nano 4.
- **Cloud.** A separate, earlier loopback diagnostic used `ONLY_IN_CLOUD` and `gemini-3.5-flash-lite`. It returned HTTP 200 with `inferenceSource` `in_cloud`. The request matched the approved canonical v2 brief, and `cloudOutputGuard` accepted the draft. Production Send stayed disabled.

A judge cannot reproduce those two results from the repository alone. A Limited Mode browser is not the recorded Chrome 158 Read.

## Commands to leave unused

These are owner-only diagnostic scripts and are not required for judging. Do not run them. They can download a model, modify local Chrome profiles, or make a new cloud generation against the Firebase project configured in `.env.local`:

- `npm run verify:approved-cloud`
- `npm run verify:chrome`
- `npm run verify:gemma4`
- `npm run test:real-chrome`
- `npm run chrome:dev-profile`

## Checks

```bash
npm test
npm run typecheck
npm run build
```

`npm test` runs Vitest. At the application revision documented here, the suite is 1150 tests in 51 files. `npm run typecheck` runs `tsc --noEmit`. `npm run build` typechecks and writes a production bundle. The production bundle does not enable the dev diagnostic, and it does not enable Send.

## Limitations

- Gemini Nano 4 has not been verified. An `on_device` receipt does not name the Chrome model.
- On-device Read needs a desktop Chrome build and an installed Prompt API model. Limited Mode does not send the raw notice to the cloud.
- The accepted cloud draft exists only as that separate local diagnostic. It is not a hosted or production drafting service.
- R5-2, R5-3, R5-4, and R5-5 remain open. The user still has to review the exact brief.
- NoticeLens does not recover money and does not decide a legal right.
- The earliest recorded commit in this repository is 12 November 2026. That date is the earliest commit this history contains. It is not proof that nothing existed earlier.

Further description is in the [README](../README.md). The architecture note is [docs/ARCHITECTURE.md](ARCHITECTURE.md). The product brief is [docs/PRODUCT.md](PRODUCT.md). A storyboard for a future video, which is not itself a video, is [docs/DEMO.md](DEMO.md).

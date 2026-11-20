# NoticeLens — Product brief

This brief describes the implemented local app. Production Send is disabled. The two recorded tests in [docs/ARCHITECTURE.md](ARCHITECTURE.md) are separate, and judging steps are in [docs/JUDGING.md](JUDGING.md).

## User problem

A UK household receives a dense housing, council or utility notice. The recipient needs to know what the notice requires, by when, and why, and how to respond. Users may not want to upload names, addresses and account numbers to cloud AI.

## Primary scenario

The bundled files are fictional.

- `examples/energy-backbill-original.txt` states £1,280.
- `examples/energy-backbill-revised.txt` states £520.

They stay separate. The comparison says the relationship needs review and shows no verified change. It does not show a recovered £760. A lower amount in the second file is not evidence that NoticeLens contested a real bill.

NoticeLens links actions to the notice text, shows a closed v2 brief for review, and can Read on a supported desktop Chrome setup with `ONLY_ON_DEVICE`. The ordinary app does not draft in the cloud.

## What the app does

- [x] One recorded Read used Firebase AI Logic with `ONLY_ON_DEVICE` and kept the result only for `inferenceSource` `on_device`.
- [x] That receipt used the string `on_device`. It did not name the Chrome model, and it is not verification of Gemini Nano 4.
- [x] Action cards are source-linked. Amounts or dates the text does not support are withheld.
- [x] Deadline and amount behaviour is covered by the Vitest suite, 1150 tests in 51 files at the revision this note accompanies.
- [x] The privacy review shows the exact closed v2 brief: category, ISO dates, amounts, action IDs, goal and guidance IDs. Notice prose, names, addresses, and account references are not fields. The brief still contains the notice's amounts and dates.
- [x] A separate earlier diagnostic used `ONLY_IN_CLOUD`, returned HTTP 200, reported `in_cloud`, and passed canonical v2 and `cloudOutputGuard`. Production Send stayed disabled.
- [x] The cloud brief has no raw notice prose and no local identifier map. Local checks can still miss an identifier.
- [x] Limited Mode stays on when the browser has no on-device model. It does not send the notice to the cloud.
- [x] The bundled notices are fictional, so the local app can be tried without a real customer's personal data.

## What the app does not do

- [x] The comparison does not treat £1,280 and £520 as one verified change.
- [x] The user cannot send, copy, or download a cloud reply from the production screen. Send is fixed off.
- [x] The user does not receive an editable cloud draft from the ordinary app, because that app does not generate one.

## Out of scope

- Automated legal determinations or guaranteed rights checks
- Automatic sending of email or letters
- Medical or clinical document handling
- A native Android app
- A claim that every identifier is detected
- A claim that Gemini Nano 4 answered the recorded Read

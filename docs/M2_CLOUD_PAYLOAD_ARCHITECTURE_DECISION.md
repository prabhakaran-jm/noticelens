# M2 cloud payload architecture decision

**Status: design only. Not implemented. Not a product screen.**

This note was written against `main` at `179506917bb3d5425ac5d0c52202255c1ec4ee83` (merged pull request 6). It does not change runtime behaviour. `CLOUD_SUBMISSION_ENABLED` stays `false`. Live cloud drafting stays disconnected.

## Decision

Send **option B**: a closed structured brief, on a new schema version `noticelens.cloud-brief.v2`.

Keep the useful part of option C **outside** the payload. A fixed local table maps each `ActionSummaryId` to one short sentence. That sentence is shown in the inspection screen and repeated in the trusted portion of the prompt. It is not copied from the notice, and it is not a field inside the fenced JSON.

Do not keep option A. Do not put option C's sentences into `redactedClause` on `noticelens.cloud-brief.v1`.

A closed payload does not fix grounding errors. If local code marks a settled, negated, quoted, or prompt-injected figure as a current amount or action, v2 will still carry that mistake in `amountsGBP`, `responseDeadlines`, or `actionSummary`.

## What the code does today

`CloudBoundStructuralPayload` in `src/domain/types.ts` is `noticelens.cloud-brief.v1`. Each obligation is an `ActionSummaryId`, an ISO `dueDate` or null, and a `redactedClause` string. `canonicalCloudPayload` in `src/domain/cloudPayloadGuard.ts` accepts only that schema. It allowlists keys, bounds the clause to 4–220 characters, and runs pattern checks. Those checks do not prove that personal information was removed (`CLOUD_PAYLOAD_REDACTION_LIMITATION`).

`redactAndBuildBrief` copies a verified `sourceQuote` into `redactedClause` after local redaction. It refuses the brief when no quotation has `supports_claim`. `cloudBriefBuilder` can replace that string from `clauseReplacements` before validation. The privacy modal therefore reviews a free-text field that began as notice prose.

`buildCloudDraftPrompt` fences the whole serialized JSON as untrusted data, then asks Gemini for options and a reply that may use the canonical placeholders. `validateCloudDraftOutput` rejects unexpected keys, non-canonical placeholders, guidance ids outside the approved set, and a narrow set of legal-conclusion phrases. It does not yet reject invented identifiers. `runCloudDraftFromApprovedPayload` uses `InferenceMode.ONLY_IN_CLOUD` and is not wired to the production screen. Production approval lives in `src/adapters/privacyApproval.ts`, not in a domain `privacyApproval.ts`. There is no domain file of that name. The production send path still throws. `SpikeHarness` can self-approve and is not the production route.

`docs/ARCHITECTURE.md` already says the cloud payload should be an approved notice type, dates, minimally necessary redacted clauses, a response goal, and curated guidance, and that it must not include the raw document or the local identifier map. `docs/PRODUCT.md` requires the user to see the exact structural payload before any cloud call, and it forbids treating the product as a legal determination.

## Comparison

| Question | A — current v1 brief | B — closed v2 brief | C — template text inside v1 `redactedClause` |
| --- | --- | --- | --- |
| Privacy leakage | Highest. Redacted quotations can still carry missed names and references (R5-2, R5-4). Amounts and dates are also present. | Lowest on the wire. No notice prose and no placeholder tails. Amounts, dates, category, and ids remain. | Better than A only while every string is a template. The field is still free text, so a later edit or `clauseReplacements` entry can put the notice back. |
| Grounding accuracy | Wrong `supports_claim` results are copied as quotations and as numbers. | Wrong `supports_claim` results are still copied as numbers, dates, and action ids. The mistake is easier to see and test. | Same as B, plus the wrong fact can be repeated inside the sentence. |
| Prompt injection | A quotation, including Q3's unquoted injected line, sits inside the fenced JSON. The fence is not a proof against instruction-following. | The fenced JSON has no notice sentences. Injection has to survive as a closed enum, number, or date. | A template is safe. A string that merely looks like a template is not. v1 cannot tell them apart. |
| Schema compatibility | Matches `canonicalCloudPayload` today. | Requires v2. v1 must be rejected at the send boundary. | Runs on today's validator, which is the hazard: any 4–220 character string that passes the patterns is accepted. |
| Existing M1 tests | Stay green. | Payload fixtures, redaction-to-brief tests, and approval tests must split local redaction from the outbound shape. | Many clause-string assertions fail or, worse, keep passing while the field no longer means "redacted quotation". |
| Draft quality | Highest fidelity to the notice's wording, including its errors and injections. | Usable for the synthetic energy demo: goal, guidance, amount, period, and deadline are enough for a conditional reply. Less able to mirror unusual wording. | Similar to B if the templates stay generic. No better than B once the sentences are a pure function of the action id. |
| User inspection | The user sees notice-like sentences and can miss a residual identifier. | The user sees a short closed record. The local screen still shows the source quotation separately, labelled as local-only. | The inspection row still says "clause" and can be mistaken for the source. |
| Complexity | None now. The open R5 gates stay on the send path. | One schema, one builder, one prompt map, and a test split. | Looks smaller, then leaves a permanent free-text slot to police. |
| Demo value | The local demo already works without a cloud call. A cloud letter would sound specific and could repeat a bad quotation. | The local demo stays as it is. A future cloud letter can still ask for a review of the stated balance and cite only approved guidance. | Same demo, with a field name that no longer tells the truth. |

## Why B is the safer design

Option A keeps a channel that R5-2, R5-3, R5-4, and Q3 have already crossed: notice text, after incomplete redaction or incorrect verification, becomes model input.

Option C's sentences do not add a fact that v2's closed fields do not already contain. `actionSummary` selects the sentence. `amountsGBP`, `responseDeadlines`, `billingPeriod`, and `responseGoal` carry the grounded values. Putting the sentence in the payload creates a second copy that can drift, and it keeps a string slot in the untrusted JSON. The current `clauseReplacements` path shows how easily that slot accepts caller text.

The sentence still helps the model and the person reviewing the brief. Generate it in trusted code from `actionSummaryLabel` and a fixed table, show it beside the payload, and place the table in the prompt **above** the untrusted fence. The fenced object then has nothing to quote from the notice.

A real schema version change is required:

- `canonicalCloudPayload` rejects every `schemaVersion` other than `noticelens.cloud-brief.v1`.
- v1 requires `redactedClause` on every obligation.
- A v2 object that omits `redactedClause`, or that renames the obligation array, is an unknown shape to that function.
- Leaving the sentences in v1 would let old and new callers share one free-text field. The send path must reject v1 so a redacted quotation cannot be offered as a v2 brief.

v2 should allow only: `schemaVersion`, `noticeCategory`, `issueDate`, `billingPeriod`, `amountsGBP`, `responseDeadlines`, `obligations` (`actionSummary`, `dueDate`), `responseGoal`, `guidanceIds`, and optional `circumstanceFlags`. No `redactedClause`. No raw notice. No local identifier map. No placeholder tokens. Unknown keys stay illegal.

## What a structured payload does not fix

- **R5-3, hard gate.** H2, I2, and J2 can still verify paid-in-full, written-off, or waived statements in separate sentences. S1–S3 can leave a neighbouring sentence verified. Thirteen of nineteen settlement and negation paraphrases can still verify. A quoted "cancelled" can bypass disposition. Q3 can put an unquoted prompt-injected £9,999 into the brief. A truncated quotation without an ellipsis can verify. v2 will forward whatever local grounding marked `supports_claim`. Closing the schema is not closing R5-3.
- **R5-2 and R5-4.** They remain mandatory before any cloud send that still contains notice prose, placeholder tails, or restored identifiers. v2 removes that prose from the brief. It does not remove them from local redaction, the on-screen notice, or reply restoration. Fullwidth and accented salutations (Zoë Brontë, Siân Jones, José García, Chloé O'Brien) and `Sarah_1`, `SMITH_44`, and `Example99` are still open. U+2044, U+2215, comma, plus, tilde, and asterisk can still leak. Those leaks block any path that sends residual notice text. They do not become safe just because v2 exists.
- **R5-5.** The production app currently passes one guard-option object through build, inspection, approval, and the blocked pre-send check. Domain functions can still take an altered or empty forbidden-identifier list. Approval records are mutable. Identifiers shorter than three characters may be dropped. v2 does not create a private immutable approval registry. A live send still needs that registry and a fresh check against the current identifiers.
- **N-5.** Nonstandard placeholders are an output and restoration problem. v2 should not contain placeholders. The reply template still can, and the output guard must keep rejecting anything outside the canonical set.
- **Legal conclusions and invented identifiers.** `cloudOutputGuard` blocks a few definitive phrases. It does not yet block invented account numbers or names in the reply. That check stays a cloud-activation blocker.
- **App Check and genuine `ONLY_IN_CLOUD`.** The drafter already selects `InferenceMode.ONLY_IN_CLOUD` and requires an in-cloud `inferenceSource`. App Check, a real Chrome request-body inspection, and a displayed source that matches the call are still unmet. `SpikeHarness` must not become the production caller.
- **Local restoration.** The identifier map stays in the browser. Restoration happens after the draft returns. The cloud brief must not contain the map or the raw values.

## Code that can stay

- Category, goal, guidance, circumstance, and action-summary allowlists in `src/domain/types.ts`.
- `GUIDANCE_IDS_BY_CATEGORY` and the Ofgem excerpt builder. The excerpt is curated publisher text, not notice text. It stays in the trusted prompt.
- Quote grounding, amount classification, and `briefSourceFromGrounded`. They decide which closed fields are eligible. They need the R5-3 fix before those fields are sendable.
- Local redaction and the identifier map, for on-screen preview and later restoration, not for the outbound brief.
- `fenceUntrustedData`, output placeholder checks, legal-conclusion checks, single-use consumption of an approval id, and the production rule that approval does not call `CloudPayloadApproval.begin`.
- `CLOUD_SUBMISSION_ENABLED = false` and the disabled production send control.

## Files that must change when this is implemented

Do not change them in the design step.

- `src/domain/types.ts` — add the v2 payload type. Keep v1 only as a rejected historical shape, or stop constructing it.
- `src/domain/cloudPayloadGuard.ts` — validate v2, reject v1 at the send boundary, reject `redactedClause`, and keep the key allowlist.
- `src/domain/redactAndBrief.ts` — stop writing source quotations into the sendable brief. Keep local redaction for the preview.
- `src/adapters/cloudBriefBuilder.ts` — build v2 from grounded fields only. Remove `clauseReplacements` from the outbound object. Inspection rows show closed fields plus the trusted sentence, labelled as not a quotation.
- `src/ai/cloudDrafter.ts` — put the action-id sentence table in the trusted prompt. Fence only the v2 JSON. Keep `ONLY_IN_CLOUD`. Do not connect this to the production button in the same change.
- `src/domain/cloudOutputGuard.ts` — keep current checks. Invented-identifier checks are a later gate, not a reason to put notice text back.
- `src/adapters/privacyApproval.ts` — bind approval to the v2 bytes. The R5-5 registry is a separate gate and is not satisfied by a schema bump.
- Production privacy UI — show the exact v2 serialization the user would approve. Keep source quotations on the local notice screen only.
- `src/fixtures/benchmarkNotices.ts` — the M0 cloud fixture must match v2 once tests move over.

Do not change Firebase config, dependency versions, App Check setup, `gemini-3.5-flash-lite`, or `CLOUD_SUBMISSION_ENABLED` as part of the schema work.

## Tests that must change

Keep local redaction, name, and reference tests. Change the tests that treat a source quotation as the cloud field.

- `tests/unit/cloudPayloadGuard.test.ts` and `tests/unit/cloudPayloadRevalidate.test.ts` — v2 accept path; v1 and `redactedClause` rejected; unknown keys rejected.
- `tests/unit/redactAndBrief.test.ts`, `tests/unit/reviewProbes.test.ts`, and `tests/unit/m2b2bPipeline.test.ts` — assert the serialized brief contains no source sentence and no detected identifier. Keep asserting that local preview redaction still runs.
- `tests/unit/categoryAndApproval.test.ts` and `tests/unit/cloudBriefAndApproval.test.ts` — approval bytes are the v2 serialization. Edited notice text still invalidates approval.
- `tests/unit/groundNoticeFacts.test.ts` — keep the R5-3 cases failing closed. Add an assertion that a not-`supports_claim` amount is absent from the v2 `amountsGBP` array. Do not delete the cases that show the gate is still open.
- Benchmark and drafter tests that embed `M0_SMOKE_TEST_CLOUD_PAYLOAD`.

A new test must fail if a v2 obligation string, if any is ever reintroduced, contains a substring of the source quotation other than a grounded amount or ISO date that already appears in its own field.

## How the demo stays functional

The production demo does not need a cloud round-trip. On-device or manual extraction, grounded action cards, the Ofgem card, the £1,280 to £520 comparison, and the local reply editor already run with cloud submission off. v2 does not remove those screens.

When a cloud draft is eventually allowed, the synthetic notice still supplies a category, a billing window, £1,280, a deadline, and one supported action id. The trusted prompt can ask for a conditional review letter that cites only `ofgem-backbilling-12m-v1` and uses `[RECIPIENT_NAME]`, `[ACCOUNT_REF]`, and `[SUPPLY_ADDRESS]`. Local restoration fills those after the response returns. The user still edits and approves the letter. The product still does not decide that a charge is valid.

Until R5-3 is closed, the demo must not present a cloud draft as verification of the balance.

## Remaining privacy limits

Pattern checks still do not prove that personal information was removed. Amounts and dates can identify a household when combined with other context. The model can invent a name or account number that the brief never contained. Placeholder restoration can put a real identifier into the letter after the call; that letter must not be sent back to the cloud. Unusual names, addresses, and homoglyphs remain local-detection limits. Soft-hyphen joins and standards-shaped tokens such as `Form-1040` remain availability false positives on the local redactor. None of those are solved by deleting `redactedClause`.

## Smallest path to a real cloud call

Each phase is NO-GO for live submission until every gate in that phase passes. `CLOUD_SUBMISSION_ENABLED` stays `false` through Phase 4.

### Phase 0 — this note

Design only. No runtime change. **NO-GO.**

### Phase 1 — local v2 builder, send still impossible

Build the closed object beside the current preview. Do not call Firebase. Tests show the serialized v2 JSON has no source quotation, no placeholder, and no known identifier, and that unsupported amounts are absent.

**GO** to Phase 2 only if those tests pass and the production button still cannot send. **NO-GO** if any builder path copies `sourceQuote` or `clauseReplacements`.

### Phase 2 — inspection and approval of v2 bytes

The privacy screen shows the exact v2 serialization and the trusted sentence, marked as a label rather than a quotation. Approval stores those bytes and still refuses to send. v1 is rejected by the send validator.

**GO** to Phase 3 only if changing one byte, or restoring an old generation, invalidates approval, and the send control remains disabled. **NO-GO** if the user can approve a payload they did not see.

### Phase 3 — R5-3 before any current-fact field is eligible

Repeat the H2, I2, J2, S1–S3, 13-of-19, quoted-cancelled, Q3, and no-ellipsis cases. A case that still verifies must not appear in v2 `amountsGBP`, `responseDeadlines`, or `obligations`.

**GO** to Phase 4 only if those reproductions fail closed and a genuine current £1,280 with its deadline still appears. **NO-GO** if the schema is treated as a substitute for that result. This phase does not by itself authorize a network call.

### Phase 4 — R5-5 registry

Add a private immutable approval record and revalidate the current snapshot against the current identifier set immediately before the still-disabled send. Reject altered or empty forbidden-identifier options on that path. Do not take the in-flight cloud lock during approval.

**GO** to Phase 5 only if a mutated record cannot be reused and a second use of the same id fails. **NO-GO** if caller-supplied "already validated" flags are trusted.

### Phase 5 — network prerequisites, still a separate enablement

App Check in a supported mode, a real `ONLY_IN_CLOUD` call whose `inferenceSource` is `IN_CLOUD`, Chrome inspection of the request body against the approved v2 bytes, output checks for legal conclusions and invented identifiers, and N-5 placeholder enforcement on the reply. R5-2 and R5-4 must be closed for any string that is still notice-derived, including restored reply text that would be sent onward. `SpikeHarness` stays off the production route. Google Fonts, CSP, and the dependency audit stay on the demo-readiness list.

**GO** for one explicit, reviewed change that sets cloud submission on, only after this phase is reviewed on its own. **NO-GO** for flipping the flag inside the v2 schema change.

## What this note does not do

It does not implement v2, edit tests, change Firebase, change dependencies, enable cloud sending, or open a pull request.

## Phase 5C-4, current code

The closed v2 brief is now the production inspection payload. Phase 5C-4 is the first wiring of that payload to the existing Firebase AI Logic drafter. The production switch is still off.

On-device reading and cloud drafting are different calls. On-device reading uses the on-device Firebase AI entry and does not require App Check. Cloud drafting uses `InferenceMode.ONLY_IN_CLOUD`, the JSON schema already on the drafter, and `getCloudFirebaseAI`, which refuses to start without an App Check site key. The installed package is `firebase` 13.3.0. The reported cloud source is `in_cloud`. A test double can stand in for the SDK. The production build does not pass that double.

The fixture boundary is the two exact synthetic notices. The goal is `request_billing_review` with no flags. The reply screen says the demo is synthetic-fixture-only. Consent is the privacy modal's exact bytes. The send reads those bytes once, consumes the Phase 4B approval, and wraps that same string. It does not take a caller-supplied payload.

The network gate is the client preflight plus Firebase App Check. The preflight is local. App Check is Firebase's attestation of the app, not a NoticeLens server checking every amount. This repository does not put a server-side source check on the Firebase AI request. A server that accepted only the two fixtures would be a different design. The in-flight lock lasts until delivery stops. Aborting the call does not prove the HTTP request has settled. The timeout is the existing 20 second default, capped at 60 seconds. Output validation reuses `cloudOutputGuard`. A currency or "pounds" token includes its fraction. The same check does not catch every monetary expression, personal-data expression, unrecognised identifier, date, URL, or promise. Copy and Download stay off.

What stays blocked until a real Chrome capture and a separate review: the production flag, Send without a test probe, `requestClosedBriefSend`, `requestCloudSubmission`, and any claim that the comparison or a cloud draft verifies £760. App Check enforcement on the selected project and the real Chrome capture stay pending. Production Send stays disabled. R5-3, R5-2, R5-4, and R5-5 stay open.

## Phase 5C-5, current code

The production switch is still off. A development loopback diagnostic, opted in with `VITE_NOTICELENS_REAL_CLOUD_DIAGNOSTIC=1`, uses the same frozen-bytes drafter and the real Firebase AI Logic SDK. It does not accept caller-supplied notice text. One Chrome session sent one generation request to `firebasevertexai.googleapis.com` and received HTTP 200. The parsed body contained the approved canonical string and the fixed brief label, and it excluded the raw synthetic markers. The guard rejected the model JSON for a greeting-shaped identifier in the reply template, so Prepare Reply did not show a draft. Replays that omitted the API key and app ID returned HTTP 403. That result is inconclusive and is not App Check enforcement. The Firebase CLI could not refresh its token (`POST /oauth2/v3/token` returned 400), so console enforcement was not read. The second, held request aborted in the browser with `net::ERR_ABORTED`. Server-side fixture enforcement is still absent. R5-2, R5-3, R5-4, and R5-5 stay open. The two balances stay independent and unverified against each other.

## Phase 5C-6, current code

The production switch is still off. The output guard's greeting check is an allowlist of "Dear Sir or Madam", "Dear Sir/Madam", and "Dear Customer Services". Any other words after Dear fail closed. The other identifier, money, date, legal, guidance, and placeholder checks are unchanged. The prompt asks for that one salutation and forbids invented names. A further live generation was not run, so accepted-draft verification is NOT TESTED. App Check enforcement on the console remains unread. A 403 that omits the API key or app ID is not enforcement evidence.

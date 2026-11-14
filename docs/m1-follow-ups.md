# NoticeLens follow-ups after Milestone 1

This note is not a product screen. Milestone 1 stays on the deterministic domain core and the security fixes already on `feat/m1-deterministic-domain-core`. N-1 and N-2 are fixed for the reproductions named below, and M2A-2 is fixed in the Milestone 2A follow-up. M2B-1a is fixed for the soft-hyphen reproduction Z6. M2B-2A records a local approval lifecycle and the K3/K5 cases that were tested, and R5-1 is fixed for the short digit tails named below. M2B-2B records partial local checks for R5-2, R5-3, R5-4, and R5-5. Independent review of `42b443c` shows those four items are not resolved. Each remains a mandatory gate before live cloud submission. R5-3 is also a hard gate before any product-demo recording. Live cloud submission stays closed. These notes do not claim that personal data is guaranteed to have been removed.

Independent review of `5f2f9d0` is **merge with documented deferments**. O10 nested placeholders and the name-component substring false positives are verified fixed. `npm test` passed 83/83, and typecheck and build passed. The additional regressions below are not reachable through the shipped UI. Recording them is not a claim that personal data is guaranteed to be removed. Pattern checks do not prove that.

## Documented deferments from the `5f2f9d0` review

### N-1 Contextual name leakage — fixed for the documented cases

`isAmbiguousDomainUse` used a surrounding text window rather than the exact occurrence. A known personal name such as Bill or Energy could survive redaction and validation when a nearby sentence contained a domain phrase. Reproductions M07–M09. Severity was Medium.

Milestone 2A checks the matched token itself. Those documented cases are fixed: a person named Bill or Energy is protected when the name stands alone, including beside “bill” or “energy supply”, and ordinary phrases such as “billing”, “annual”, “problem”, and “energy billing” are not treated as those names. This is not a claim that every personal identifier is removed.

### N-2 Compact name matching regression — fixed for the documented cases

Known names containing zero-width characters or letter spacing could bypass the final cloud guard because the compact-name check was skipped for some name cases. Reproductions G16, G19c, Z1, Z2. Severity was Medium.

Milestone 2A restores that compact check for those reproductions. Later reproductions Z4 and Z8 are a separate gap; see M2A-1. This is not a claim that every personal identifier is removed.

### N-3 Short and compound name limitations

Two-letter names, curly apostrophes, and hyphenated given-name components are not consistently protected. Reproductions M16, M18, M23. Gate: improve detection and document the limitations that remain before a public demo.

### N-4 Common-word over-redaction

Names such as Will or June can corrupt meaningful billing statements. Reproductions M24, M25. Gate: Milestone 2 source evidence and clause accuracy validation.

### N-5 Nonstandard placeholders

Bare or unconventional placeholder forms can remain unblocked. Gate: Milestone 2 copy/download and output validation review.

## Clarifications

- Cloud-output invented-identifier detection still requires strengthening.
- The benchmark still relies on the old short-quote verifier.
- Real-Chrome request-body inspection is mandatory before the public demo.
- N-1 and N-2 are fixed for the reproductions named above. Z4 and Z8 are recorded under M2A-1. The soft-hyphen case Z6 is recorded under M2B-1a. Live cloud submission stays closed.
- No statement in this repository may claim that personal data is guaranteed to have been removed.

## Milestone 2A review

Claude Opus 5.5 reviewed `2ae6cb8` as merge with documented deferments. The follow-up patch on `feat/m2-production-ui` addresses M2A-2. Live notice-to-cloud drafting stays disabled. These notes do not claim that personal data is guaranteed to have been removed.

### M2A-1 — Medium — fixed for Z4 and Z8

Fullwidth and NFD single-name components could bypass identifier matching. Reproductions Z4 and Z8. Milestone 2B-1 uses one NFKC fold for detection, redaction, and the final payload guard, and maps each folded match back to the original span. This is not a claim that every personal identifier is removed.

### M2A-2 — Medium — fixed for the reviewed case

A model-generated action such as “Attend a court hearing about this debt” was shown as an Action Plan heading with a “Verified in notice” badge when the quotation merely occurred in the notice. The heading is now the deterministic action-summary label. That label is verified only when the quotation contains the action words that select it. An exact quote match alone does not confer a verified status. Unsupported model wording is omitted from the action card. Unsupported amounts, unsupported deadlines, and truncated quotations stay unverified.

### M2A-3 — Low — fixed for the capitalisation cases

A capitalised Bill or Energy is protected even when a billing word follows it. Lowercase phrases such as “the bill”, “billing”, “annual”, “problem”, and “energy billing” stay in place. Redaction and the payload guard use the same match.

### M2A-4 — Low

Google Fonts requests go to third-party domains. Prefer self-hosting during production hardening.

### M2A-5 — fixed for model category labels

The notice text selects the category. A model label of electricity does not apply Ofgem guidance to a council-tax notice. If the text supports more than one category, or the model names a category the text does not support, guidance stays general and confirmation is required.

### M2A-6 — Low

Some dates display without explicit evidence labels. Unverified deadline fallbacks need review.

### M2A-7 — Low

Sanitise displayed on-device error messages rather than rendering arbitrary `err.message`.

### M2A-8 — Low

The capability probe initially shows Limited Mode. A control is missing its `aria-describedby` target. A balance increase uses the reduction styling.

### Further notes from the same review

- `npm audit --omit=dev` reports four high findings through Firebase, Firestore, and `@grpc/grpc-js`. Assess the actual exposure before deployment. Dependency versions were not changed in this patch.
- The on-device timeout remains pending.
- Real Chrome request-body inspection is mandatory before a public demo.
- The original Milestone 0 `SpikeHarness` remains in the repository. It is not mounted by `App` and is not the production route.
- The Ofgem prompt uses the three canonical primary placeholders `[RECIPIENT_NAME]`, `[ACCOUNT_REF]`, and `[SUPPLY_ADDRESS]`. Review support for the other canonical bases and indexed placeholders during M2B.

## Milestone 2B-1 review

Review of `857d792` on `feat/m2b-secure-cloud-flow`. Live notice-to-cloud submission stays disabled. These notes do not claim that personal data is guaranteed to have been removed.

### M2B-1a — Soft-hyphen privacy regression — fixed for Z6

A known name such as Sarah Example stayed in the notice, and the final cloud guard accepted it, when U+00AD sat inside one component (`Sar` + U+00AD + `ah`). The shared fold treated that soft hyphen as a Unicode dash and turned it into `-`, so the component no longer matched. Detection, redaction, and the final payload guard now use one fold that removes U+00AD with the other format characters and keeps the original source offsets. Real hyphens in account references and surnames stay hyphens. This is not a claim that every personal identifier is removed.

### Z6d / R5-2 — Normalised name components — not resolved

When a known identifier is successfully detected, its components are taken from the normalised form. A format character inside that detected name no longer drops a component such as `Sarah` or `Example` from `Dear Sar\u00ADah Exam\u00ADple`. The same path covers U+200B and U+2060 inside a detected name, and plain occurrences of those detected components are redacted. Original offsets stay in place. Lowercase `bill` and `energy billing` stay in place when the capitalised name was detected. Those protections do not run for an identifier the detector missed.

Fullwidth and accented salutations remain undetected. Reproductions include Zoë Brontë, Siân Jones, José García, and Chloé O'Brien. Names adjacent to underscores or short digit tails remain insufficiently protected. Reproductions include `Sarah_1`, `SMITH_44`, and `Example99`. This is a mandatory gate before live cloud submission. Do not treat R5-2 as resolved. This is not a claim that every personal identifier is removed. Two-letter names remain under N-3.

### K3/K5 — Partial account-reference leakage — fixed for the tested longer tokens

`Ref SMITH-4471` for recipient John Smith becomes `Ref [ACCOUNT_REF]`, not `Ref [RECIPIENT_NAME]-4471`. The tested labelled and unlabelled forms include a lowercase reference, a Unicode hyphen, and a slash-joined token with at least three digits. A final cloud clause that still contains `[RECIPIENT_NAME]-8472`, or the same digit tail beside any other canonical placeholder, is rejected for those tested shapes. Month labels such as `Nov-2026` are not treated as account references. Surrounding prose and original source offsets stay in place. This is not a claim that every identifier is removed.

### R5-1 — Short digit tails after a known name — fixed

`Ref SMITH-44`, `Smith/7`, `Sarah-1`, and `Example-12` were redacted on `b7384fb` and then escaped both redaction and the final guard. The name-component skip ran whenever digits followed a separator, even when no account span had been detected. A name component is now left in place only when that occurrence sits inside a detected account span. These four tokens are redacted to the recipient placeholder plus the unmatched tail, and canonical validation and edited-clause revalidation reject both the raw token and the partial placeholder. Complete account tokens such as `SMITH-4471` are still replaced as one `[ACCOUNT_REF]`.

### R5-4 — Joined references and placeholder tails — not resolved

Previously tested reference formats remain protected. `SMITH4471`, `SMITH_4471`, `SMITH.4471`, and the same letter-digit form with `:` or `#` are detected as one account reference for those tested shapes. A fullwidth dot is included in that tested set. A canonical placeholder does not hide a numeric tail for `_`, `.`, `:`, `#`, `/`, or `-` on the tested canonical bases, including `[ACCOUNT_REF_2]:8472`. `Nov-2026`, `Nov2026`, `balance2026`, and `billing2026` stay prose in those tests.

Residual separator leaks remain. U+2044, U+2215, comma, plus, tilde, and asterisk can still separate an identifier from a numeric tail. Certain partial-placeholder tails that use these separators are accepted. Those privacy leaks are mandatory blockers before live cloud submission. Some ordinary alphanumeric phrases are rejected when they are not account references. Those false-positive rejections are tracked separately from the leaks. A surname glued to a year, such as `SMITH-2026`, can still be treated as an account reference. R5-6 remains open for `Form-1040`, `ISO-9001`, and `Section-123`. Do not treat R5-4 as resolved.

### Soft-hyphen alphanumeric false positives — remaining limitation

A format character that joins letters to three or more digits is still treated as an account token. That catches hidden references such as `EXAMPLE` + U+00AD + `8472`. It can also flag ordinary text that is not an account reference, for example a word, a soft hyphen, and a number. That false positive remains. It is not solved by a special case for one reference string.

### M2B-1b / R5-3 — Obligation role grounding — not resolved — HARD GATE

R5-3 is a hard gate before live cloud submission or a product-demo recording. Payment-role grounding is not fully resolved. Some single-sentence cases are no longer verified, including “You must pay nothing.”, “Please ignore our request to pay.”, “You do not have to pay.”, and “Thank you for your payment of £1,280.” A genuine outstanding balance can still be verified when the source states it as the current demand. That partial behaviour is not closure.

Independent review of `42b443c` reproduced these failures:

- H2, I2, and J2. “Paid in full”, “written off”, and “waived” in separate sentences can still be verified as a current demand.
- S1–S3. Cancellation, withdrawal, or negation in a neighbouring sentence can leave another sentence verified.
- R. 13 of 19 payment-settlement and negation paraphrases remain incorrectly verified.
- A quoted “cancelled” can bypass the disposition checks.
- Q3. An unquoted prompt-injected £9,999 line can enter the cloud brief.
- Truncated quotations that do not contain an ellipsis may be incorrectly verified.

D4. A conditional late-payment fee can become an unsupported verified obligation. That case is part of this hard gate.

R5-3 remains unresolved and blocks any live cloud submission or product demonstration claiming verified payment obligations. Do not claim that payment-role grounding is fully resolved. Do not enable cloud submission while this gate is open. A structurally valid v2 brief is not a verified payment fact.

At that review, `tests/unit/r5-3KnownFailures.test.ts` had 41 characterization tests. 29 expected the secure outcome and failed it, including D4. 12 already failed closed. Phase 3 later converted the 29 recorded cases to ordinary passing tests. The review finding above is the state before that change. A green suite is still not proof of complete grounding accuracy, and cloud submission stays closed.

### M2B-1c — Approval invalidated on edit — fixed for the local lifecycle

Any relevant edit increments an approval generation immediately. Restoring the previous text does not restore the previous approval. Approval is recorded only from the deliberate review action. Each approval id is single-use: the future send function consumes it and still refuses to call the cloud. A stale callback recorded under an older generation does not match the current generation. The production screen does not call `CloudPayloadApproval.begin`.

### M2B-1d — Approval checked against the current canonical payload — local record only

`recordUserPayloadApproval` requires the exact current canonical serialization and runs `canonicalCloudPayload` on it. Unknown keys, malformed placeholders, and clauses that fail the payload guard are rejected. This record still cannot send.

### R5-5 — Approval guard options — not resolved

The production application currently supplies the same guard options to candidate construction, inspection, approval, and the still-disabled pre-send check. Those options are built from the local identifier map and the user-added private identifiers. The production screen does not call `CloudPayloadApproval.begin`, and `CLOUD_SUBMISSION_ENABLED` stays false.

That production path does not close the gate. Domain functions can still accept an altered or empty forbidden-identifier list. Approval records are mutable. Identifiers shorter than three characters may be ignored. A future live-send path requires a private immutable approval registry and fresh validation against the current identifiers. This is a mandatory gate before live cloud submission. Do not treat R5-5 as resolved. The live cloud-send function is not connected.

### R5-6 — Standards-shaped tokens are an availability issue

Tokens such as `Form-1040`, `ISO-9001`, and `Section-123` can be treated as account references. That can block a legitimate brief. It is an availability problem, not a privacy leak.

### M2B-1e — Ambiguous categories still need a decision

An ambiguous-category notice needs an explicit confirmation, or the product must stay on safe general guidance. A model label alone is not that confirmation.

A local privacy approval records the exact canonical JSON for the current edit generation. An edit invalidates it, including when the text is changed back. That record does not start a cloud send. `CLOUD_SUBMISSION_ENABLED` stays false.

## Milestone 2

Milestone 2 live cloud submission of edited or redacted notices stays blocked. N-1, N-2, M2A-1, M2A-3, M2A-5, M2B-1a, the tested K3/K5 tokens, and R5-1 are fixed for the cases named above. The recorded R5-3 payment-role cases now fail closed. R5-2, R5-4, and R5-5 are not resolved. A local privacy approval records the exact canonical payload for the current production path and does not start a cloud send. Do not enable cloud submission, and do not record a product demonstration, until the remaining items below are closed. A green test suite is not, by itself, proof of complete grounding accuracy.

Phase 1 adds a local closed v2 builder for `noticelens.cloud-brief.v2`. Phase 2 connects Prepare Reply and the privacy approval modal to that builder. The exact canonical bytes are shown without reformatting. Action labels stay outside the JSON and are marked as labels, not quotations. An empty `amountsGBP` array is shown as “Not stated”, never £0. Conditional fees and unsupported actions are labelled unverified. v1 payloads are rejected in that production approval path. Production does not use v1 `clauseReplacements`. The screen says cloud sending is disabled. The choice of the closed brief is recorded in `docs/M2_CLOUD_PAYLOAD_ARCHITECTURE_DECISION.md` (option B). `amountsGBP` means verified outstanding balances only when grounding already supports them. An empty array means no such balance was supported. It does not mean £0. Historical payments, cancelled or withdrawn charges, conditional fees, and ambiguous figures are omitted when grounding already withholds them. Issue dates are not copied into response deadlines. Source quotations, the redaction preview, and the identifier map stay local.

Structural validation does not establish that a payment obligation is correct. Phase 3 applies the payment-claim table below to the recorded R5-3 cases. Those cases are ordinary passing tests. They are not a claim that every unseen notice is grounded, and they do not enable cloud submission.

The closed-schema validator now rejects the Phase 2 bypasses below. That does not enable sending, and it does not close R5-3.

- D1. Getter or Proxy values that are accessors, change between reads, or throw on introspection are rejected. The canonical object is a detached copy, revalidated before it is returned. Mandatory checks are in the validator.
- D2. Inherited required properties and `Object.prototype` values are rejected, including on obligations and billing periods. Own prototype-pollution keys are rejected.
- D3. Duplicate amounts and obligations are rejected. Amounts, deadlines, obligations, guidance ids, and circumstance flags are ordered deterministically. Equivalent payloads produce the same bytes. Array limits remain. Mutating the source array does not change the canonical bytes.

`tests/unit/r5-3KnownFailures.test.ts` started Phase 3 with 41 characterization tests: 29 expected failures and 12 that already failed closed. The 29 recorded cases now pass as ordinary tests and keep the secure outcome. No expected failures remain in that file. Sending stays disabled.

Reviewed corrections on the Phase 2 inspection branch, tested locally:

- N1 is fixed for the tested cases. An on-device result is applied only when its request identity, notice snapshot, and document generation are still current. A result for notice A is discarded after an edit to B, after an edit back to A, and when an older request resolves after a newer one. A discarded result does not update the action plan, the grounded facts, the v2 brief, the inference receipt, or a local approval. A current `on_device` result can update the screen. A current result that does not report `on_device` is still rejected. This does not enable cloud sending.
- N2 is fixed for the tested cases. The review checkbox is bound to the exact canonical bytes, the document generation, and the identifier context. Any of those changing clears the tick, including an edit that returns to the same bytes. The Approve action checks that binding again and does not rely on the button looking disabled. v1 remains rejected. The cloud-send lock is not acquired.
- N3 recorded D4 as an expected failure on the Phase 2 branch. Phase 3 now keeps “A late payment fee of £40 may apply if you do not pay by 25 November 2026.” out of the verified balance, the verified payment action, the response deadline, and the issue date.
- N6. The inspection table names a conditional fee and says it is not the current balance. A verified balance is not given a generic “Amount status: Unverified” label. A payment heading whose only evidence is a conditional fee is marked unverified. An unsupported payment action is named. The v2 schema is unchanged. The Action Plan still uses the local grounding labels.
- N4 remains open. Additional non-index array properties are not rejected.
- N5 remains open. An omitted `guardOptions` argument is still accepted by the approval view.

The recorded R5-3 cases are verified fixed for the sentences in the characterization file. R1 shows conflicting amounts as unverified, says that no current balance is established, and explains an empty `amountsGBP` as no supported outstanding balance. R2 uses a stable claim identity for action labels and does not pair sorted and unsorted actions by list index. R5-5, the immutable domain-owned approval registry, remains a separate mandatory gate and is not started. R5-2, R5-4, N-5, N4, N5, App Check, Chrome request-body inspection, and invented-identifier output checks remain open. This is not cloud readiness. `CLOUD_SUBMISSION_ENABLED` stays false. A green suite is not, by itself, proof of complete grounding accuracy.

These stay tracked and are not implemented here:

- N-5 nonstandard placeholders, and export restrictions while a placeholder is unresolved or malformed.
- On-device inference timeout.
- Category confirmation for ambiguous notices (M2B-1e).
- Cloud-output legal-language and invented-identifier checks.
- Real Chrome request-body inspection before a public demo.
- Google Fonts third-party requests.
- Content Security Policy and the dependency audit.
- Demo-mode removal of the legacy SpikeHarness.
- Soft-hyphen alphanumeric false positives, where a format character joins letters to digits that are not an account reference.
- R5-2: fullwidth and accented salutations remain undetected, including Zoë Brontë, Siân Jones, José García, and Chloé O'Brien. `Sarah_1`, `SMITH_44`, and `Example99` remain insufficiently protected. Mandatory before live cloud submission.
- R5-3 recorded cases: H2, I2, and J2; S1–S3; the recorded settlement and negation paraphrases; a quoted “cancelled”; Q3 unquoted prompt-injected £9,999, including beside a real £520; a truncated quote without an ellipsis; and D4. These fail closed in ordinary tests. Phase 3B adds the 47 novel notices A–Z, including C2, C3, G, H2, K, O, P2, Q, V1–V3, and W1–W6. Negative reinstatement, contracted settlement, conditional charges, cut quotations, and authority-looking lines fail closed. Genuine current balances, including “you owe”, “total to pay”, and “please pay £”, remain when the rest of the notice does not undermine them. One sentence that says “£1,280 or the revised £520” stays ambiguous because the two figures are not separated. A green suite is not proof that every unseen notice is grounded. Live cloud submission stays closed.
- N4 remains open: additional non-index array properties are not rejected by the v2 validator.
- N5 remains open: an omitted `guardOptions` argument is still accepted by the approval view. R5-5, the immutable domain-owned approval registry, remains pending.
- D1: getter or Proxy bypasses are rejected by the v2 validator. This does not enable cloud sending.
- D2: inherited prototype values are rejected by the v2 validator, including nested obligations and billing periods. This does not enable cloud sending.
- D3: duplicate amounts and obligations are rejected, and canonical order is deterministic. This does not enable cloud sending.
- R5-4: residual separator leaks for U+2044, U+2215, comma, plus, tilde, and asterisk, including some partial-placeholder tails. Those leaks are mandatory cloud-activation blockers. Ordinary alphanumeric false-positive rejections are tracked separately.
- R5-5: domain functions can accept an altered or empty forbidden-identifier list, approval records are mutable, and identifiers shorter than three characters may be ignored. A live-send path needs a private immutable approval registry and fresh validation against current identifiers. Mandatory before live cloud submission.
- R5-6: Form-1040, ISO-9001, and Section-123 can be treated as account references. A surname plus a year, such as SMITH-2026, can too. Those are availability issues, not privacy leaks.
- The benchmark still uses the old short-quote verifier.
- Live cloud drafting is not connected. `CLOUD_SUBMISSION_ENABLED` stays false.

## Phase 3 payment-claim assessment

This table is the rule for whether a figure is a current outstanding balance. It was written before the grounding change. A currency amount, the word “pay”, or the word “due” is not enough. Neighbouring sentences and the rest of the notice count. A negation does not wipe the whole notice: a cancelled £1,280 followed by a clearly supported £520 keeps the £520. If two roles cannot be separated, the current obligation stays unverified.

Lexical cues mark a role. They do not, by themselves, decide the notice. The notice walk uses sentence order, whether the statement names an amount or the whole account, and whether a later sentence resolves the earlier one.

| Role | What the sentence is doing | Current outstanding balance |
| --- | --- | --- |
| Current outstanding balance | The figure is tied to an outstanding balance, an amount due, a balance now requested, “you owe £”, “total to pay”, “please pay the balance”, or “please pay £”, and nothing later takes that role away | Yes, when it is the only surviving figure |
| Historical payment | A completed past payment, such as a thank-you for a payment or a payment already received | No for that figure, until a later sentence positively states a current balance |
| Paid in full | The account is paid in full | No. Repeating “please pay” for an amount already introduced does not restore it. A later figure that first appears as its own outstanding balance can remain |
| Written off | The named charge or balance was written off | No for that amount |
| Waived | The charge was waived | No for that amount, or for the account when the sentence names no amount |
| Cancelled demand | A demand was cancelled | No for that demand, unless a later sentence itself states a current outstanding balance, or the demand is explicitly reinstated |
| Withdrawn demand | A demand was withdrawn | Same as a cancelled demand |
| Reinstated demand | The text explicitly says the demand is reinstated, or says to disregard the cancellation. “Remains payable” is not reinstatement. “Will not reinstate”, “no amount remains payable”, and “nothing further remains payable” do not restore a balance | Restores the named amount only. An uncertain scope stays unverified |
| Conditional fee or conditional charge | A fee, surcharge, or penalty that may apply, or a charge that is only if, only after, would be due, or subject to confirmation. The word “fee” is not required | No. A fee may be recorded as a conditional fee. Its date is not an issue date and not a response deadline. A conditional charge is not payable now |
| Refunded payment | A payment was refunded | No |
| Conflicting balances | Two different figures both survive as current outstanding balances | No current balance. Both stay unverified. v2 `amountsGBP` is `[]` |
| Unsupported payment instruction | “Pay”, “due”, or a bare currency amount without a positive balance role | No |
| Ambiguous or incomplete evidence | One sentence both demands payment and withdraws it, a quotation stops before the sentence ends, or the role cannot be told apart | The current obligation is unverified |

A terminal account settlement (paid in full, written off, waived, refunded, or a statement that nothing remains payable) is not undone by a later “please pay” of an amount the notice had already introduced. A cancellation or withdrawal is different: if it comes first, a later sentence that positively states a current outstanding balance is a new demand and can remain. If the cancellation or withdrawal comes after the demand and nothing later reinstates it or states a new current balance, that demand is not current. A historical payment of one figure does not remove a later, different current balance.

An empty v2 `amountsGBP` means no supported outstanding balance. It is not proof that the notice contains no amounts. Conflicting figures stay in the local view as unverified and are not copied into v2. Notice text that tells a model to ignore instructions or to record a verified balance is data, not a balance. A payment deadline is kept only when its own sentence still supports a surviving current payment, or it is an explicit response date that is not a conditional fee or a withdrawn demand. A date that appears only inside a conditional fee does not become the issue date or the response deadline.

Phase 3 result for the recorded cases: H2, I2, J2, S1–S3, the settlement paraphrases, quoted cancellation, Q3, the no-ellipsis truncation, and D4 fail closed. A genuine current £1,280 and its deadline remain. A withdrawn or historical £1,280 does not remove a later current £520. An explicit reinstatement restores the named demand. A conditional fee beside a genuine balance stays a fee. £1,280 against £1,380 stays unverified, with `amountsGBP` empty. Action rows use stable claim ids. The v2 schema is unchanged: no `sourceQuote`, `redactedClause`, or private identifier map. D1, D2, D3, N1, and N2 stay in place. There is no v1 fallback on the production path. Those tested screens did not badge the recorded unsupported actions as Verified. That was not true of every later notice: Phase 3C found payment actions and slip amounts that could still be shown as Verified. R5-5 is not started. `CLOUD_SUBMISSION_ENABLED` stays false. A green suite is not, by itself, proof of complete grounding accuracy.

## Phase 3B claim hardening

Phase 3B keeps the same v2 schema and the same closed approval bytes. It records a local claim assessment for each sentence the notice walk splits: source claim identity, amount, role, positive current-balance evidence, settlement, cancellation, waiver, conditional or hypothetical status, reinstatement, contradiction, the source span, whether the evidence is complete, and the decision `current`, `not_current`, or `unverified`. That assessment is not copied into v2. Recording it is not the same as authorising the fact for the cloud brief. Keyword hits, a schema-valid payload, and a model confidence score are not enough for eligibility. Phase 3C is the stricter gate.

G1. “We will not reinstate this charge”, “No amount remains payable”, and “Nothing further remains payable” do not revive a cancelled or settled £1,280. “The £1,280 charge has been reinstated” still does.

G2. “Owe us nothing”, “there’s nothing to pay”, “credited back”, “now zero”, “we’ve cancelled it”, “don’t have to pay”, and “you won’t need to pay” are account-level negations. A later generic “please pay” does not override them.

G3. “Must pay only if”, “would be due”, “subject to confirmation”, “only after verification”, and a conditional charge that never uses the word “fee” are not payable now.

G4. “You do not need to pay the amount below” covers the next stated amount only. A later, different outstanding balance with its own support can remain.

G5. A quotation that stops before a condition, at a line break that continues the instruction, or in the middle of an instruction does not establish an unconditional demand.

G6. A payment action is not Verified when the current obligation is unsupported or the notice has two surviving balances. “Please pay by 25 November” beside £1,280 and £1,180 is not a verified payment or a verified payment deadline. “Please respond by” stays a response deadline. “Please contact … by” stays a response deadline.

G7. `ADMIN:`, `SYSTEM:`, `SYSTEM NOTE`, a note to the assistant, and “for any AI reading this” are untrusted notice content. They do not create a balance and they do not erase a separate £520.

G8. “You owe £1,280”, “Total to pay: £1,280”, “Your outstanding balance is £1,280”, and “Please pay £1,280 by 25 November 2026” stay supported when no later sentence undermines them.

The 47 notices are in `tests/unit/r5-3Phase3b.test.ts`. All 47 match the secure result: genuine current balances stay, and cancelled, settled, conditional, quoted, truncated, and injected amounts do not become a current balance. Read, Action Plan, closed-brief inspection, and canonical v2 share that verified or unverified decision. A conflict is explained on the Read screen. A conditional fee is labelled as a fee, not the balance, and its date is not the issue date.

“Please pay £1,280 or the revised £520” stays ambiguous. The two figures are in one instruction and neither is named as the replacement. L2, “the amount due is now £520, replacing the £1,280”, keeps £520 because the sentence names the replacement. No scenario was rewritten to accept an unsafe verified balance.

The 47 notices are necessary checks. They are not the full threat model. A later independent review found further unsafe admissions, recorded in Phase 3C. R5-3 is not fully closed. R5-2, R5-4, and R5-5 remain open. Phase 4 has not started. `CLOUD_SUBMISSION_ENABLED` stays false.

## Phase 3C strict eligibility

Phase 3C does not change the v2 schema, D1–D3, N1, N2, Firebase, App Check, the model, or dependencies. `CLOUD_SUBMISSION_ENABLED` stays false. R5-5 and live network integration are not started. Extracting a candidate is not authorising it.

Each candidate fact has one local decision, and Read Notice, Action Plan, the closed-brief inspection, and canonical v2 use that same decision:

- **Eligible.** The sentence is complete, outside an instruction to a model, and is one narrow present-tense form: outstanding balance is / of / now / `:`; balance due; amount payable; “the amount due is”; “you owe £”; “total to pay”; “please pay the outstanding balance”; “please pay £”; or “must pay £” with no “if”. An explicit “has been reinstated”, including “has now been reinstated”, or “disregard the cancellation”, restores the named amount. A later sentence in one of those forms can be a new balance after an earlier cancellation. A bare date on its own line, or a sentence that says issued / date of issue / notice date, can be the issue date.
- **Needs review.** A figure, date, or payment verb was extracted, but the sentence is not in that narrow set, the quotation is cut short, two balances survive, or the role is uncertain. This is the default.
- **Ineligible.** The claim is historical, cancelled, withdrawn, settled, waived, written off, refunded, voided, credited, reversed, conditional, hypothetical, contradicted, injected, a zero balance, a fee figure, or a date used for the wrong role.

A generic “please pay”, “please make a payment”, or a payment-slip “Amount due” after cancellation or paid-in-full is not reinstatement. “No part of this charge has been reinstated”, “none of it has been reinstated”, and “decided against reinstating” do not restore the amount. Settled, reversed, cancelled, credited, and waived balances stay unverified, and £0 is never written into v2. Hypothetical, contingent, and conditional amounts are not payable balances. A forward-looking “do not pay the amount below” covers the next stated amount only. Line breaks and truncated quotations do not hide a condition. `SYSTEM`, `ADMIN`, `AI`, and model-directed lines do not create payable facts. “System-generated” and “SYSTEM MAINTENANCE” are not those instructions. A payment deadline, an outage date, a statement date, and an effective date are not the issue date. An instalment date is not the deadline for the whole balance. A refund date is not a payment deadline. A date alone is not a deadline.

`pay_stated_balance` and `pay_or_contact` need one eligible balance. They are omitted from v2 when `amountsGBP` is empty. A contact or review line is not labelled as a verified payment demand. “While we review” without a reader request is not a verified request for review. A clarification goal with an empty amount list is not confirmation that a charge is valid. Empty `amountsGBP` is “no supported outstanding balance”, never £0. There is no user-confirmation control that turns an unsupported fact into a source-verified one.

The 29 recorded R5-3 corrections and the 47 Phase 3B notices stay. The 66 review notices are in `tests/unit/r5-3Phase3c.test.ts`: G1–G8 and N1–N16, including H1 (cancelled £1,280 plus a payment slip stays cancelled), H2 (“Please make a payment by 25 November” creates no balance), H3 (“No part of this charge has been reinstated” does not restore it), and H7 (payment, outage, and effective dates are not the issue date). A genuine £1,280 payable by 25 November 2026, a genuine £520 after a withdrawn £1,280, a historical £1,280 with £520 outstanding, an explicit reinstatement, a review request with no payable amount, and a conditional fee beside a genuine balance stay.

False rejections, tracked separately from unsafe admissions: G8e, “You must pay £1,280 by 25 November 2026 if you have not already done so”, is withheld because “must pay” together with “if” stays conditional. G8f, “the balance of £1,280 remains payable” while the sender reviews a dispute, is withheld. “Remains payable” is not a narrow acceptance form, and “while we review” is not a reader’s request for review. Those are conservative withholds, not verified cloud facts.

R5-3 is not fully closed. R5-2, R5-4, and R5-5 remain open. Phase 4 has not started.

## Milestone 4

- Inspect network request bodies in real Chrome before the public demo. Mocked calls do not satisfy that gate.
- Add a content security policy.
- Strengthen cloud-output checks, including invented-identifier detection and conditional legal language.
- Replace the benchmark's old short-quote verifier and broaden the fixtures.

## Deferred

These items are not implemented here:

- On-device inference timeout.
- Residual PII detection limitations, including unusual names, addresses, and Unicode homoglyphs.
- Production test-injection seam review and restriction.
- Dead raw-embed guard.
- R5-3 is not fully closed. The recorded sentences and the 47 Phase 3B notices still fail closed or keep a genuine current balance. Phase 3C records 66 further review notices. A recorded claim assessment did not, by itself, stop unsupported payment actions, slip amounts, conditional amounts, or the wrong date role from reaching a Verified label or v2. A green suite is not proof of complete grounding accuracy. Live cloud submission stays closed. False rejections are tracked separately from unsafe admissions in the Phase 3C section.
- Cloud output legal-conclusion validation.
- False positives in grouped number detection.
- Bracketed instructional text versus supported placeholder tokens.
- Real Chrome request-body audit.
- Content Security Policy, and removal of the legacy SpikeHarness before a demo.

Inference mode, the cloud model `gemini-3.5-flash-lite`, App Check, and the canonical immutable cloud snapshot stay as they are.

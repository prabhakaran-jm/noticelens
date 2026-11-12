# NoticeLens

**Understand the notice. Know your next step.**

NoticeLens is a planned privacy-conscious hybrid AI web application for understanding UK housing, council and utility correspondence. It turns dense notices into **source-linked action plans**, supports **user-approved response drafting**, and tracks what changes when a follow-up notice arrives.

> **Project status:** Hackathon project scaffold. The AI application and its features are **not implemented yet**. This repository records the intended scope, architecture and test criteria.

## #BuildHybridAI 2026 submission

- **Primary platform:** Web (Chrome desktop)
- **Sponsor technology:** Firebase AI Logic, on-device Gemini Nano when available, and cloud Gemini for user-approved response assistance
- **Primary demonstration:** A fictional £1,280 electricity back-bill, a source-backed checklist, an editable response, and a fictional revised £520 bill
- **Primary prize target:** Best Web/Chrome

## Intended experience

1. **Read privately.** On a supported Chrome setup, Firebase AI Logic runs `ONLY_ON_DEVICE` extraction on the original notice. It extracts dates, amounts, actions, and supporting quotations.
2. **Verify evidence.** Deterministic code checks each quotation against the document's text. Unmatched claims are visibly unverified rather than silently accepted.
3. **Prepare an approved brief.** A local privacy gate removes personal identifiers and produces a structured, minimal context payload. The user sees and approves the exact payload.
4. **Draft with cloud AI.** Firebase AI Logic uses `ONLY_IN_CLOUD` on the approved structural brief and supplied official guidance to generate response options and an editable template.
5. **Personalise locally.** Personal fields are filled into the draft on the device. The user must approve any use of the draft.
6. **Track changes.** A later notice is compared against the earlier one, with amount, deadline and obligations linked to their source passages.

## Key design rules

- Never silently upload the raw private notice as a fallback.
- Never claim that AI has verified legal rights or determined that a bill is invalid.
- Never claim an on-device inference call happened unless Firebase AI Logic reports `ON_DEVICE`.
- Do not infer legal rights from model knowledge alone: use curated, attributable official guidance and explain conditions.
- In unsupported browsers, clearly label **Limited mode** and require review and consent before any sanitized content is sent to the cloud.
- All application AI inference must go through Firebase AI Logic.

## Repository contents

```text
assets/                 Hackathon thumbnail
examples/               Fully fictional sample notices
docs/PRODUCT.md         Scope and acceptance tests
docs/ARCHITECTURE.md    Proposed architecture and security boundaries
docs/DEMO.md            3-minute Devpost demo story
```

## Getting started

Development has not started in this scaffold. Start with the feasibility gate in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): **prove a real Firebase AI Logic `ONLY_ON_DEVICE` response with structured output and check the reported inference source** before building the UI.

## Licence

MIT — see [LICENSE](LICENSE).

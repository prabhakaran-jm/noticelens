# NoticeLens follow-ups after Milestone 1

This note is not a product screen. Milestone 1 stays on the deterministic domain core and the security fixes already on `feat/m1-deterministic-domain-core`. The items below are outstanding. They are not implemented here.

## Milestone 2

- Ground source facts by role, with evidence for the whole clause rather than a matching fragment.
- Require an explicit Privacy modal approval that is bound to the canonical cloud payload.
- Stop the legacy Milestone 0 spike from displaying facts that are not supported by the source.
- Block Copy and Download in the user interface while any placeholder is unresolved or malformed. The domain flag exists; the screens do not enforce it yet.
- Integrate the four approved screens for real, in place of the spike harness.

## Milestone 4

- Audit network request bodies in real Chrome, not only with mocked calls.
- Add a content security policy.
- Strengthen checks on conditional legal language and on cloud output.
- Improve the benchmark beyond the current synthetic fixtures.

Inference mode, the cloud model `gemini-3.5-flash-lite`, App Check, and the canonical immutable cloud snapshot stay as they are.

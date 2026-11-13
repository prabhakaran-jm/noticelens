import { describe, expect, it } from "vitest";
import {
  applyPlaceholderBindings,
  createReplyDraftState,
  editLocalDraft,
  showPersonalisedDraft,
  showPlaceholderTemplate,
} from "../../src/domain/personaliseDraft";

describe("personaliseDraft — cloud template stays separate from the local draft", () => {
  const cloudTemplate = [
    "Dear [RECIPIENT_NAME],",
    "I am writing about account [ACCOUNT_REF] at [SUPPLY_ADDRESS].",
    "Please also keep [ACCOUNT_REFERENCE] and [PROPERTY_ADDRESS] aligned.",
    "[UNKNOWN_TOKEN]",
  ].join("\n");

  const bindings = [
    { placeholder: "[RECIPIENT_NAME]", localValue: "Sarah Example" },
    { placeholder: "[ACCOUNT_REF]", localValue: "EXAMPLE-8472" },
    { placeholder: "[SUPPLY_ADDRESS]", localValue: "14 Example Road, Reading, RG0 0AA" },
  ];

  it("hydrates canonical placeholders and leaves non-canonical tokens unresolved", () => {
    const state = createReplyDraftState(cloudTemplate, bindings);
    expect(state.cloudTemplate).toBe(cloudTemplate);
    expect(state.localDraft).toContain("Sarah Example");
    expect(state.localDraft).toContain("EXAMPLE-8472");
    expect(state.localDraft).toContain("14 Example Road, Reading, RG0 0AA");
    expect(state.localDraft).not.toContain("[ACCOUNT_REF]");
    expect(state.localDraft).toContain("[ACCOUNT_REFERENCE]");
    expect(state.localDraft).toContain("[PROPERTY_ADDRESS]");
    expect(state.unresolvedPlaceholders).toEqual(
      expect.arrayContaining(["[ACCOUNT_REFERENCE]", "[PROPERTY_ADDRESS]", "[UNKNOWN_TOKEN]"])
    );
    expect(state.copyOrDownloadBlocked).toBe(true);
    expect(showPlaceholderTemplate(state)).toBe(cloudTemplate);
    expect(showPersonalisedDraft(state)).toContain("Dear Sarah Example");
  });

  it("keeps a user edit on the local draft and leaves the cloud template intact", () => {
    const state = createReplyDraftState(cloudTemplate, bindings);
    const edited = editLocalDraft(
      state,
      "Dear Sarah Example,\n\nI added a meter reading date on this device."
    );
    expect(edited.cloudTemplate).toBe(state.cloudTemplate);
    expect(edited.localDraft).toContain("meter reading date");
    expect(showPlaceholderTemplate(edited)).toBe(cloudTemplate);
    expect(showPlaceholderTemplate(edited)).not.toContain("meter reading date");
  });

  it("does not expand a placeholder that was inserted as a local value", () => {
    const applied = applyPlaceholderBindings("Hello [RECIPIENT_NAME]", [
      { placeholder: "[RECIPIENT_NAME]", localValue: "[ACCOUNT_REF]" },
      { placeholder: "[ACCOUNT_REF]", localValue: "EXAMPLE-8472" },
    ]);
    expect(applied.personalised).toBe("Hello [ACCOUNT_REF]");
    expect(applied.personalised).not.toContain("EXAMPLE-8472");
    expect(applied.unresolvedPlaceholders).toContain("[ACCOUNT_REF]");
  });

  it("leaves an empty binding unresolved and reports raw identifiers already in the template", () => {
    const state = createReplyDraftState("Account [ACCOUNT_REF] for Sarah Example", [
      { placeholder: "[ACCOUNT_REF]", localValue: "   " },
      { placeholder: "[RECIPIENT_NAME]", localValue: "Sarah Example" },
    ]);
    expect(state.localDraft).toContain("[ACCOUNT_REF]");
    expect(state.unresolvedPlaceholders).toContain("[ACCOUNT_REF]");
    expect(state.leakedRawIdentifiers).toContain("Sarah Example");
    expect(state.cloudTemplate).toContain("Sarah Example");
  });

  it("rejects a non-string template", () => {
    expect(() => createReplyDraftState(undefined as unknown as string, [])).toThrow(TypeError);
  });
});

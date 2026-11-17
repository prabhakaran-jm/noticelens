import { isCanonicalPlaceholder, listPlaceholderTokens } from "./placeholders";
import { foldIdentifierText } from "./textNormalize";
import type { LocalIdentifierMap } from "./types";

export interface PlaceholderBinding {
  placeholder: string;
  localValue: string;
}

export interface ReplyDraftState {
  readonly cloudTemplate: string;
  localDraft: string;
  unresolvedPlaceholders: string[];
  leakedRawIdentifiers: string[];
  /** Domain flag only. Copy or Download stays disabled while this is true. */
  copyOrDownloadBlocked: boolean;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function bindingsFromIdentifierMap(map: LocalIdentifierMap): PlaceholderBinding[] {
  return map.entries.map((entry) => ({
    placeholder: entry.placeholder,
    localValue: entry.rawValue,
  }));
}

/**
 * One left-to-right pass. Replacement text is inserted literally and is not scanned.
 * Unresolved tokens are then read from the result, so a value that still contains
 * a placeholder blocks Copy or Download.
 */
export function applyPlaceholderBindings(
  cloudTemplate: string,
  bindings: readonly PlaceholderBinding[]
): { personalised: string; unresolvedPlaceholders: string[] } {
  const table = new Map<string, string>();
  const blocked = new Set<string>();
  for (const binding of bindings) {
    const key = binding.placeholder.trim();
    if (!isCanonicalPlaceholder(key) || binding.localValue.trim().length === 0) {
      continue;
    }
    const existing = table.get(key);
    if (existing === undefined) {
      table.set(key, binding.localValue);
      continue;
    }
    if (foldIdentifierText(existing).folded !== foldIdentifierText(binding.localValue).folded) {
      blocked.add(key);
    }
  }

  let cursor = 0;
  let personalised = "";
  while (cursor < cloudTemplate.length) {
    const start = cloudTemplate.indexOf("[", cursor);
    if (start < 0) {
      personalised += cloudTemplate.slice(cursor);
      break;
    }
    personalised += cloudTemplate.slice(cursor, start);
    const end = cloudTemplate.indexOf("]", start + 1);
    if (end < 0) {
      personalised += cloudTemplate.slice(start);
      break;
    }
    const token = cloudTemplate.slice(start, end + 1);
    const replacement = table.get(token);
    if (
      isCanonicalPlaceholder(token) &&
      !blocked.has(token) &&
      replacement !== undefined &&
      replacement.trim().length > 0
    ) {
      personalised += replacement;
    } else {
      personalised += token;
    }
    cursor = end + 1;
  }

  return {
    personalised,
    unresolvedPlaceholders: unique(listPlaceholderTokens(personalised)),
  };
}

function rawValuesInTemplate(
  cloudTemplate: string,
  bindings: readonly PlaceholderBinding[]
): string[] {
  const folded = cloudTemplate.toLowerCase();
  return unique(
    bindings
      .map((binding) => binding.localValue.trim())
      .filter((value) => value.length >= 4 && folded.includes(value.toLowerCase()))
  );
}

function blocked(unresolvedPlaceholders: readonly string[]): boolean {
  return unresolvedPlaceholders.length > 0;
}

export function createReplyDraftState(
  cloudTemplate: string,
  bindings: readonly PlaceholderBinding[]
): ReplyDraftState {
  if (typeof cloudTemplate !== "string") {
    throw new TypeError("cloudTemplate must be a string");
  }
  const applied = applyPlaceholderBindings(cloudTemplate, bindings);
  return {
    cloudTemplate,
    localDraft: applied.personalised,
    unresolvedPlaceholders: applied.unresolvedPlaceholders,
    leakedRawIdentifiers: rawValuesInTemplate(cloudTemplate, bindings),
    copyOrDownloadBlocked: blocked(applied.unresolvedPlaceholders),
  };
}

export function editLocalDraft(state: ReplyDraftState, nextLocalDraft: string): ReplyDraftState {
  if (typeof nextLocalDraft !== "string") {
    throw new TypeError("localDraft must be a string");
  }
  const unresolvedPlaceholders = unique(listPlaceholderTokens(nextLocalDraft));
  return {
    cloudTemplate: state.cloudTemplate,
    localDraft: nextLocalDraft,
    unresolvedPlaceholders,
    leakedRawIdentifiers: state.leakedRawIdentifiers,
    copyOrDownloadBlocked: blocked(unresolvedPlaceholders),
  };
}

export function showPlaceholderTemplate(state: ReplyDraftState): string {
  return state.cloudTemplate;
}

export function showPersonalisedDraft(state: ReplyDraftState): string {
  return state.localDraft;
}

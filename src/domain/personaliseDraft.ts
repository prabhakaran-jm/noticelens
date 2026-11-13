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
}

const KNOWN_TOKEN_SOURCE =
  "\\[(?:RECIPIENT_NAME|ACCOUNT_REF|ACCOUNT_REFERENCE|SUPPLY_ADDRESS|PROPERTY_ADDRESS|EMAIL|PHONE|LOCAL_ID|NINO)(?:_\\d+)?\\]";

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function aliasKey(placeholder: string): string[] {
  const match =
    /^\[(ACCOUNT_REF|ACCOUNT_REFERENCE|SUPPLY_ADDRESS|PROPERTY_ADDRESS)(_\d+)?\]$/.exec(
      placeholder
    );
  if (!match) {
    return [];
  }
  const suffix = match[2] ?? "";
  const alt =
    match[1] === "ACCOUNT_REF" || match[1] === "ACCOUNT_REFERENCE"
      ? match[1] === "ACCOUNT_REF"
        ? "ACCOUNT_REFERENCE"
        : "ACCOUNT_REF"
      : match[1] === "SUPPLY_ADDRESS"
        ? "PROPERTY_ADDRESS"
        : "SUPPLY_ADDRESS";
  return [`[${alt}${suffix}]`];
}

export function bindingsFromIdentifierMap(
  map: LocalIdentifierMap
): PlaceholderBinding[] {
  return map.entries.map((entry) => ({
    placeholder: entry.placeholder,
    localValue: entry.rawValue,
  }));
}

export function applyPlaceholderBindings(
  cloudTemplate: string,
  bindings: readonly PlaceholderBinding[]
): { personalised: string; unresolvedPlaceholders: string[] } {
  const table = new Map<string, string>();
  for (const binding of bindings) {
    const key = binding.placeholder.trim();
    if (!key) {
      continue;
    }
    table.set(key, binding.localValue);
  }
  for (const [key, value] of [...table.entries()]) {
    for (const alias of aliasKey(key)) {
      if (!table.has(alias)) {
        table.set(alias, value);
      }
    }
  }

  const unresolved: string[] = [];
  const personalised = cloudTemplate.replace(
    new RegExp(KNOWN_TOKEN_SOURCE, "g"),
    (token) => {
      if (!table.has(token)) {
        unresolved.push(token);
        return token;
      }
      const value = table.get(token) ?? "";
      if (value.trim().length === 0) {
        unresolved.push(token);
        return token;
      }
      return value;
    }
  );

  for (const token of cloudTemplate.match(/\[[A-Z][A-Z0-9_]*\]/g) ?? []) {
    if (!table.has(token)) {
      unresolved.push(token);
    }
  }

  return {
    personalised,
    unresolvedPlaceholders: unique(unresolved),
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
  };
}

export function editLocalDraft(
  state: ReplyDraftState,
  nextLocalDraft: string
): ReplyDraftState {
  if (typeof nextLocalDraft !== "string") {
    throw new TypeError("localDraft must be a string");
  }
  return {
    cloudTemplate: state.cloudTemplate,
    localDraft: nextLocalDraft,
    unresolvedPlaceholders: state.unresolvedPlaceholders,
    leakedRawIdentifiers: state.leakedRawIdentifiers,
  };
}

export function showPlaceholderTemplate(state: ReplyDraftState): string {
  return state.cloudTemplate;
}

export function showPersonalisedDraft(state: ReplyDraftState): string {
  return state.localDraft;
}

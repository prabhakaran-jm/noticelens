/**
 * Finite supported structures for cloud-bound financial facts.
 *
 * A candidate starts unverified. It becomes a current balance only when the
 * sentence matches one construction below and the clause does not continue
 * into a disposition of that same demand. The words balance, due, payment,
 * Date, and account are not authority on their own.
 *
 * These constructions are not copies of the demo notices. Amounts and dates
 * stay open. A matching phrase inside an untrusted frame (a copied letter,
 * example, estimate, customer statement, or parser instruction) is not the
 * current demand. The frame is the introducer and the following sentences
 * until a blank line. An earlier supported obligation is left alone, and a
 * later paragraph after the blank line can still be supported.
 *
 * Limits: the frame introducers are a finite list. Wording that does not
 * match a construction is withheld even without an introducer. Wording that
 * matches a construction and is not inside a recognised frame can still be
 * admitted. This file does not try to list every English cancellation.
 */

import { isModelOrParserDirected } from "./supportedNoticePolicy";

const AMOUNT = "£\\s?\\d";

/** Present balance or direct demand. The amount is part of the construction. */
const BALANCE_STRUCTURES: readonly RegExp[] = [
  new RegExp(`\\boutstanding\\s+balance\\s+of\\s+${AMOUNT}`, "i"),
  new RegExp(`\\boutstanding\\s+balance\\s+is(?:\\s+now)?\\s+${AMOUNT}`, "i"),
  new RegExp(`\\boutstanding\\s+balance\\s*:\\s*${AMOUNT}`, "i"),
  new RegExp(`\\bbalance\\s+now\\s+requested\\s+is\\s+${AMOUNT}`, "i"),
  new RegExp(`\\b(?:amount|balance)\\s+due\\s+is(?:\\s+now)?\\s+${AMOUNT}`, "i"),
  new RegExp(`\\b(?:amount|balance)\\s+due\\s+of\\s+${AMOUNT}`, "i"),
  new RegExp(`\\b(?:amount|balance)\\s+due\\s*:\\s*${AMOUNT}`, "i"),
  new RegExp(`\\bamount\\s+payable\\s+(?:is|of)\\s+${AMOUNT}`, "i"),
  new RegExp(`\\bamount\\s+payable\\s*:\\s*${AMOUNT}`, "i"),
  new RegExp(`\\btotal\\s+to\\s+pay\\s+(?:is|of)\\s+${AMOUNT}`, "i"),
  new RegExp(`\\btotal\\s+to\\s+pay\\s*:\\s*${AMOUNT}`, "i"),
  new RegExp(`\\bcurrent\\s+balance(?:\\s+\\([^)]{0,80}\\))?\\s+is\\s+${AMOUNT}`, "i"),
  new RegExp(`\\bcurrent\\s+balance(?:\\s+\\([^)]{0,80}\\))?\\s*:\\s*${AMOUNT}`, "i"),
  new RegExp(`\\byou\\s+owe\\s+${AMOUNT}`, "i"),
  new RegExp(`\\bplease\\s+pay\\s+${AMOUNT}`, "i"),
  new RegExp(`\\bplease\\s+pay\\s+the\\s+outstanding\\s+balance\\s+of\\s+${AMOUNT}`, "i"),
  new RegExp(`\\byou\\s+must\\s+pay\\s+${AMOUNT}`, "i"),
  new RegExp(`\\bby\\s+paying\\s+${AMOUNT}`, "i"),
  new RegExp(`\\bnew\\s+and\\s+separate\\s+${AMOUNT}`, "i"),
  new RegExp(`\\b(?:corrected|replacement)\\s+(?:charge|bill)\\s+comes\\s+to\\s+${AMOUNT}`, "i"),
  new RegExp(`\\b(?:new\\s+and\\s+separate|separate|new)\\s+(?:charge|bill)\\s+of\\s+${AMOUNT}`, "i"),
  new RegExp(`\\b(?:corrected|replacement)\\s+(?:charge|bill)\\s+of\\s+${AMOUNT}`, "i"),
  // Only these two openings. A sentence that merely contains the words is not a demand.
  new RegExp(`^the\\s+amount\\s+due\\s+now\\s+is\\s+${AMOUNT}`, "i"),
  new RegExp(`^amount\\s+due\\s+now\\s+${AMOUNT}`, "i"),
];

/**
 * A matched construction is not a current demand when the same clause then
 * disposes of it. This is part of the construction, not a catalogue of probes.
 */
const DISPOSITION_AFTER =
  /\b(?:funded\s+by|handled\s+by|sorted\s+out\s+by|quashed|suspended|cancell?ed|withdrawn|waived|written\s+off|paid\s+in\s+full|met\s+in\s+full|covered\s+by|taken\s+care\s+of|zeroed|no\s+longer\s+(?:due|owed|payable)|nothing\s+(?:further\s+is\s+required|is\s+owed)|was\s+an\s+error)\b/i;

const CONDITIONAL_OPENER = /^(?:if|should|assuming|supposing|suppose|were|for\s+example)\b/i;

/** These two openings are not current when the same sentence is not a live demand. */
const DUE_NOW_OPENING = /^the\s+amount\s+due\s+now\s+is\s+£|^amount\s+due\s+now\s+£/i;
const DUE_NOW_NOT_CURRENT =
  /\b(?:disput\w*|disagree\w*|hypothetical|example|copied|reproduced|previous\s+letter|earlier\s+letter|previously|if|should|assuming|suppose|supposing)\b/i;

export function matchesSupportedBalanceStructure(sentence: string): boolean {
  const s = sentence.replace(/\s+/g, " ").trim();
  if (!s || CONDITIONAL_OPENER.test(s)) {
    return false;
  }
  for (const pattern of BALANCE_STRUCTURES) {
    const match = pattern.exec(s);
    if (!match || match.index === undefined) {
      continue;
    }
    const matched = match[0];
    if (/\bcurrent\s+balance\b/i.test(matched) && /\bprevious\b/i.test(s)) {
      continue;
    }
    const after = s.slice(match.index + matched.length);
    if (DISPOSITION_AFTER.test(after)) {
      continue;
    }
    if (DUE_NOW_OPENING.test(matched) && DUE_NOW_NOT_CURRENT.test(s)) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * A copied letter or example that continues into the following sentences.
 * A blank line closes it. A model instruction or a one-sentence example does
 * not use this: those cover only the sentence that contains them, so a later
 * supported obligation in the same paragraph can still stand.
 */
export function introducesParagraphFrame(sentence: string): boolean {
  const s = sentence.replace(/\s+/g, " ").trim();
  return /\b(?:following\s+text\s+is\s+an\s+example|below\s+is\s+the\s+text|text\s+of\s+our\s+earlier|reproduced\s+from|extract\s+from)\b/i.test(
    s
  );
}

/**
 * This sentence is not the current demand. Paragraph frames also cover the
 * following sentences until a blank line. Other introducers cover this
 * sentence only. The list is finite: an unrecognised hypothetical is withheld
 * only when it also fails a supported construction.
 */
export function introducesUntrustedFrame(sentence: string): boolean {
  const s = sentence.replace(/\s+/g, " ").trim();
  if (!s) {
    return false;
  }
  if (isModelOrParserDirected(s) || introducesParagraphFrame(s)) {
    return true;
  }
  return (
    /\b(?:for\s+example|this\s+is\s+an\s+example|example\s+invoice|previous\s+letter|earlier\s+letter|previously\s+we\s+told|customer\s+wrote|you\s+wrote|the\s+customer\s+said|you\s+told\s+us|we\s+estimate|estimated\s+amount|this\s+is\s+only\s+an\s+estimate)\b/i.test(
      s
    ) ||
    /^dear\s+extraction\b/i.test(s) ||
    /^(?:ai\s+model|system|assistant|parser)\s*:/i.test(s) ||
    /<\s*\/?\s*instruction\b/i.test(s)
  );
}

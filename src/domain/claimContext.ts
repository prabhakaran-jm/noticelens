/**
 * Claim-context admission contract.
 *
 * A matching phrase such as "outstanding balance", "amount due now",
 * "please pay", or "you owe" is not authority. A candidate stays unverified
 * unless its own claim context is supported. There is no general language
 * model and no growing catalogue of settlement sentences. The supported
 * subset is a direct current demand. Unfamiliar or unresolved context is
 * withheld even when a phrase matches.
 *
 * Required together, for that claim only:
 * - supported document context: the supplier's own current notice, not a
 *   copy, example, training scenario, appendix, or parser instruction
 * - current-demand context: the sentence states a present obligation
 * - positive amount evidence inside a supported construction
 * - claim ownership: the reader's obligation, not a former tenant's or a
 *   third party's
 * - current rather than historical or reported speech
 * - not already paid, settled, cleared, waived, or left as "the charge is disputed"
 * - a previous or later statement in the claim does not cancel, settle, or
 *   give the debt to someone else
 * - a payment instruction and its deadline belong to this claim
 * - a cancelled amount stays retired unless this sentence reinstates that
 *   amount or states a plainly separate new charge
 * - the source occurrence covers the figure
 *
 * A short claim may be accepted when the sentence itself is unambiguous.
 * A balance that explicitly remains due is not retired merely because the
 * same sentence mentions a dispute review. Context does not transfer across
 * a blank line unless the later claim has its own supported authority.
 *
 * claimContextState is the sentence-level unresolved-context check. It does
 * not admit a balance. Admission is matchesSupportedBalanceStructure, the
 * walker, and verifiedBalanceForSource. Wording outside this finite list
 * that still matches a supported construction can be admitted. This is not
 * a general reading of the notice and not full-context default-deny.
 */

const UNRESOLVED_CONTEXT =
  /\b(?:imagine|training\s+scenario|hypothetical|for\s+example|suppose|supposing|appendix|treat\s+the\s+following|copy\s+of\s+(?:our|the|your|an)|copied\s+letter|earlier\s+payment\s+notice|(?:letter|notice|bill)\s+said|said\s+you\s+owe|would\s+be|once\b|if\s+confirmed|if\s+the\b|former\s+tenant)\b|\bparser\s*:/i;

/**
 * A completed disposition of the debt. A mention of help, a right to
 * challenge, or a future query is not this. The topic words alone are not
 * enough: the sentence has to say the debt was paid, settled, cleared,
 * picked up, or is disputed.
 */
function statesCompletedDisposition(sentence: string): boolean {
  if (/\bno\s+longer\s+enforceable\b/i.test(sentence)) {
    return true;
  }
  if (/\b(?:charge|balance|amount|bill|debt|demand)\s+(?:is|was|remains|has\s+been)\s+disputed\b/i.test(sentence)) {
    return true;
  }
  if (
    /\b(?:is|was|remains)\s+disputed\b/i.test(sentence) &&
    /\b(?:charge|balance|amount|bill|debt|demand|it)\b/i.test(sentence)
  ) {
    return true;
  }
  if (/\b(?:has|have)\s+resolved\s+(?:this|the)\s+(?:charge|balance|demand|bill)\b/i.test(sentence)) {
    return true;
  }
  if (
    /\bresolved\s+(?:this|the)\s+(?:charge|balance|demand|bill)\b/i.test(sentence) &&
    !/\bwill\s+resolve\b/i.test(sentence)
  ) {
    return true;
  }
  if (
    /\b(?:has|have)\s+(?:paid|settled|cleared)\b/i.test(sentence) &&
    /\b(?:balance|charge|amount|bill|debt|demand|it|this)\b/i.test(sentence)
  ) {
    return true;
  }
  if (/\b(?:charity|hardship)\b[^.]{0,80}\bpicked\s+up\b/i.test(sentence)) {
    return true;
  }
  if (/\bpicked\s+up\s+(?:the\s+)?(?:balance|charge|amount|bill|debt|demand)\b/i.test(sentence)) {
    return true;
  }
  if (/\bcredit\s+offset\b[^.]{0,60}\b(?:has|have)\s+(?:cleared|offset)\b/i.test(sentence)) {
    return true;
  }
  if (/\bcredited\s+against\b/i.test(sentence) && /\b(?:balance|charge|amount|bill|debt|demand)\b/i.test(sentence)) {
    return true;
  }
  if (/\bcleared\s+through\s+an\s+adjustment\b/i.test(sentence)) {
    return true;
  }
  if (
    /\badjustment\s+(?:has\s+)?settled\b/i.test(sentence) &&
    /\b(?:balance|charge|amount|bill|debt|demand|it|this)\b/i.test(sentence)
  ) {
    return true;
  }
  if (
    /\b(?:hardship|charity)\b/i.test(sentence) &&
    /\b(?:has|have)\s+(?:paid|settled|cleared|picked\s+up)\b/i.test(sentence)
  ) {
    return true;
  }
  return false;
}

export type ClaimContextState = "supported-current" | "unsupported";

export function claimContextState(sentence: string): ClaimContextState {
  return sentenceHasUnresolvedContext(sentence) ? "unsupported" : "supported-current";
}

/** The sentence is not a direct current demand, even if a balance phrase matches. */
export function sentenceHasUnresolvedContext(sentence: string): boolean {
  return UNRESOLVED_CONTEXT.test(sentence.replace(/\s+/g, " ").trim());
}

/**
 * A later sentence retires a claim only when it clearly records a completed
 * disposition: the debt was paid, settled, cleared, picked up, or is disputed.
 * An offer of help, a right to challenge, or a future query does not.
 */
export function sentenceDisposesCurrentClaim(sentence: string): boolean {
  const s = sentence.replace(/\s+/g, " ").trim();
  return statesCompletedDisposition(s);
}

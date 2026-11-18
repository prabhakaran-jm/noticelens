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
 * An actual dispute of this claim, including one that is on hold or under
 * review, is not an undisputed current obligation. A right to dispute is
 * not that dispute. A dispute binds another claim only when it names a
 * separate amount. Resolved, removed, or last year does not make a dispute
 * of this bill into a different claim. “£X remains due” is not, by itself,
 * a current balance. A partial credit keeps a residual only when that
 * residual is the amount an earlier supported demand already established.
 * Context does not transfer across a blank line unless the later claim has
 * its own supported authority.
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
 * A right to challenge, or a future query, is not a dispute of this claim.
 * The topic word on its own is not enough.
 */
function isRightsOrFutureDispute(sentence: string): boolean {
  return (
    /\b(?:right|wish)\s+to\s+dispute\b/i.test(sentence) ||
    /\bif\s+you\s+(?:have|wish|want)\b/i.test(sentence) ||
    /\b(?:can|may|could)\s+(?:raise|make|start)\s+a\s+dispute\b/i.test(sentence) ||
    /\b(?:if|when)\s+(?:this|it)\s+is\s+not\s+resolved\b/i.test(sentence)
  );
}

/**
 * The sentence records that this claim is disputed, on hold, under review,
 * or that the dispute was accepted. It does not match an offer of help.
 */
export function recordsActualDispute(sentence: string): boolean {
  if (isRightsOrFutureDispute(sentence)) {
    return false;
  }
  if (/\b(?:have|has|had)\s+disputed\b/i.test(sentence)) {
    return true;
  }
  if (/\b(?:have|has)\s+raised\s+a\s+dispute\b/i.test(sentence)) {
    return true;
  }
  if (
    /\b(?:charge|balance|amount|bill|debt|demand)\s+(?:is|was|remains|has\s+been)\s+disputed\b/i.test(sentence)
  ) {
    return true;
  }
  if (
    /\b(?:is|was|remains|has\s+been)\s+disputed\b/i.test(sentence) &&
    /\b(?:charge|balance|amount|bill|debt|demand|it)\b/i.test(sentence)
  ) {
    return true;
  }
  if (/\bdisputed\s+and\s+on\s+hold\b/i.test(sentence)) {
    return true;
  }
  if (
    /\bdispute\b/i.test(sentence) &&
    /\b(?:on\s+hold|under\s+review|while\s+we\s+(?:investigate|review)|pending)\b/i.test(sentence)
  ) {
    return true;
  }
  if (/\baccepted\s+(?:the|your|this)\s+dispute\b/i.test(sentence)) {
    return true;
  }
  if (/\bdispute\b[^.]{0,48}\b(?:has\s+been|was|were)\s+accepted\b/i.test(sentence)) {
    return true;
  }
  return false;
}

/**
 * A completed act that takes the debt: paid, settled, cleared, picked up
 * and paid, covered by hardship, or resolved. An offer, a right, or a
 * future query is not this. An amount may sit between "the" and the noun.
 */
const RESOLVED_NAMED_DEBT =
  /\b(?:has|have)\s+resolved\s+(?:this|the)\s+(?:£\s?[\d,]+(?:\.\d{1,2})?\s+)?(?:charge|balance|demand|bill)\b/i;
const RESOLVED_NAMED_DEBT_PAST =
  /\bresolved\s+(?:this|the)\s+(?:£\s?[\d,]+(?:\.\d{1,2})?\s+)?(?:charge|balance|demand|bill)\b/i;

function statesCompletedDisposition(sentence: string): boolean {
  if (recordsActualDispute(sentence)) {
    return true;
  }
  if (/\bno\s+longer\s+enforceable\b/i.test(sentence)) {
    return true;
  }
  if (RESOLVED_NAMED_DEBT.test(sentence)) {
    return true;
  }
  if (RESOLVED_NAMED_DEBT_PAST.test(sentence) && !/\bwill\s+resolve\b/i.test(sentence)) {
    return true;
  }
  if (
    /\b(?:has|have)\s+(?:paid|settled|cleared)\b/i.test(sentence) &&
    /\b(?:balance|charge|amount|bill|debt|demand|it|this)\b/i.test(sentence)
  ) {
    return true;
  }
  if (/\bpicked\s+up\s+and\s+paid\b/i.test(sentence)) {
    return true;
  }
  if (/\bpaid\s+by\s+(?:the\s+)?(?:supplier|charity)\b/i.test(sentence)) {
    return true;
  }
  if (/\b(?:charity|hardship)\b[^.]{0,80}\bpicked\s+up\b/i.test(sentence)) {
    return true;
  }
  if (/\bpicked\s+up\s+(?:the\s+)?(?:balance|charge|amount|bill|debt|demand)\b/i.test(sentence)) {
    return true;
  }
  if (/\bcovered\s+(?:under|by)\s+(?:the\s+)?(?:hardship|charity)\b/i.test(sentence)) {
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

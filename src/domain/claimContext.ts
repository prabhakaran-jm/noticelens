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
 * - not handed to a charity, hardship scheme, credit, or adjustment, and not
 *   left as only "the charge is disputed"
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
  /\b(?:imagine|training\s+scenario|hypothetical|for\s+example|suppose|supposing|appendix|treat\s+the\s+following|copy\s+of\s+(?:our|the|your|an)|copied\s+letter|earlier\s+payment\s+notice|(?:letter|notice|bill)\s+said|said\s+you\s+owe|would\s+be|once\b|if\s+confirmed|if\s+the\b|former\s+tenant|partner\s+charity|charity\s+has|picked\s+up|hardship|no\s+longer\s+enforceable|credited\s+against|credit\s+offset|adjustment\s+(?:has\s+)?settled)\b|\bparser\s*:/i;

const DISPOSES_CURRENT_CLAIM =
  /\b(?:disput\w*|hardship|partner\s+charity|charity\s+has|picked\s+up|no\s+longer\s+enforceable|credited\s+against|credit\s+offset|adjustment\s+(?:has\s+)?settled|customer\s+services\b[^.]{0,80}\bresolv\w*)\b/i;

export type ClaimContextState = "supported-current" | "unsupported";

export function claimContextState(sentence: string): ClaimContextState {
  return sentenceHasUnresolvedContext(sentence) ? "unsupported" : "supported-current";
}

/** The sentence is not a direct current demand, even if a balance phrase matches. */
export function sentenceHasUnresolvedContext(sentence: string): boolean {
  return UNRESOLVED_CONTEXT.test(sentence.replace(/\s+/g, " ").trim());
}

/**
 * A later sentence that gives the debt away, disputes it, or says it is no
 * longer the reader's obligation. This retires the claim. It is not a list of
 * every way a debt can be settled.
 */
export function sentenceDisposesCurrentClaim(sentence: string): boolean {
  return DISPOSES_CURRENT_CLAIM.test(sentence.replace(/\s+/g, " ").trim());
}

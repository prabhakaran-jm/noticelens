/**
 * Supported-notice policy for cloud-bound facts.
 *
 * A fact enters an approvable v2 brief only when it meets a positive rule
 * below. Uncertainty withholds the claim or obligation. This is not a list
 * of probe sentences, and it does not treat the two demo notices as the
 * definition of a supported notice. Arbitrary natural-language notices are
 * not supported.
 *
 * A current balance starts unverified. It is admitted only by a construction
 * in supportedStructures.ts: a present named balance with an explicit amount,
 * a direct "you owe £" / "please pay £" demand, or a revised "balance now
 * requested is £". A later restatement does not override a cancellation of
 * that same amount. An explicit reinstatement or a distinct new charge can.
 * Helpers below remain extra withholds. They are not the acceptance rule.
 *
 * Supported issue date: a bare date in the header preamble, or an explicit
 * Issued, Issue date, Notice date, Letter date, Statement date, or Dated
 * label. A generic Date: line is an issue date only in that header preamble,
 * and not under a payment, meter, activity, telephone, service, price, or
 * table heading. A date is not the issue date merely because it appears first.
 *
 * Supported payment instruction: it names the selected outstanding balance
 * or that claim's exact amount, and no other account, product, or copied
 * letter owns the sentence. Bare "it" or "this" is not enough when the
 * previous sentence is a different product or account. Position after a
 * balance is not ownership.
 *
 * Supported payment deadline: the date belongs to an owned payment
 * instruction or a labelled payment-due line for that same balance.
 * Supported correspondence deadline: respond or contact, with no payment
 * role. Two incompatible dates are conflicting and are withheld.
 *
 * Multiple independent debts: two current-balance claims that name different
 * bill periods are not one amount, even when the figures match. They are not
 * summed. Repeated mentions of one balance, including a later "amount due"
 * for the same figure without a new bill period, stay one claim (see K9).
 */

const MONTHS =
  "january|february|march|april|may|june|july|august|september|october|november|december";

/** Addressed to a model, parser, assistant, or bracketed system role. */
export function isModelOrParserDirected(sentence: string): boolean {
  const s = sentence.trim();
  if (/^\[\[?\s*(?:system|assistant|user|inst|model|parser)\b/i.test(s)) {
    return true;
  }
  if (
    /^(?:note\s+for\s+the\s+parser|to\s+the\s+(?:extraction\s+)?(?:model|parser)|instructions?\s+for\s+the\s+(?:parser|model|extractor))\s*[:,]/i.test(
      s
    )
  ) {
    return true;
  }
  return /^(?:assistant|gemini|claude|gpt-?\d*|chatgpt|copilot|parser)\s*,/i.test(s);
}

/**
 * The figure is predicted, hypothetical, or contingent. It is not a current balance.
 * Class: epistemic hedge on the copula, or a future condition that the figure
 * depends on. A pay-by date is not this class.
 */
export function isContingentBalanceStatement(sentence: string): boolean {
  return (
    /\b(?:is|be)\s+(?:expected|likely|projected|estimated|forecast)\s+to\s+be\b/i.test(sentence) ||
    /\b(?:could|might|may)\s+be\s+£/i.test(sentence) ||
    /\bwhen\s+the\s+\w+\s+(?:finishes|ends|completes|is\s+complete)\b/i.test(sentence) ||
    /\bafter\s+the\s+(?:meter\s+test|review|inspection)\b/i.test(sentence)
  );
}

/**
 * The sentence disposes of a balance instead of demanding it.
 * Class: completed coverage, satisfaction, zeroing, or a statement that
 * nothing further is owed. The exact probe wording is only an example.
 */
export function isCompletedDisposition(sentence: string): boolean {
  return (
    /\b(?:was|were|has\s+been|have\s+been|had\s+been|'ve)\s+(?:covered|met\s+in\s+full|taken\s+care\s+of|zeroed|resolved)\b/i.test(
      sentence
    ) ||
    /\bwe(?:'ve|\s+have)\s+zeroed\b/i.test(sentence) ||
    /\bnothing\s+further\s+is\s+required\b/i.test(sentence) ||
    /\bnothing\s+is\s+owed\b/i.test(sentence) ||
    /\b(?:has|have)\s+(?:now\s+)?been\s+resolved\b/i.test(sentence)
  );
}

/** A copied or reference-only letter. Instructions inside it are not the current demand. */
export function introducesHistoricalCopy(sentence: string): boolean {
  return (
    /\bcopy\s+of\s+(?:our|the|a|your|this)\b/i.test(sentence) ||
    /\bfor\s+reference\s+only\b/i.test(sentence)
  );
}

/**
 * Generic `Date:` is letterhead only when it is not after a full sentence and
 * the section heading does not name another date role.
 */
export function genericDateRowIsNotIssueDate(
  line: string,
  precedingHeaderLine: string | null | undefined
): boolean {
  if (
    /\b(?:effective|tariff|meter\s+reading|cancellation|correspondence|payment|activity|telephone|price)\b/i.test(
      line
    )
  ) {
    return true;
  }
  const header = (precedingHeaderLine ?? "").trim();
  if (!header || /[.!?]["'”’]?$/.test(header)) {
    return header.length > 0;
  }
  return /\b(?:meter|reading|payment|paid|effective|tariff|history|received|reference|period|activity|telephone|phone|service|price|table|call|correspondence|account\s+summary|direct\s+debit|next\s+collection|engineer|price\s+change|schedule)\b/i.test(
    header
  );
}

function competingProductOrAccount(sentence: string): boolean {
  return /\b(?:also\s+(?:due|overdue)|billed\s+separately|tv\s+licen[cs]e|parking|boiler\s+cover|gas\s+account|another\s+account|other\s+account|different\s+account|to\s+keep\s+your\b)\b/i.test(
    sentence
  );
}

function barePronounPayment(sentence: string): boolean {
  return (
    /\bpay\s+(?:it|this)\b/i.test(sentence) &&
    !/\b(?:outstanding\s+balance|amount\s+due)\b/i.test(sentence) &&
    !/£\s*\d/.test(sentence)
  );
}

function genericBalancePayment(sentence: string): boolean {
  return /\bpay\s+the\s+balance\b/i.test(sentence) && !/\boutstanding\b/i.test(sentence);
}

/**
 * True when this instruction may attach to the selected current balance.
 * Explicit "outstanding balance" or the claim's exact amount is required
 * once another product or account is in view. Bare it/this is accepted only
 * when the previous sentence is that claim and names no other product.
 */
export function instructionOwnsSelectedBalance(
  sentence: string,
  previousSentence: string | null,
  previousIsSelectedClaim: boolean
): boolean {
  if (introducesHistoricalCopy(sentence) || (previousSentence && introducesHistoricalCopy(previousSentence))) {
    return false;
  }
  const competing =
    competingProductOrAccount(sentence) ||
    (previousSentence !== null && !previousIsSelectedClaim && competingProductOrAccount(previousSentence));
  if (barePronounPayment(sentence) || (genericBalancePayment(sentence) && competing)) {
    if (competing) {
      return false;
    }
    return previousIsSelectedClaim && !(previousSentence && competingProductOrAccount(previousSentence));
  }
  if (competing && barePronounPayment(sentence)) {
    return false;
  }
  return true;
}

/** Month-named bill, invoice, or statement. Different labels are different debts. */
export function independentBillLabel(sentence: string): string | null {
  const match = new RegExp(
    `\\b(${MONTHS})\\s+(?:bill|invoice|statement)\\b|\\b(?:bill|invoice|statement)\\s+(?:for\\s+)?(${MONTHS})\\b`,
    "i"
  ).exec(sentence);
  const label = match?.[1] ?? match?.[2];
  return label ? label.toLowerCase() : null;
}

/**
 * Identity of a current claim. Amount is not an identity. A token is used
 * only when it distinguishes a debt (a digit, or a single invoice letter).
 * One sentence still yields one label.
 */
export function independentClaimLabel(sentence: string): string | null {
  const invoice = /\b(?:invoice|inv)\s*[-#:.]?\s*([a-z0-9]+)\b/i.exec(sentence);
  if (invoice && (/\d/.test(invoice[1]!) || /^[a-z]$/i.test(invoice[1]!))) {
    return `invoice:${invoice[1]!.toLowerCase()}`;
  }
  const account =
    /\baccount\s+(?:reference|number|no\.?)?\s*[:#-]?\s*([a-z0-9]+(?:-[a-z0-9]+)?)\b/i.exec(sentence);
  if (account && /\d/.test(account[1]!)) {
    return `account:${account[1]!.toLowerCase()}`;
  }
  const quarter = /\b(?:q([1-4])|quarter\s+([1-4])|(first|second|third|fourth)\s+quarter)\b/i.exec(
    sentence
  );
  if (quarter) {
    const part = (quarter[1] ?? quarter[2] ?? quarter[3] ?? "").toLowerCase();
    return `quarter:${part}`;
  }
  const product = /\b(electricity|gas|water|council\s+tax)\b/i.exec(sentence);
  const month = independentBillLabel(sentence);
  if (month && product) {
    return `${product[1]!.toLowerCase()}:${month}`;
  }
  if (month) {
    return `month:${month}`;
  }
  if (product) {
    return `product:${product[1]!.toLowerCase()}`;
  }
  return null;
}

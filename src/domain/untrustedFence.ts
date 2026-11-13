export const UNTRUSTED_DATA_BEGIN = "<<<NOTICELENS_UNTRUSTED_DATA>>>";
export const UNTRUSTED_DATA_END = "<<<END_NOTICELENS_UNTRUSTED_DATA>>>";

export class UntrustedDelimiterError extends Error {
  constructor() {
    super("Untrusted data contained a reserved delimiter");
    this.name = "UntrustedDelimiterError";
  }
}

/** Wraps data so it cannot close the fence or be concatenated into instructions. */
export function fenceUntrustedData(data: string): string {
  if (data.includes(UNTRUSTED_DATA_BEGIN) || data.includes(UNTRUSTED_DATA_END)) {
    throw new UntrustedDelimiterError();
  }
  return `${UNTRUSTED_DATA_BEGIN}\n${data}\n${UNTRUSTED_DATA_END}`;
}

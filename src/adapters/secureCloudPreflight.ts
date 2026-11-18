import { buildClosedCloudBrief } from "./buildClosedCloudBrief";
import { groundNoticeFacts } from "./groundNoticeFacts";
import { assessSupportedNotice, sourceGenerationId } from "./supportedNoticeGate";
import {
  approvalLifecycle,
  authoriseExactApproval,
  type ApprovalBinding,
} from "../domain/approvalRegistry";
import {
  CLOSED_CLOUD_BRIEF_LIMITS,
  canonicalClosedCloudBrief,
  ClosedCloudBriefValidationError,
} from "../domain/closedCloudBrief";
import { normalizeNewlines } from "../domain/textNormalize";

/**
 * Simulated authorisation for a future network request.
 *
 * The live notice text is read again. A previous eligibility result, a
 * generation hash, a caller boolean, and model text are not authority.
 * PREFLIGHT_READY consumes one Phase 4B approval and still does not send.
 * It is not live send-time enforcement.
 */

export type CloudPreflightState =
  | "PREFLIGHT_READY"
  | "SOURCE_NOT_ELIGIBLE"
  | "SOURCE_CHANGED"
  | "APPROVAL_MISSING"
  | "APPROVAL_INVALIDATED"
  | "APPROVAL_ALREADY_CONSUMED"
  | "APPROVAL_CONTEXT_MISMATCH"
  | "PAYLOAD_NONCANONICAL"
  | "PAYLOAD_CHANGED"
  | "UNSUPPORTED_GOAL_OR_FLAGS";

export interface CloudPreflightDecision {
  readonly state: CloudPreflightState;
  readonly authorisesSend: false;
  readonly consumed: boolean;
}

/**
 * Fields the production screen already holds. There is no approved,
 * eligible, or trusted flag. Model text is not an input.
 */
export interface LiveCloudPreflightState {
  readonly rawNoticeText: string;
  readonly today: string;
  /** Recomputed and compared. A match is only a staleness check. */
  readonly presentedSourceGenerationId: string;
  readonly noticeGeneration: number;
  readonly extractionGeneration: number;
  readonly identifierContextId: string;
  readonly documentContextId: string;
  readonly responseGoal: string;
  readonly circumstanceFlags: readonly string[];
  /** Exact bytes shown in the privacy modal. */
  readonly presentedCanonicalBytes: string;
  readonly approvalHandle: unknown;
}

const SUPPORTED_GOAL = "request_billing_review";

const FORBIDDEN_PAYLOAD_TEXT = [
  "Sarah Example",
  "EXAMPLE-8472",
  "example-8472",
  "14 Example Road",
  "RG0 0AA",
  "Our records show an outstanding balance of £1,280",
  "the balance now requested is £520",
];

function decide(state: CloudPreflightState, consumed = false): CloudPreflightDecision {
  return Object.freeze({
    state,
    authorisesSend: false,
    consumed: state === "PREFLIGHT_READY" ? consumed : false,
  });
}

function unsupportedChoice(goal: unknown, flags: unknown): boolean {
  if (goal !== SUPPORTED_GOAL || !Array.isArray(flags) || flags.length !== 0) {
    return true;
  }
  return flags.some((flag) => typeof flag !== "string");
}

function jsonHasDuplicateKeys(text: string): boolean {
  let index = 0;

  function peek(): string {
    return text[index] ?? "";
  }

  function skipWhitespace(): void {
    while (index < text.length) {
      const char = text[index];
      if (char !== " " && char !== "\n" && char !== "\r" && char !== "\t") {
        return;
      }
      index += 1;
    }
  }

  function readString(): string {
    if (peek() !== '"') {
      throw new Error("string");
    }
    index += 1;
    let value = "";
    while (index < text.length) {
      const char = text[index] ?? "";
      index += 1;
      if (char === '"') {
        return value;
      }
      if (char !== "\\") {
        value += char;
        continue;
      }
      const escape = text[index] ?? "";
      index += 1;
      if (escape === "u") {
        const hex = text.slice(index, index + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw new Error("hex");
        }
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 4;
        continue;
      }
      const mapped: Record<string, string> = {
        '"': '"',
        "\\": "\\",
        "/": "/",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
      };
      const decoded = mapped[escape];
      if (decoded === undefined) {
        throw new Error("escape");
      }
      value += decoded;
    }
    throw new Error("unterminated");
  }

  function skipLiteral(): void {
    if (peek() === '"') {
      readString();
      return;
    }
    if (text.startsWith("true", index) || text.startsWith("null", index)) {
      index += 4;
      return;
    }
    if (text.startsWith("false", index)) {
      index += 5;
      return;
    }
    if (peek() !== "-" && (peek() < "0" || peek() > "9")) {
      throw new Error("literal");
    }
    readNumber();
  }

  function readDigits(): void {
    if (peek() < "0" || peek() > "9") {
      throw new Error("number");
    }
    while (peek() >= "0" && peek() <= "9") {
      index += 1;
    }
  }

  function readNumber(): void {
    if (peek() === "-") {
      index += 1;
    }
    if (peek() === "0") {
      index += 1;
      if (peek() >= "0" && peek() <= "9") {
        throw new Error("number");
      }
    } else {
      readDigits();
    }
    if (peek() === ".") {
      index += 1;
      readDigits();
    }
    if (peek() === "e" || peek() === "E") {
      index += 1;
      if (peek() === "+" || peek() === "-") {
        index += 1;
      }
      readDigits();
    }
  }

  function readValue(): boolean {
    skipWhitespace();
    if (peek() === "{") {
      return readObject();
    }
    if (peek() === "[") {
      return readArray();
    }
    skipLiteral();
    return false;
  }

  function readArray(): boolean {
    index += 1;
    let duplicate = false;
    skipWhitespace();
    if (peek() === "]") {
      index += 1;
      return false;
    }
    while (index < text.length) {
      if (readValue()) {
        duplicate = true;
      }
      skipWhitespace();
      if (peek() === ",") {
        index += 1;
        continue;
      }
      if (peek() === "]") {
        index += 1;
        return duplicate;
      }
      throw new Error("array");
    }
    throw new Error("array");
  }

  function readObject(): boolean {
    index += 1;
    const seen = new Set<string>();
    let duplicate = false;
    skipWhitespace();
    if (peek() === "}") {
      index += 1;
      return false;
    }
    while (index < text.length) {
      skipWhitespace();
      const key = readString();
      if (seen.has(key)) {
        duplicate = true;
      }
      seen.add(key);
      skipWhitespace();
      if (peek() !== ":") {
        throw new Error("colon");
      }
      index += 1;
      if (readValue()) {
        duplicate = true;
      }
      skipWhitespace();
      if (peek() === ",") {
        index += 1;
        continue;
      }
      if (peek() === "}") {
        index += 1;
        return duplicate;
      }
      throw new Error("object");
    }
    throw new Error("object");
  }

  const duplicate = readValue();
  skipWhitespace();
  if (index !== text.length) {
    throw new Error("trailing");
  }
  return duplicate;
}

function payloadContainsRawIdentifier(serialized: string): boolean {
  return FORBIDDEN_PAYLOAD_TEXT.some((token) => serialized.includes(token));
}

function snapshotLive(
  live: unknown
): { ok: true; value: LiveCloudPreflightState } | { ok: false; state: CloudPreflightState } {
  try {
    if (live === null || typeof live !== "object") {
      return { ok: false, state: "SOURCE_NOT_ELIGIBLE" };
    }
    const source = live as Record<string, unknown>;
    const rawNoticeText = source.rawNoticeText;
    const today = source.today;
    const presentedSourceGenerationId = source.presentedSourceGenerationId;
    const noticeGeneration = source.noticeGeneration;
    const extractionGeneration = source.extractionGeneration;
    const identifierContextId = source.identifierContextId;
    const documentContextId = source.documentContextId;
    const responseGoal = source.responseGoal;
    const circumstanceFlags = source.circumstanceFlags;
    const presentedCanonicalBytes = source.presentedCanonicalBytes;
    const approvalHandle = source.approvalHandle;
    let flags: readonly string[];
    if (Array.isArray(circumstanceFlags)) {
      const copied: string[] = [];
      for (let index = 0; index < circumstanceFlags.length; index += 1) {
        copied.push(circumstanceFlags[index] as string);
      }
      flags = copied;
    } else {
      flags = circumstanceFlags as readonly string[];
    }
    return {
      ok: true,
      value: {
        rawNoticeText: rawNoticeText as string,
        today: today as string,
        presentedSourceGenerationId: presentedSourceGenerationId as string,
        noticeGeneration: noticeGeneration as number,
        extractionGeneration: extractionGeneration as number,
        identifierContextId: identifierContextId as string,
        documentContextId: documentContextId as string,
        responseGoal: responseGoal as string,
        circumstanceFlags: flags,
        presentedCanonicalBytes: presentedCanonicalBytes as string,
        approvalHandle,
      },
    };
  } catch {
    return { ok: false, state: "SOURCE_NOT_ELIGIBLE" };
  }
}

/**
 * Order: one snapshot of the inputs, supported goal and flags, live generation
 * marker, live eligibility, canonical bytes, then one Phase 4B consumption.
 * A failed check does not consume and does not restore a handle.
 * Caller booleans are not read.
 */
export function evaluateCloudPreflight(live: LiveCloudPreflightState): CloudPreflightDecision {
  const snapshot = snapshotLive(live);
  if (!snapshot.ok) {
    return decide(snapshot.state);
  }
  const input = snapshot.value;
  if (unsupportedChoice(input.responseGoal, input.circumstanceFlags)) {
    return decide("UNSUPPORTED_GOAL_OR_FLAGS");
  }
  if (typeof input.rawNoticeText !== "string" || typeof input.today !== "string") {
    return decide("SOURCE_NOT_ELIGIBLE");
  }

  const text = normalizeNewlines(input.rawNoticeText);
  const liveGenerationId = sourceGenerationId(text);
  if (input.presentedSourceGenerationId !== liveGenerationId) {
    return decide("SOURCE_CHANGED");
  }

  let eligible = false;
  try {
    eligible = assessSupportedNotice({ rawNoticeText: text, today: input.today }).state === "DEMO_ELIGIBLE";
  } catch {
    eligible = false;
  }
  if (!eligible) {
    return decide("SOURCE_NOT_ELIGIBLE");
  }

  if (
    typeof input.presentedCanonicalBytes !== "string" ||
    input.presentedCanonicalBytes.length === 0 ||
    input.presentedCanonicalBytes.length > CLOSED_CLOUD_BRIEF_LIMITS.maxSerializedLength
  ) {
    return decide("PAYLOAD_NONCANONICAL");
  }

  let duplicateKeys = false;
  try {
    duplicateKeys = jsonHasDuplicateKeys(input.presentedCanonicalBytes);
  } catch {
    return decide("PAYLOAD_NONCANONICAL");
  }
  if (duplicateKeys || payloadContainsRawIdentifier(input.presentedCanonicalBytes)) {
    return decide("PAYLOAD_NONCANONICAL");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.presentedCanonicalBytes);
  } catch {
    return decide("PAYLOAD_NONCANONICAL");
  }

  let presentedCanonical: string;
  try {
    presentedCanonical = canonicalClosedCloudBrief(parsed).serialized;
  } catch (error) {
    if (error instanceof ClosedCloudBriefValidationError) {
      return decide("PAYLOAD_NONCANONICAL");
    }
    throw error;
  }
  if (presentedCanonical !== input.presentedCanonicalBytes) {
    return decide("PAYLOAD_CHANGED");
  }

  let rebuilt: string;
  try {
    const view = groundNoticeFacts({ rawNoticeText: text, today: input.today });
    rebuilt = buildClosedCloudBrief({
      view,
      responseGoal: SUPPORTED_GOAL,
    }).serialized;
  } catch (error) {
    if (error instanceof ClosedCloudBriefValidationError) {
      return decide("PAYLOAD_NONCANONICAL");
    }
    throw error;
  }
  if (rebuilt !== input.presentedCanonicalBytes || payloadContainsRawIdentifier(rebuilt)) {
    return decide(payloadContainsRawIdentifier(rebuilt) ? "PAYLOAD_NONCANONICAL" : "PAYLOAD_CHANGED");
  }

  const status = approvalLifecycle(input.approvalHandle);
  if (status === "INVALIDATED") {
    return decide("APPROVAL_INVALIDATED");
  }
  if (status === "CONSUMED") {
    return decide("APPROVAL_ALREADY_CONSUMED");
  }
  if (status !== "APPROVED") {
    return decide("APPROVAL_MISSING");
  }

  const binding: ApprovalBinding = {
    schema: "noticelens.cloud-brief.v2",
    canonicalBytes: rebuilt,
    noticeGeneration: input.noticeGeneration,
    identifierContextId: input.identifierContextId,
    responseGoal: SUPPORTED_GOAL,
    circumstanceFlags: [],
    extractionGeneration: input.extractionGeneration,
    documentContextId: input.documentContextId,
  };
  const authorised = authoriseExactApproval(input.approvalHandle, binding);
  if (!authorised.ok || approvalLifecycle(input.approvalHandle) !== "CONSUMED") {
    if (authorised.ok) {
      return decide("APPROVAL_ALREADY_CONSUMED");
    }
    if (authorised.reason === "invalidated") {
      return decide("APPROVAL_INVALIDATED");
    }
    if (authorised.reason === "already-consumed") {
      return decide("APPROVAL_ALREADY_CONSUMED");
    }
    if (authorised.reason === "missing-handle" || authorised.reason === "not-approved" || authorised.reason === "stale-handle") {
      return decide("APPROVAL_MISSING");
    }
    return decide("APPROVAL_CONTEXT_MISMATCH");
  }

  return decide("PREFLIGHT_READY", true);
}

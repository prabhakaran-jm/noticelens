export type ChromeModelAvailabilityState =
  | "available"
  | "downloadable"
  | "downloading"
  | "unavailable"
  | "api_missing"
  | "probe_error";

export interface ChromeCapabilityReport {
  hasLanguageModelGlobal: boolean;
  availability: ChromeModelAvailabilityState;
  userAgent: string;
  isOnline: boolean;
  errorDetail: string | null;
  checkedAtIso: string;
}

interface ChromeLanguageModelGlobal {
  availability: (options?: {
    expectedInputs?: Array<{ type: "text"; languages?: string[] }>;
    expectedOutputs?: Array<{ type: "text"; languages?: string[] }>;
  }) => Promise<string>;
}

export async function probeChromeLanguageModelAvailability(): Promise<ChromeCapabilityReport> {
  const checkedAtIso = new Date().toISOString();
  const userAgent =
    typeof navigator !== "undefined" ? navigator.userAgent : "non-browser";
  const isOnline =
    typeof navigator !== "undefined" ? navigator.onLine : false;

  const globalScope = globalThis as unknown as {
    LanguageModel?: ChromeLanguageModelGlobal;
  };

  if (
    !globalScope.LanguageModel ||
    typeof globalScope.LanguageModel.availability !== "function"
  ) {
    return {
      hasLanguageModelGlobal: false,
      availability: "api_missing",
      userAgent,
      isOnline,
      errorDetail:
        "self.LanguageModel is not exposed in this browser context. Use Desktop Chrome 139+ (148+ recommended).",
      checkedAtIso,
    };
  }

  try {
    const rawState = await globalScope.LanguageModel.availability({
      expectedInputs: [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }],
    });

    const normalized: ChromeModelAvailabilityState =
      rawState === "available" ||
      rawState === "downloadable" ||
      rawState === "downloading" ||
      rawState === "unavailable"
        ? rawState
        : "probe_error";

    return {
      hasLanguageModelGlobal: true,
      availability: normalized,
      userAgent,
      isOnline,
      errorDetail:
        normalized === "probe_error"
          ? `Unexpected availability status: ${String(rawState)}`
          : null,
      checkedAtIso,
    };
  } catch (err) {
    return {
      hasLanguageModelGlobal: true,
      availability: "probe_error",
      userAgent,
      isOnline,
      errorDetail: err instanceof Error ? err.message : String(err),
      checkedAtIso,
    };
  }
}

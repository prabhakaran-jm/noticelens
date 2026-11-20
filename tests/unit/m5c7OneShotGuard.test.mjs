import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  armGenerationGuard,
  buildRunRecord,
  claimGenerationRoute,
  classifyConfigValue,
  createGenerationGuardState,
  diagnosticIdentifierNames,
  generationPreflightPasses,
  oneShotSkippedPhase,
  persistThenCleanup,
  resolveAppCheckLaunch,
  retryAfterHttpStatus,
  viteDebugTokenAssignment,
  writeSanitisedEvidence,
} from "../../scripts/verify-approved-cloud-chrome.mjs";

const EXACT = JSON.stringify({ schemaVersion: "noticelens.cloud-brief.v2", amountsGBP: [1280] });

function requestBody(extra = "") {
  return JSON.stringify({
    contents: [
      {
        parts: [
          {
            text: `USER-APPROVED REDACTED STRUCTURAL BRIEF:\n${EXACT}\n${extra}`,
          },
        ],
      },
    ],
  });
}

describe("one-shot generation guard", () => {
  it("aborts every generation request before Send", () => {
    const state = createGenerationGuardState();
    const decision = claimGenerationRoute(state, requestBody());
    expect(decision.action).toBe("abort");
    expect(decision.reason).toBe("before-send");
    expect(state.reached).toBe(0);
  });

  it("allows one body that matches the approved canonical text and then aborts the next", () => {
    const state = createGenerationGuardState();
    armGenerationGuard(state, EXACT);
    const first = claimGenerationRoute(state, requestBody());
    const second = claimGenerationRoute(state, requestBody());
    const retry = claimGenerationRoute(state, requestBody());
    expect(first.action).toBe("continue");
    expect(generationPreflightPasses(first.inspection)).toBe(true);
    expect(second.action).toBe("abort");
    expect(second.reason).toBe("extra");
    expect(retry.reason).toBe("extra");
    expect(state.reached).toBe(1);
  });

  it("aborts a body that misses the canonical text, a raw marker, or a recovered 760", () => {
    const missing = createGenerationGuardState();
    armGenerationGuard(missing, EXACT);
    expect(claimGenerationRoute(missing, JSON.stringify({ contents: [{ parts: [{ text: "hello" }] }] })).reason).toBe(
      "preflight"
    );
    expect(missing.reached).toBe(0);
    expect(missing.preflightFailed).toBe(true);

    const marked = createGenerationGuardState();
    armGenerationGuard(marked, EXACT);
    expect(claimGenerationRoute(marked, requestBody("Sarah Example")).reason).toBe("preflight");
    expect(marked.reached).toBe(0);

    const recovered = createGenerationGuardState();
    armGenerationGuard(recovered, EXACT);
    expect(claimGenerationRoute(recovered, requestBody("recovered £760")).reason).toBe("preflight");
    expect(recovered.reached).toBe(0);
  });

  it("does not execute a second Send in one-shot mode", () => {
    const checks = oneShotSkippedPhase();
    expect(checks.map((item) => item.name)).toEqual([
      "second-approval",
      "double-submit",
      "transport-cancellation",
      "negative-app-check-probe",
    ]);
    for (const check of checks) {
      expect(check.status).toBe("NOT TESTED");
    }
    expect(checks.some((item) => /click|second Send was sent|retry/i.test(item.detail) && item.status === "PASS")).toBe(
      false
    );
  });
});

const READY = {
  oneShot: true,
  mode: "registered-debug",
  host: "127.0.0.1",
  viteDev: true,
  tokenStatus: "CONFIGURED",
};

describe("registered-debug App Check mode", () => {
  it("requires the one-shot opt-in before a local debug token can be passed", () => {
    const accepted = resolveAppCheckLaunch(READY);
    expect(accepted.ok).toBe(true);
    expect(accepted.passDebugToken).toBe(true);
    expect(accepted).not.toHaveProperty("token");

    const fresh = resolveAppCheckLaunch({ ...READY, mode: "fresh-recaptcha" });
    expect(fresh.ok).toBe(true);
    expect(fresh.passDebugToken).toBe(false);
    expect(resolveAppCheckLaunch({ ...READY, mode: undefined }).passDebugToken).toBe(false);
    const passed = viteDebugTokenAssignment({ ...accepted, host: "127.0.0.1" }, "11111111-1111-4111-8111-111111111111");
    expect(passed.pass).toBe(true);
    expect(passed.assign).not.toBe("");
    expect(viteDebugTokenAssignment(accepted, "").assign).toBe(null);
    expect(viteDebugTokenAssignment({ ...accepted, host: "example.com" }, "11111111-1111-4111-8111-111111111111").assign).toBe("");
    expect(viteDebugTokenAssignment(fresh, "11111111-1111-4111-8111-111111111111").assign).toBe("");
  });

  it("fails closed for a missing token, an empty token, and the wrong mode", () => {
    expect(resolveAppCheckLaunch({ ...READY, tokenStatus: "MISSING" }).ok).toBe(false);
    expect(resolveAppCheckLaunch({ ...READY, tokenStatus: "EMPTY" }).ok).toBe(false);
    expect(resolveAppCheckLaunch({ ...READY, tokenStatus: "INVALID FORMAT" }).ok).toBe(false);
    expect(resolveAppCheckLaunch({ ...READY, mode: "debug" }).reason).toBe("wrong-mode");
    expect(resolveAppCheckLaunch({ ...READY, oneShot: false }).reason).toBe("one-shot-required");
  });

  it("blocks production builds and public hosts", () => {
    expect(resolveAppCheckLaunch({ ...READY, viteDev: false }).reason).toBe("vite-dev-required");
    expect(resolveAppCheckLaunch({ ...READY, host: "localhost" }).reason).toBe("loopback-required");
    expect(resolveAppCheckLaunch({ ...READY, host: "example.com" }).reason).toBe("loopback-required");
    expect(resolveAppCheckLaunch({ ...READY, host: "noticelens-2026.web.app" }).ok).toBe(false);
  });

  it("classifies config without calling fetch", () => {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = (url) => {
      calls.push(String(url));
      return Promise.reject(new Error("network"));
    };
    try {
      expect(classifyConfigValue("VITE_FIREBASE_API_KEY", undefined)).toBe("MISSING");
      expect(classifyConfigValue("VITE_FIREBASE_API_KEY", "   ")).toBe("EMPTY");
      expect(classifyConfigValue("VITE_FIREBASE_API_KEY", "not-a-key")).toBe("INVALID FORMAT");
      expect(classifyConfigValue("VITE_FIREBASE_API_KEY", `AIza${"A".repeat(35)}`)).toBe("CONFIGURED");
      expect(classifyConfigValue("VITE_FIREBASE_PROJECT_ID", "noticelens-2026")).toBe("CONFIGURED");
      expect(classifyConfigValue("VITE_FIREBASE_PROJECT_ID", "other-project")).toBe("INVALID FORMAT");
      expect(classifyConfigValue("VITE_FIREBASE_AUTH_DOMAIN", "")).toBe("EMPTY");
      expect(classifyConfigValue("VITE_FIREBASE_APP_ID", "1:1:web:abc")).toBe("CONFIGURED");
      expect(classifyConfigValue("VITE_FIREBASE_APPCHECK_SITE_KEY", "6Lexamplekeyexamplekey12")).toBe("CONFIGURED");
      expect(classifyConfigValue("VITE_FIREBASE_APPCHECK_DEBUG_TOKEN", "true")).toBe("INVALID FORMAT");
      expect(classifyConfigValue("VITE_FIREBASE_APPCHECK_DEBUG_TOKEN", "11111111-1111-4111-8111-111111111111")).toBe(
        "CONFIGURED"
      );
      expect(calls).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("diagnostic salutation scanner", () => {
  it("does not report an accepted generic salutation as an identifier", () => {
    expect(diagnosticIdentifierNames("Dear Sir or Madam,")).not.toContain("dear");
    expect(diagnosticIdentifierNames("Dear Sir/Madam,")).not.toContain("dear");
    expect(diagnosticIdentifierNames("Dear Customer Services,")).not.toContain("dear");
    expect(diagnosticIdentifierNames("Dear [RECIPIENT_NAME],")).not.toContain("dear");
    expect(diagnosticIdentifierNames("Dear Sarah Example,")).toContain("dear");
    expect(diagnosticIdentifierNames("Dear Sir or Madam, Sarah Example")).toContain("dear");
  });
});

describe("one-shot evidence preservation", () => {
  it("does not retry an HTTP 401", () => {
    expect(retryAfterHttpStatus(401)).toBe(false);
    expect(retryAfterHttpStatus(403)).toBe(false);
    expect(retryAfterHttpStatus(200)).toBe(false);
    expect(retryAfterHttpStatus(undefined)).toBe(false);
  });

  it("keeps the sanitised outcome when profile cleanup fails and stores no secrets", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m5c7-evidence-"));
    const preserved = path.join(dir, "m5c7-one-shot-evidence.json");
    const target = path.join(dir, "next-evidence.json");
    fs.writeFileSync(preserved, "{\"preserved\":true}\n");
    const fakeKey = `AIza${"B".repeat(35)}`;
    const safe = await persistThenCleanup(
      {
        httpStatus: 401,
        token: "11111111-1111-4111-8111-111111111111",
        apiKey: fakeKey,
        detail: `Bearer sample.token.value ${fakeKey}`,
        checks: [{ name: "model-result", status: "FAIL" }],
      },
      target,
      async () => {
        throw new Error("EPERM");
      },
      preserved
    );
    const text = fs.readFileSync(target, "utf8");
    expect(safe.httpStatus).toBe(401);
    expect(text).toContain("\"httpStatus\": 401");
    expect(text).toContain("FAIL");
    expect(text).not.toContain("11111111");
    expect(text).not.toContain("AIza");
    expect(text).not.toContain("sample.token");
    const record = buildRunRecord({
      httpStatus: 401,
      inferenceLabel: null,
      modelLabel: null,
      appCheckHeaderPresent: true,
      attempts: 1,
      allowed: 1,
      blocked: 1,
      canonicalVerified: true,
      accepted: false,
      rejected: true,
      violations: ["draft mentions a personal identifier", "Dear Sarah Example,"],
      prepareReplyShowedDraft: false,
    });
    expect(record.inferenceSource).toBe(null);
    expect(record.model).toBe(null);
    expect(record.appCheckHeaderPresent).toBe(true);
    expect(record.allowed).toBe(1);
    expect(record.blocked).toBe(1);
    expect(record.violationCategories).toEqual(["personal-identifier", "unclassified"]);
    expect(JSON.stringify(record)).not.toContain("Sarah");
    expect(fs.readFileSync(preserved, "utf8")).toBe("{\"preserved\":true}\n");
    expect(() => writeSanitisedEvidence({ httpStatus: 500 }, preserved, preserved)).toThrow(/preserved/);
    expect(fs.readFileSync(preserved, "utf8")).toBe("{\"preserved\":true}\n");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

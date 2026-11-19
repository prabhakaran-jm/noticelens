/**
 * Real Chrome check of the privacy-approved Firebase drafting path.
 * This is not scripts/verify-real-chrome.mjs. That older script drives the
 * Milestone 0 spike harness. This one uses the production screen, the privacy
 * modal, and one explicit Send.
 *
 * It writes a sanitised evidence file. It does not print request bodies,
 * credentials, App Check tokens, or the model response.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

const CHROME_EXE = process.env.NOTICELENS_CHROME_EXE || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEV_URL = process.env.NOTICELENS_DEV_URL || "http://127.0.0.1:5174";
const CDP_PORT = Number(process.env.NOTICELENS_CDP_PORT || "9336");
const EVIDENCE_PATH =
  process.env.NOTICELENS_EVIDENCE_PATH ||
  path.resolve("tmp", "m5c6-approved-cloud-evidence.json");
const APP_CHECK_HEADER = "x-firebase-appcheck";
// A future negative probe, if one is explicitly authorised, must use a
// minimal non-sensitive body and must not send the approved generation body.
// That minimal body is not equivalent to the successful model request.
// Classify a response as App Check enforcement only when it gives an
// App Check-specific rejection reason. HTTP 401 or 403 alone is not App
// Check enforcement and stays INCONCLUSIVE. Do not send that probe
// automatically: a request to the model host could start a paid generation.
const MINIMAL_APP_CHECK_DIAGNOSTIC_BODY = "{}";
const RAW_MARKERS = ["Sarah Example", "EXAMPLE-8472", "14 Example Road", "RG0 0AA"];
const GENERATION_HOSTS = ["firebasevertexai.googleapis.com", "generativelanguage.googleapis.com"];
const APP_CHECK_HOSTS = [
  "content-firebaseappcheck.googleapis.com",
  "firebaseappcheck.googleapis.com",
  "recaptchaenterprise.googleapis.com",
];

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function classify(url) {
  const host = hostOf(url);
  if (GENERATION_HOSTS.some((item) => host === item || host.endsWith(`.${item}`))) {
    return "generation";
  }
  if (APP_CHECK_HOSTS.some((item) => host === item || host.endsWith(`.${item}`))) {
    return "app_check";
  }
  return "other";
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function checkStatus(name, status, detail) {
  return { name, status, detail };
}

async function isHttpUp(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureVite() {
  if (await isHttpUp(DEV_URL)) {
    return {
      startedByScript: false,
      stop: async () => {},
      note: "An existing server answered. Fresh reCAPTCHA Enterprise attestation is unverified.",
    };
  }
  const viteBin = path.resolve("node_modules", "vite", "bin", "vite.js");
  const parsed = new URL(DEV_URL);
  const proc = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", parsed.port, "--strictPort"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      VITE_NOTICELENS_REAL_CLOUD_DIAGNOSTIC: "1",
      VITE_FIREBASE_APPCHECK_DEBUG_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await isHttpUp(DEV_URL)) {
      return {
        startedByScript: true,
        stop: async () => proc.kill(),
        note: "Started Vite with the diagnostic flag, an empty debug-token variable, and a fresh temporary Chrome profile. That is the reCAPTCHA Enterprise setup. It is not a completed attestation.",
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  proc.kill();
  throw new Error(`Timed out waiting for ${DEV_URL}`);
}

async function launchChrome() {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "noticelens-m5c6-chrome-"));
  const chrome = spawn(
    CHROME_EXE,
    [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${CDP_PORT}`,
      "--no-first-run",
      "--no-default-browser-check",
      DEV_URL,
    ],
    { stdio: "ignore" }
  );
  const cdpUrl = `http://127.0.0.1:${CDP_PORT}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await isHttpUp(`${cdpUrl}/json/version`)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const browser = await chromium.connectOverCDP(cdpUrl);
  return {
    browser,
    closeAll: async () => {
      try {
        await browser.close();
      } catch {
        // The browser may already be gone.
      }
      try {
        chrome.kill();
      } catch {
        // The process may already have exited.
      }
      fs.rmSync(profileDir, { recursive: true, force: true });
    },
  };
}

function collectStrings(value, out) {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, out);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectStrings(item, out);
    }
  }
}

function inspectBody(body, exact) {
  const markers = {};
  for (const marker of RAW_MARKERS) {
    markers[marker] = body.includes(marker);
  }
  const strings = [];
  let parsed = false;
  try {
    collectStrings(JSON.parse(body), strings);
    parsed = true;
  } catch {
    parsed = false;
  }
  const exactInParsed = exact.length > 0 && strings.some((item) => item.includes(exact));
  const joined = strings.join("\n");
  return {
    byteLength: body.length,
    fingerprint: fingerprint(body),
    parsed,
    containsExactApprovedBytes: exact.length > 0 && (body.includes(exact) || exactInParsed),
    exactMatch: body.includes(exact) ? "raw" : exactInParsed ? "parsed-json" : "none",
    containsFixedBriefLabel:
      body.includes("USER-APPROVED REDACTED STRUCTURAL BRIEF") ||
      joined.includes("USER-APPROVED REDACTED STRUCTURAL BRIEF"),
    containsRecovered760: (/760/.test(body) || /760/.test(joined)) && /recover/i.test(`${body}\n${joined}`),
    markerPresent: markers,
    anyMarkerPresent: Object.values(markers).some(Boolean) || RAW_MARKERS.some((marker) => joined.includes(marker)),
  };
}

function summariseModelResponse(text) {
  const summary = { httpJson: false, modelJson: false, modelKeys: null };
  let parsed;
  try {
    parsed = JSON.parse(text);
    summary.httpJson = true;
  } catch {
    return summary;
  }
  const candidates = [];
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    candidates.push(parsed);
  }
  const strings = [];
  collectStrings(parsed, strings);
  for (const item of strings) {
    try {
      const inner = JSON.parse(item);
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        candidates.push(inner);
      }
    } catch {
      // The string is not a JSON object.
    }
  }
  const draft = candidates.find((item) =>
    ["summaryPlainEnglish", "options", "replyTemplateWithPlaceholders", "citedGuidanceIds"].some((key) => key in item)
  );
  if (draft) {
    summary.modelJson = true;
    summary.modelKeys = Object.keys(draft).sort();
    summary.identifierPatterns = identifierPatterns(draft);
  }
  return summary;
}

const IDENTIFIER_PATTERNS = [
  ["email", /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/],
  ["postcode", /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i],
  ["phone", /\b(?:\+44\d{10}|0\d{10,11})\b/],
  ["reference", /\b[A-Z]{2,}[-/]\d{3,}\b/],
  ["dear", /\bDear\s+[A-Z][a-z]{2,}\b/],
  ["longDigits", /\b\d{6,}\b/],
];

function identifierPatterns(draft) {
  const hits = {};
  const visit = (value, label) => {
    if (typeof value === "string") {
      const stripped = value.replace(/\[[A-Z0-9_]+\]/g, " ");
      const matched = IDENTIFIER_PATTERNS.filter(([, pattern]) => pattern.test(stripped)).map(([name]) => name);
      if (matched.length > 0) {
        hits[label] = matched;
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${label}[${index}]`));
    }
  };
  for (const [key, value] of Object.entries(draft)) {
    if (key === "options" && Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item && typeof item === "object") {
          for (const [field, text] of Object.entries(item)) {
            visit(text, `options[${index}].${field}`);
          }
        }
      });
      continue;
    }
    visit(value, key);
  }
  return hits;
}

async function approve(page) {
  await page.getByTestId("nav-reply").click();
  await page.getByRole("button", { name: "Review privacy approval" }).click();
  await page.getByRole("checkbox", { name: "I have reviewed this exact payload" }).check();
  await page.getByTestId("privacy-approve").click();
  await page.getByRole("button", { name: "Close" }).click();
}

async function main() {
  const started = Date.now();
  const evidence = {
    script: "scripts/verify-approved-cloud-chrome.mjs",
    notTheM0Harness: true,
    startedAt: new Date().toISOString(),
    chromeExecutablePresent: fs.existsSync(CHROME_EXE),
    devUrlHost: new URL(DEV_URL).hostname,
    checks: [],
    requests: {
      beforeSend: { generation: 0, appCheck: 0, otherExternal: 0 },
      duringSend: { generation: 0, appCheck: 0, otherExternal: 0 },
      generationStatuses: [],
      cancelledGenerationCount: 0,
    },
    body: null,
    ui: {},
    os: `${os.type()} ${os.release()}`,
    chromeVersion: null,
  };

  if (!evidence.chromeExecutablePresent) {
    evidence.checks.push(checkStatus("chrome-launch", "BLOCKED", "Chrome executable was not found."));
    writeEvidence(evidence);
    process.exitCode = 2;
    return;
  }
  if (evidence.devUrlHost !== "127.0.0.1") {
    evidence.checks.push(checkStatus("loopback", "FAIL", "The diagnostic URL is not 127.0.0.1."));
    writeEvidence(evidence);
    process.exitCode = 1;
    return;
  }

  const server = await ensureVite();
  evidence.vite = { startedByScript: server.startedByScript, note: server.note };
  evidence.checks.push(
    checkStatus(
      "fresh-recaptcha-enterprise",
      "NOT TESTED",
      server.startedByScript
        ? "This script started the diagnostic server. Fresh reCAPTCHA Enterprise attestation is still unverified until an App Check header from that process is recorded."
        : "An existing Vite server was reused. Fresh reCAPTCHA Enterprise attestation is unverified."
    )
  );
  const { browser, closeAll } = await launchChrome();
  const seen = [];
  try {
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error("Chrome did not expose a browser context.");
    }
    const version = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((response) => response.json());
    evidence.chromeVersion = typeof version.Browser === "string" ? version.Browser : null;
    const page = context.pages().find((item) => item.url().startsWith(DEV_URL)) ?? (await context.newPage());
    page.on("request", (request) => {
      const url = request.url();
      if (url.startsWith("http://127.0.0.1") || url.startsWith("data:")) {
        return;
      }
      seen.push({
        phase: "before-send",
        method: request.method(),
        host: hostOf(url),
        kind: classify(url),
        body: request.postData() ?? "",
        request,
      });
    });
    await page.goto(DEV_URL, { waitUntil: "networkidle" });
    await page.getByTestId("nav-reply").click();
    const diagnosticVisible = await page.getByTestId("real-cloud-diagnostic").count();
    evidence.checks.push(
      checkStatus(
        "diagnostic-visible",
        diagnosticVisible === 1 ? "PASS" : "BLOCKED",
        diagnosticVisible === 1
          ? "The loopback diagnostic label is visible."
          : "The diagnostic label is absent. The Vite process may not have the opt-in flag."
      )
    );
    if (diagnosticVisible !== 1) {
      writeEvidence(evidence);
      process.exitCode = 2;
      return;
    }
    await page.getByRole("button", { name: "Review privacy approval" }).click();
    await page.getByRole("button", { name: "Close" }).click();
    await page.getByTestId("nav-read").click();
    const notice = page.getByTestId("notice-text");
    const current = await notice.inputValue();
    await notice.fill(`${current}\n`);
    await page.waitForTimeout(400);
    await notice.fill(current);
    await page.waitForTimeout(400);
    await page.getByTestId("nav-reply").click();

    const before = count(seen);
    evidence.requests.beforeSend = before;
    evidence.checks.push(
      checkStatus(
        "no-generation-before-send",
        before.generation === 0 ? "PASS" : "FAIL",
        `${before.generation} generation request(s) before Send.`
      )
    );

    for (const entry of seen) {
      entry.phase = "before-send";
    }
    const sendMark = seen.length;
    await approve(page);
    const exact = (
      await page.getByTestId("exact-json").evaluate((node) => node.textContent ?? "")
    ).trim();
    const sendButton = page.getByTestId("cloud-send-button");
    const enabled = await sendButton.isEnabled();
    evidence.checks.push(
      checkStatus("send-enabled-after-approval", enabled ? "PASS" : "FAIL", enabled ? "Send is enabled." : "Send stayed disabled.")
    );
    if (!enabled) {
      writeEvidence(evidence);
      process.exitCode = 1;
      return;
    }

    await sendButton.click();
    const outcome = await Promise.race([
      page.getByTestId("cloud-draft-output").waitFor({ state: "visible", timeout: 60_000 }).then(() => "accepted"),
      page.getByTestId("cloud-draft-error").waitFor({ state: "visible", timeout: 60_000 }).then(() => "error"),
    ]).catch(() => "timeout");
    await page.waitForTimeout(500);
    const generation = seen.slice(sendMark).filter((entry) => entry.kind === "generation");
    const statuses = [];
    let modelShape = null;
    for (const entry of generation) {
      let status = null;
      let failed = null;
      try {
        const response = await entry.request.response();
        status = response ? response.status() : null;
        if (response && modelShape === null && status === 200) {
          try {
            modelShape = summariseModelResponse(await response.text());
          } catch {
            modelShape = { httpJson: false, modelJson: false, modelKeys: null };
          }
        }
      } catch {
        status = null;
      }
      try {
        const failure = entry.request.failure();
        failed = failure ? failure.errorText : null;
      } catch {
        failed = null;
      }
      statuses.push({ status, failed });
      if (failed && /aborted|canceled|cancelled/i.test(failed)) {
        evidence.requests.cancelledGenerationCount += 1;
      }
    }
    evidence.requests.duringSend = count(seen.slice(sendMark));
    evidence.requests.hosts = hostCounts(seen.slice(0, sendMark), seen.slice(sendMark));
    evidence.modelShape = modelShape;
    evidence.requests.generationStatuses = statuses;
    const firstBody = generation[0]?.body ?? "";
    evidence.body = firstBody ? inspectBody(firstBody, exact) : null;
    const inference = outcome === "accepted" ? await page.getByTestId("cloud-inference-label").innerText() : null;
    const model = outcome === "accepted" ? await page.getByTestId("cloud-model-name").innerText().catch(() => null) : null;
    const errorText = outcome === "error" ? await page.getByTestId("cloud-draft-error").innerText() : null;
    const violationItems =
      outcome === "error" ? await page.getByTestId("cloud-draft-violations").locator("li").allInnerTexts().catch(() => []) : [];
    evidence.ui = {
      outcome,
      inferenceLabel: inference,
      modelName: model,
      errorHasPrivateMarker: errorText ? RAW_MARKERS.some((marker) => errorText.includes(marker)) : false,
      errorClass: errorClass(errorText),
      violations: violationItems,
    };
    evidence.checks.push(
      checkStatus(
        "one-generation-request",
        evidence.requests.duringSend.generation === 1 ? "PASS" : "FAIL",
        `${evidence.requests.duringSend.generation} generation request(s) after Send.`
      )
    );
    if (evidence.body) {
      evidence.checks.push(
        checkStatus(
          "canonical-bytes-in-body",
          evidence.body.containsExactApprovedBytes && evidence.body.containsFixedBriefLabel ? "PASS" : "FAIL",
          "The generation body was checked in memory against the approved canonical text."
        )
      );
      evidence.checks.push(
        checkStatus(
          "no-raw-notice-markers",
          evidence.body.anyMarkerPresent || evidence.body.containsRecovered760 ? "FAIL" : "PASS",
          "Marker and recovered-amount scan of the generation body."
        )
      );
    } else {
      evidence.checks.push(checkStatus("canonical-bytes-in-body", "NOT TESTED", "No generation body was captured."));
    }
    evidence.checks.push(
      checkStatus(
        "model-result",
        outcome === "accepted" && inference?.includes("in_cloud")
          ? "PASS"
          : outcome === "timeout"
            ? "BLOCKED"
            : "FAIL",
        outcome === "accepted" ? "The screen accepted a draft labelled in_cloud." : `UI outcome: ${outcome}.`
      )
    );
    const generationRequest = generation[0]?.request;
    const attached = generationRequest ? headerPresent(generationRequest.headers(), APP_CHECK_HEADER) : false;
    evidence.tokenProbe = {
      sdkAttachedAppCheck: generationRequest ? attached : null,
      negativeProbes: "NOT TESTED",
      minimalDiagnosticBody: MINIMAL_APP_CHECK_DIAGNOSTIC_BODY,
      minimalBodyIsNotTheApprovedRequest: true,
    };
    evidence.checks.push(
      checkStatus(
        "sdk-attached-app-check",
        generationRequest ? (attached ? "PASS" : "FAIL") : "NOT TESTED",
        generationRequest
          ? attached
            ? "The generation request had an App Check header. The header value is not stored."
            : "The generation request had no App Check header."
          : "No generation request was captured."
      )
    );
    const negativeProbeDetail =
      "Negative App Check probes are not sent. The approved generation body is not replayed. A minimal non-sensitive diagnostic body would not be equivalent to the successful model request. HTTP 401 or 403 alone is not App Check enforcement; an App Check-specific rejection reason would be required, otherwise INCONCLUSIVE.";
    evidence.checks.push(checkStatus("missing-app-check-token", "NOT TESTED", negativeProbeDetail));
    evidence.checks.push(checkStatus("invalid-app-check-token", "NOT TESTED", negativeProbeDetail));
    evidence.checks.push(consoleEnforcementCheck());

    const secondEnabled = await sendButton.isEnabled();
    evidence.checks.push(
      checkStatus(
        "single-use-approval",
        secondEnabled ? "FAIL" : "PASS",
        secondEnabled ? "Send stayed enabled after the first attempt." : "Send is disabled until a new approval."
      )
    );

    const cancelMark = seen.length;
    let heldGenerations = 0;
    await page.route(/firebasevertexai\.googleapis\.com|generativelanguage\.googleapis\.com/, async (route) => {
      heldGenerations += 1;
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      try {
        await route.continue();
      } catch {
        // The page aborted the request before the delay ended.
      }
    });
    await approve(page);
    const cancelButton = page.getByTestId("cloud-send-button");
    if (await cancelButton.isEnabled()) {
      await cancelButton.evaluate((button) => {
        button.click();
        button.click();
      });
      await page.waitForTimeout(400);
      await page.getByTestId("nav-read").click();
      await page.getByTestId("notice-text").fill(`${current}\n`);
      await page.waitForTimeout(9_000);
      const cancelled = seen.slice(cancelMark).filter((entry) => entry.kind === "generation");
      const failures = [];
      for (const entry of cancelled) {
        const failure = entry.request.failure();
        failures.push(failure ? failure.errorText : "no-failure");
      }
      const aborted = failures.filter((item) => /aborted|canceled|cancelled/i.test(item)).length;
      evidence.requests.cancelledGenerationCount += aborted;
      evidence.requests.cancelAttempt = {
        started: heldGenerations,
        observed: cancelled.length,
        failures,
      };
      evidence.checks.push(
        checkStatus(
          "double-submit",
          heldGenerations === 1 ? "PASS" : "FAIL",
          `${heldGenerations} generation request(s) started from two clicks.`
        )
      );
      evidence.checks.push(
        checkStatus(
          "transport-cancellation",
          aborted > 0 ? "PASS" : "FAIL",
          aborted > 0
            ? "The browser reported the generation request aborted after the edit."
            : `No aborted generation request. Failures: ${failures.join(", ") || "none"}.`
        )
      );
    } else {
      evidence.checks.push(
        checkStatus(
          "double-submit",
          "NOT TESTED",
          "A second approval did not enable Send, so zero requests is not a pass."
        )
      );
      evidence.checks.push(
        checkStatus(
          "transport-cancellation",
          "NOT TESTED",
          "A second approval did not enable Send, so the abort observation did not start."
        )
      );
    }
    evidence.elapsedMs = Date.now() - started;
    writeEvidence(evidence);
    const failed = evidence.checks.some((item) => item.status === "FAIL");
    const blocked = evidence.checks.some((item) => item.status === "BLOCKED" || item.status === "INCONCLUSIVE");
    process.exitCode = failed ? 1 : blocked ? 2 : 0;
  } catch (error) {
    evidence.checks.push(checkStatus("script", "BLOCKED", safeErrorMessage(error)));
    evidence.elapsedMs = Date.now() - started;
    writeEvidence(evidence);
    process.exitCode = 1;
  } finally {
    await closeAll();
    await server.stop();
  }
}

function errorClass(errorText) {
  if (!errorText) {
    return null;
  }
  if (errorText.startsWith("The cloud response was rejected")) {
    return "invalid_output";
  }
  if (errorText.startsWith("Cloud drafting timed out")) {
    return "timeout";
  }
  if (errorText.startsWith("Cloud drafting was cancelled")) {
    return "cancelled";
  }
  if (errorText.startsWith("The notice changed")) {
    return "stale";
  }
  if (errorText.startsWith("Cloud drafting was not sent")) {
    return "denied";
  }
  if (errorText.startsWith("Cloud drafting was rejected")) {
    return "network_or_other";
  }
  return "unclassified";
}

function hostCounts(before, during) {
  const tally = (entries) => {
    const counts = {};
    for (const entry of entries) {
      counts[entry.host] = (counts[entry.host] ?? 0) + 1;
    }
    return counts;
  };
  return { beforeSend: tally(before), duringSend: tally(during) };
}

function count(entries) {
  return {
    generation: entries.filter((entry) => entry.kind === "generation").length,
    appCheck: entries.filter((entry) => entry.kind === "app_check").length,
    otherExternal: entries.filter((entry) => entry.kind === "other").length,
  };
}

function headerPresent(headers, name) {
  return Object.entries(headers).some(([key, value]) => key.toLowerCase() === name && String(value ?? "").length > 0);
}

function consoleEnforcementCheck() {
  return checkStatus(
    "app-check-console-enforcement",
    "BLOCKED",
    "Automated CLI inspection is BLOCKED. It does not use Firebase CLI internals and does not read an unrelated service. The service that would count is firebasevertexai.googleapis.com. Do not disable enforcement. Owner Console confirmation is separate and is not this automated read."
  );
}

function safeErrorMessage(error) {
  return (error instanceof Error ? error.message : "unknown error").replace(/https?:\/\/\S+/g, "[url]").slice(0, 500);
}

function writeEvidence(evidence) {
  const safe = JSON.parse(JSON.stringify(evidence));
  fs.mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(safe, null, 2)}\n`);
  console.log(JSON.stringify({ evidencePath: EVIDENCE_PATH, checks: safe.checks, ui: safe.ui, requests: safe.requests }, null, 2));
}

main().catch((error) => {
  const message = safeErrorMessage(error);
  writeEvidence({
    script: "scripts/verify-approved-cloud-chrome.mjs",
    checks: [checkStatus("script", "BLOCKED", message)],
  });
  process.exit(1);
});

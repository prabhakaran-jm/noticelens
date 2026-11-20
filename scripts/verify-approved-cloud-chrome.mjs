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
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ONE_SHOT = process.env.NOTICELENS_ONE_SHOT === "1";
const CHROME_EXE = process.env.NOTICELENS_CHROME_EXE || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEV_URL = process.env.NOTICELENS_DEV_URL || "http://127.0.0.1:5174";
const CDP_PORT = Number(process.env.NOTICELENS_CDP_PORT || "9336");
const FRESH_RECAPTCHA_MODE = "fresh-recaptcha";
const REGISTERED_DEBUG_MODE = "registered-debug";
const PRESERVED_EVIDENCE_PATH = path.resolve("tmp", "m5c7-one-shot-evidence.json");
const EVIDENCE_PATH = selectedEvidencePath();
const ALLOWED_ONE_SHOT_MODELS = new Set(["gemini-3.5-flash-lite", "gemini-3.8-flash"]);
let outcomeWritten = false;
const AUTHORISED_PROJECT_ID = "noticelens-2026";
const APP_CHECK_HEADER = "x-firebase-appcheck";
// A future negative probe, if one is explicitly authorised, must use a
// minimal non-sensitive body and must not send the approved generation body.
// That minimal body is not equivalent to the successful model request.
// Classify a response as App Check enforcement only when it gives an
// App Check-specific rejection reason. HTTP 401 or 403 alone is not App
// Check enforcement and stays INCONCLUSIVE. Do not send that probe
// automatically: a request to the model host could start a paid generation.
const MINIMAL_APP_CHECK_DIAGNOSTIC_BODY = "{}";

function selectedEvidencePath() {
  if (process.env.NOTICELENS_EVIDENCE_PATH) {
    return path.resolve(process.env.NOTICELENS_EVIDENCE_PATH);
  }
  const mode = process.env.NOTICELENS_APPCHECK_MODE || FRESH_RECAPTCHA_MODE;
  if (ONE_SHOT && mode === REGISTERED_DEBUG_MODE) {
    return path.resolve("tmp", "m5c7-registered-debug-evidence.json");
  }
  if (ONE_SHOT) {
    return path.resolve("tmp", "m5c7-next-one-shot-evidence.json");
  }
  return path.resolve("tmp", "m5c6-approved-cloud-evidence.json");
}

export function classifyConfigValue(name, raw) {
  if (raw === undefined || raw === null) {
    return "MISSING";
  }
  const value = String(raw).trim();
  if (value.length === 0) {
    return "EMPTY";
  }
  if (name === "VITE_FIREBASE_PROJECT_ID") {
    return value === AUTHORISED_PROJECT_ID ? "CONFIGURED" : "INVALID FORMAT";
  }
  if (name === "VITE_FIREBASE_API_KEY") {
    return /^AIza[0-9A-Za-z_-]{30,}$/.test(value) ? "CONFIGURED" : "INVALID FORMAT";
  }
  if (name === "VITE_FIREBASE_AUTH_DOMAIN") {
    return /^[a-z0-9-]+\.firebaseapp\.com$/.test(value) ? "CONFIGURED" : "INVALID FORMAT";
  }
  if (name === "VITE_FIREBASE_APP_ID") {
    return /^1:\d+:web:[0-9a-f]+$/i.test(value) ? "CONFIGURED" : "INVALID FORMAT";
  }
  if (name === "VITE_FIREBASE_APPCHECK_SITE_KEY") {
    return /^6[0-9A-Za-z_-]{20,}$/.test(value) ? "CONFIGURED" : "INVALID FORMAT";
  }
  if (name === "VITE_FIREBASE_APPCHECK_DEBUG_TOKEN") {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
      ? "CONFIGURED"
      : "INVALID FORMAT";
  }
  return "INVALID FORMAT";
}

export function resolveAppCheckLaunch(input) {
  const mode = input.mode || FRESH_RECAPTCHA_MODE;
  if (mode === FRESH_RECAPTCHA_MODE) {
    return {
      ok: true,
      mode,
      passDebugToken: false,
      reason: "fresh-recaptcha-unused",
    };
  }
  if (mode !== REGISTERED_DEBUG_MODE) {
    return { ok: false, mode, passDebugToken: false, reason: "wrong-mode" };
  }
  if (input.oneShot !== true) {
    return { ok: false, mode, passDebugToken: false, reason: "one-shot-required" };
  }
  if (input.host !== "127.0.0.1") {
    return { ok: false, mode, passDebugToken: false, reason: "loopback-required" };
  }
  if (input.viteDev !== true) {
    return { ok: false, mode, passDebugToken: false, reason: "vite-dev-required" };
  }
  if (input.tokenStatus !== "CONFIGURED") {
    return { ok: false, mode, passDebugToken: false, reason: "debug-token-required" };
  }
  return { ok: true, mode, passDebugToken: true, reason: "registered-debug" };
}

export function retryAfterHttpStatus() {
  return false;
}

export function viteDebugTokenAssignment(launch, token) {
  if (!launch || launch.passDebugToken !== true) {
    return { pass: false, assign: "" };
  }
  if (launch.host !== undefined && launch.host !== "127.0.0.1") {
    return { pass: false, assign: "" };
  }
  if (typeof token !== "string" || token.trim().length === 0) {
    return { pass: false, assign: null, reason: "refusing-empty-token" };
  }
  return { pass: true, assign: token.trim() };
}

export function violationCategories(items) {
  const categories = [];
  for (const item of items ?? []) {
    const value = String(item).toLowerCase();
    let category = "unclassified";
    if (value.includes("legal conclusion")) category = "unsupported-legal-conclusion";
    else if (value.includes("amount")) category = "unapproved-amount";
    else if (value.includes("date")) category = "unapproved-date";
    else if (value.includes("identifier") || value.includes("salutation") || value.includes("personal")) category = "personal-identifier";
    else if (value.includes("ofgem") || value.includes("guidance")) category = "guidance";
    else if (value.includes("forbidden")) category = "forbidden-key";
    else if (value.includes("unexpected")) category = "unexpected-key";
    else if (value.includes("missing")) category = "missing-field";
    else if (value.includes("greeting")) category = "greeting";
    else if (value.includes("incomplete")) category = "incomplete";
    else if (value.includes("bounded") || value.includes("placeholder")) category = "unbounded-text";
    else if (value.includes("option")) category = "option-shape";
    else if (value === "unsupported-legal-conclusion" || value === "unapproved-amount" || value === "unapproved-date" || value === "personal-identifier" || value === "guidance" || value === "forbidden-key" || value === "unexpected-key" || value === "missing-field" || value === "greeting" || value === "incomplete" || value === "unbounded-text" || value === "option-shape" || value === "unclassified") category = value;
    if (!categories.includes(category)) categories.push(category);
  }
  return categories;
}

export function buildRunRecord(input) {
  const inferenceText = String(input.inferenceLabel ?? "");
  const inferenceSource = inferenceText.includes("in_cloud")
    ? "in_cloud"
    : inferenceText.includes("unreported")
      ? "unreported"
      : input.inferenceSource ?? null;
  const modelText = String(input.modelLabel ?? "");
  const modelMatch = /Model:\s*(\S+)/.exec(modelText);
  const model = modelMatch?.[1] ?? input.model ?? null;
  return {
    httpStatus: input.httpStatus ?? null,
    inferenceSource,
    model,
    appCheckHeaderPresent: input.appCheckHeaderPresent === true,
    attempts: input.attempts ?? 0,
    allowed: input.allowed ?? 0,
    blocked: input.blocked ?? 0,
    canonicalVerified: input.canonicalVerified === true,
    accepted: input.accepted === true,
    rejected: input.rejected === true,
    violationCategories: violationCategories(input.violations),
    prepareReplyShowedDraft: input.prepareReplyShowedDraft === true,
  };
}

function unquoteEnv(value) {
  const trimmed = String(value).trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function readLocalEnvMap() {
  const envPath = path.resolve(".env.local");
  if (!fs.existsSync(envPath)) {
    return null;
  }
  const map = new Map();
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) {
      map.set(match[1], unquoteEnv(match[2]));
    }
  }
  return map;
}

function localDebugTokenStatus() {
  const map = readLocalEnvMap();
  if (!map || !map.has("VITE_FIREBASE_APPCHECK_DEBUG_TOKEN")) {
    return "MISSING";
  }
  return classifyConfigValue("VITE_FIREBASE_APPCHECK_DEBUG_TOKEN", map.get("VITE_FIREBASE_APPCHECK_DEBUG_TOKEN"));
}

function readLocalDebugToken() {
  if (localDebugTokenStatus() !== "CONFIGURED") {
    return "";
  }
  return readLocalEnvMap().get("VITE_FIREBASE_APPCHECK_DEBUG_TOKEN").trim();
}
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
  const launch = resolveAppCheckLaunch({
    oneShot: ONE_SHOT,
    mode: process.env.NOTICELENS_APPCHECK_MODE || FRESH_RECAPTCHA_MODE,
    host: new URL(DEV_URL).hostname,
    viteDev: true,
    tokenStatus: localDebugTokenStatus(),
  });
  if (!launch.ok) {
    return {
      occupied: false,
      startedByScript: false,
      blocked: true,
      passDebugToken: false,
      appCheckMode: launch.mode,
      stop: async () => {},
      note: `App Check mode was refused (${launch.reason}).`,
    };
  }
  if (await isHttpUp(DEV_URL)) {
    return {
      occupied: true,
      startedByScript: false,
      blocked: false,
      passDebugToken: false,
      appCheckMode: launch.mode,
      stop: async () => {},
      note: ONE_SHOT
        ? "The diagnostic port is already in use. One-shot mode does not reuse an existing Vite server."
        : "An existing server answered. Fresh reCAPTCHA Enterprise attestation is unverified.",
    };
  }
  const assignment = viteDebugTokenAssignment(
    { ...launch, host: new URL(DEV_URL).hostname },
    launch.passDebugToken ? readLocalDebugToken() : ""
  );
  if (launch.passDebugToken && !assignment.pass) {
    return {
      occupied: false,
      startedByScript: false,
      blocked: true,
      passDebugToken: false,
      appCheckMode: launch.mode,
      stop: async () => {},
      note: "App Check mode was refused (refusing-empty-token).",
    };
  }
  const viteBin = path.resolve("node_modules", "vite", "bin", "vite.js");
  const parsed = new URL(DEV_URL);
  const debugToken = assignment.pass ? assignment.assign : "";
  const proc = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", parsed.port, "--strictPort"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      VITE_NOTICELENS_REAL_CLOUD_DIAGNOSTIC: "1",
      VITE_FIREBASE_APPCHECK_DEBUG_TOKEN: debugToken,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await isHttpUp(DEV_URL)) {
      return {
        occupied: false,
        startedByScript: true,
        blocked: false,
        passDebugToken: launch.passDebugToken,
        appCheckMode: launch.mode,
        stop: async () => proc.kill(),
        note: launch.passDebugToken
          ? "Started Vite on 127.0.0.1 with the diagnostic flag. A local debug token was passed only in the Vite process environment."
          : "Started Vite with the diagnostic flag, an empty debug-token variable, and a fresh temporary Chrome profile. That is the reCAPTCHA Enterprise setup. It is not a completed attestation.",
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  proc.kill();
  throw new Error(`Timed out waiting for ${DEV_URL}`);
}

async function launchChrome(startUrl = DEV_URL, profilePrefix = "noticelens-m5c6-chrome-") {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), profilePrefix));
  const chrome = spawn(
    CHROME_EXE,
    [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${CDP_PORT}`,
      "--no-first-run",
      "--no-default-browser-check",
      startUrl,
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
      await new Promise((resolve) => setTimeout(resolve, 300));
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
      } catch {
        // Deleting the profile is non-fatal and must not replace the outcome.
      }
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

export function generationPreflightPasses(inspection) {
  return Boolean(
    inspection &&
      inspection.parsed &&
      inspection.containsExactApprovedBytes &&
      (inspection.exactMatch === "parsed-json" || inspection.exactMatch === "raw") &&
      inspection.containsFixedBriefLabel &&
      !inspection.anyMarkerPresent &&
      !inspection.containsRecovered760
  );
}

export function createGenerationGuardState() {
  return {
    armed: false,
    exact: "",
    reached: 0,
    blocked: [],
    preflightFailed: false,
  };
}

export function armGenerationGuard(state, exact) {
  state.exact = exact;
  state.armed = true;
}

/**
 * Decides whether one generation request may leave the browser.
 * Unarmed requests are aborted. The first armed request is allowed only
 * when its body matches the approved canonical text and the privacy checks.
 * Every later request is aborted. The caller must not treat an abort as a
 * successful single-request test.
 */
export function claimGenerationRoute(state, body) {
  if (!state.armed) {
    state.blocked.push({ reason: "before-send" });
    return { action: "abort", reason: "before-send" };
  }
  if (state.reached >= 1) {
    state.blocked.push({ reason: "extra" });
    return { action: "abort", reason: "extra" };
  }
  const inspection = inspectBody(body, state.exact);
  if (!generationPreflightPasses(inspection)) {
    state.blocked.push({ reason: "preflight" });
    state.preflightFailed = true;
    return { action: "abort", reason: "preflight" };
  }
  state.reached += 1;
  return { action: "continue", reason: "authorised", inspection };
}

export function oneShotSkippedPhase() {
  return [
    checkStatus("second-approval", "NOT TESTED", "One-shot mode does not create a second approval."),
    checkStatus("double-submit", "NOT TESTED", "One-shot mode does not execute a second Send."),
    checkStatus("transport-cancellation", "NOT TESTED", "One-shot mode does not run the cancellation phase."),
    checkStatus(
      "negative-app-check-probe",
      "NOT TESTED",
      "Negative App Check probes are not sent. HTTP 401 or 403 alone is not App Check enforcement."
    ),
  ];
}

function normaliseNewlines(value) {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function readLocalEnv() {
  const values = new Map();
  let text = "";
  try {
    text = fs.readFileSync(".env.local", "utf8");
  } catch {
    return values;
  }
  for (const line of text.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    values.set(trimmed.slice(0, index).trim(), unquoteEnv(trimmed.slice(index + 1)));
  }
  return values;
}

function oneShotEnvironment() {
  const env = readLocalEnv();
  const configuredModel = env.get("VITE_FIREBASE_CLOUD_MODEL") || "";
  const model = configuredModel || "gemini-3.5-flash-lite";
  return {
    envFilePresent: env.size > 0,
    projectAuthorised: env.get("VITE_FIREBASE_PROJECT_ID") === AUTHORISED_PROJECT_ID,
    appCheckSiteKeyConfigured: Boolean(env.get("VITE_FIREBASE_APPCHECK_SITE_KEY")),
    coreFirebaseConfigured: ["VITE_FIREBASE_API_KEY", "VITE_FIREBASE_AUTH_DOMAIN", "VITE_FIREBASE_PROJECT_ID", "VITE_FIREBASE_APP_ID"].every(
      (key) => Boolean(env.get(key))
    ),
    model,
    modelAllowed: ALLOWED_ONE_SHOT_MODELS.has(model),
    debugTokenDisabled: true,
  };
}

function canonicalScreenPreflight(exact, noticeText, originalText) {
  let parsed = null;
  try {
    parsed = JSON.parse(exact);
  } catch {
    parsed = null;
  }
  const flags = parsed && Array.isArray(parsed.circumstanceFlags) ? parsed.circumstanceFlags : [];
  const amounts = parsed && Array.isArray(parsed.amountsGBP) ? parsed.amountsGBP : [];
  const result = {
    json: Boolean(parsed),
    schemaV2: Boolean(parsed && parsed.schemaVersion === "noticelens.cloud-brief.v2"),
    goal: Boolean(parsed && parsed.responseGoal === "request_billing_review"),
    flagsEmpty: Boolean(parsed && flags.length === 0),
    amount1280: amounts.includes(1280),
    amount760: amounts.includes(760),
    originalNotice: noticeText === originalText,
    category: Boolean(parsed && parsed.noticeCategory === "utility_electricity"),
  };
  result.ok = result.json && result.schemaV2 && result.goal && result.flagsEmpty && result.amount1280 && !result.amount760 && result.originalNotice && result.category;
  return result;
}

async function installGenerationGuard(context, state) {
  await context.route("**/*", async (route) => {
    if (classify(route.request().url()) !== "generation") {
      await route.continue();
      return;
    }
    const decision = claimGenerationRoute(state, route.request().postData() ?? "");
    if (decision.action === "abort") {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
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

const ALLOWED_GENERIC_SALUTATIONS = new Set([
  "dear sir or madam,",
  "dear sir/madam,",
  "dear customer services,",
  "dear [recipient_name],",
  "dear [recipient_name]",
  "dear,",
  "dear",
]);

function normaliseSalutationLine(rawLine) {
  return rawLine.replace(/\s+/g, " ").trim().toLowerCase().replace(/\s+,/g, ",");
}

export function textWithoutAcceptedSalutation(value) {
  return String(value)
    .split("\n")
    .filter((line) => !ALLOWED_GENERIC_SALUTATIONS.has(normaliseSalutationLine(line)))
    .join("\n");
}

export function diagnosticIdentifierNames(value) {
  const stripped = textWithoutAcceptedSalutation(value).replace(/\[[A-Z0-9_]+\]/g, " ");
  return IDENTIFIER_PATTERNS.filter(([, pattern]) => pattern.test(stripped)).map(([name]) => name);
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
      const stripped = textWithoutAcceptedSalutation(value).replace(/\[[A-Z0-9_]+\]/g, " ");
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

async function waitForStableExact(page) {
  let previous = "";
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    let current = "";
    try {
      current = (await page.getByTestId("exact-json").evaluate((node) => node.textContent ?? "")).trim();
    } catch {
      current = "";
    }
    if (current.startsWith("{") && current === previous) {
      return current;
    }
    previous = current;
    await page.waitForTimeout(500);
  }
  return "";
}

function waitForPreflightAbort(guard) {
  let timer;
  const finished = new Promise((resolve) => {
    timer = setInterval(() => {
      if (guard.preflightFailed) {
        clearInterval(timer);
        resolve("preflight-aborted");
      }
    }, 200);
  });
  finished.stop = () => {
    clearInterval(timer);
  };
  return finished;
}

function oneShotAutomatedConsoleCheck() {
  return checkStatus(
    "app-check-console-enforcement",
    "NOT TESTED",
    "This one-shot run does not call the Console API. The earlier automated read was HTTP 401 and remains BLOCKED. Do not disable enforcement."
  );
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

  const environment = ONE_SHOT ? oneShotEnvironment() : null;
  if (ONE_SHOT) {
    evidence.oneShot = true;
    evidence.environment = {
      projectAuthorised: environment.projectAuthorised,
      appCheckSiteKeyConfigured: environment.appCheckSiteKeyConfigured,
      coreFirebaseConfigured: environment.coreFirebaseConfigured,
      model: environment.modelAllowed ? environment.model : null,
      debugTokenDisabled: true,
      diagnosticFlag: true,
      host: "127.0.0.1",
    };
    const environmentReady =
      environment.envFilePresent &&
      environment.projectAuthorised &&
      environment.appCheckSiteKeyConfigured &&
      environment.coreFirebaseConfigured &&
      environment.modelAllowed;
    evidence.checks.push(
      checkStatus(
        "one-shot-environment",
        environmentReady ? "PASS" : "BLOCKED",
        environmentReady
          ? "The authorised project, App Check site key, and supported model are configured. Values are not stored."
          : "The one-shot environment is incomplete. Credential values are not stored."
      )
    );
    if (!environmentReady) {
      writeEvidence(evidence);
      process.exitCode = 2;
      return;
    }
    if (await isHttpUp(`http://127.0.0.1:${CDP_PORT}/json/version`)) {
      evidence.checks.push(checkStatus("chrome-debug-port", "BLOCKED", "The Chrome debug port is already in use. One-shot mode does not attach to it."));
      writeEvidence(evidence);
      process.exitCode = 2;
      return;
    }
  }

  const server = await ensureVite();
  evidence.vite = { startedByScript: server.startedByScript, note: server.note };
  if (ONE_SHOT && evidence.environment) {
    evidence.environment.debugTokenDisabled = !server.passDebugToken;
    evidence.environment.appCheckMode = server.appCheckMode;
  }
  if (server.blocked) {
    evidence.checks.push(checkStatus("app-check-mode", "FAIL", server.note));
    writeEvidence(evidence);
    process.exitCode = 1;
    return;
  }
  if (ONE_SHOT && server.occupied) {
    evidence.checks.push(checkStatus("diagnostic-server", "BLOCKED", server.note));
    writeEvidence(evidence);
    process.exitCode = 2;
    return;
  }
  if (!ONE_SHOT) {
    evidence.checks.push(
      checkStatus(
        "fresh-recaptcha-enterprise",
        "NOT TESTED",
        server.startedByScript
          ? "This script started the diagnostic server. Fresh reCAPTCHA Enterprise attestation is still unverified until an App Check header from that process is recorded."
          : "An existing Vite server was reused. Fresh reCAPTCHA Enterprise attestation is unverified."
      )
    );
  }
  const guard = createGenerationGuardState();
  const { browser, closeAll } = await launchChrome(
    ONE_SHOT ? "about:blank" : DEV_URL,
    ONE_SHOT ? "noticelens-m5c7-chrome-" : "noticelens-m5c6-chrome-"
  );
  const seen = [];
  try {
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error("Chrome did not expose a browser context.");
    }
    const version = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((response) => response.json());
    evidence.chromeVersion = typeof version.Browser === "string" ? version.Browser : null;
    const page = context.pages()[0] ?? (await context.newPage());
    if (ONE_SHOT) {
      await installGenerationGuard(context, guard);
    }
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
    if (!ONE_SHOT) {
      await notice.fill(`${current}\n`);
      await page.waitForTimeout(400);
      await notice.fill(current);
      await page.waitForTimeout(400);
    }
    await page.getByTestId("nav-reply").click();
    if (ONE_SHOT) {
      const originalText = normaliseNewlines(fs.readFileSync("examples/energy-backbill-original.txt", "utf8"));
      const noticeText = normaliseNewlines(current);
      const exact = await waitForStableExact(page);
      const screenPreflight = canonicalScreenPreflight(exact, noticeText, originalText);
      evidence.screenPreflight = screenPreflight;
      evidence.checks.push(
        checkStatus(
          "original-fixture-preflight",
          screenPreflight.ok ? "PASS" : "FAIL",
          screenPreflight.ok
            ? "The screen has the original fixture, request_billing_review, empty flags, and canonical v2."
            : "The on-screen payload did not match the authorised original fixture. Send was not clicked."
        )
      );
      if (!screenPreflight.ok) {
        writeEvidence(evidence);
        process.exitCode = 1;
        return;
      }
      evidence.approvedExactLength = exact.length;
      guard.pendingExact = exact;
    }

    const before = count(seen);
    evidence.requests.beforeSend = before;
    const attemptedBeforeSend = before.generation + (ONE_SHOT ? guard.blocked.length + guard.reached : 0);
    evidence.checks.push(
      checkStatus(
        "no-generation-before-send",
        attemptedBeforeSend === 0 ? "PASS" : "FAIL",
        attemptedBeforeSend === 0
          ? "No generation request was attempted before Send."
          : `${attemptedBeforeSend} generation request(s) were attempted before Send.`
      )
    );
    if (ONE_SHOT && attemptedBeforeSend !== 0) {
      writeEvidence(evidence);
      process.exitCode = 1;
      return;
    }

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
    if (ONE_SHOT && exact !== guard.pendingExact) {
      evidence.checks.push(
        checkStatus("approved-bytes-stable", "FAIL", "The approved payload changed before Send. Send was not clicked.")
      );
      writeEvidence(evidence);
      process.exitCode = 1;
      return;
    }
    if (ONE_SHOT) {
      const productionSource = fs.readFileSync("src/adapters/cloudApprovalSession.ts", "utf8");
      const productionOff = productionSource.includes("CLOUD_SUBMISSION_ENABLED = false as const");
      const banner = await page.getByTestId("cloud-disabled").innerText();
      const bannerOff = banner.includes("Production cloud sending stays off");
      evidence.checks.push(
        checkStatus(
          "production-send-disabled",
          productionOff && bannerOff ? "PASS" : "FAIL",
          productionOff && bannerOff
            ? "CLOUD_SUBMISSION_ENABLED remains false and the screen says production sending stays off."
            : "Production Send did not stay disabled. The authorised request was not sent."
        )
      );
      if (!productionOff || !bannerOff) {
        writeEvidence(evidence);
        process.exitCode = 1;
        return;
      }
      armGenerationGuard(guard, exact);
    }

    await sendButton.click();
    const preflightWait = ONE_SHOT ? waitForPreflightAbort(guard) : null;
    const outcome = await Promise.race([
      page.getByTestId("cloud-draft-output").waitFor({ state: "visible", timeout: 60_000 }).then(() => "accepted"),
      page.getByTestId("cloud-draft-error").waitFor({ state: "visible", timeout: 60_000 }).then(() => "error"),
      ...(preflightWait ? [preflightWait] : []),
    ]).catch(() => "timeout");
    preflightWait?.stop();
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
      statuses.push({ status, failed: failed ? "request-failed" : null });
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
    const extrasBlocked = ONE_SHOT ? guard.blocked.filter((item) => item.reason === "extra").length : 0;
    const reachedFirebase = ONE_SHOT ? guard.reached : evidence.requests.duringSend.generation;
    if (ONE_SHOT) {
      evidence.requests.reachedFirebase = reachedFirebase;
      evidence.requests.blocked = {
        beforeSend: guard.blocked.filter((item) => item.reason === "before-send").length,
        preflight: guard.blocked.filter((item) => item.reason === "preflight").length,
        extra: extrasBlocked,
      };
      evidence.requests.attemptedAfterSend = evidence.requests.duringSend.generation;
    }
    evidence.checks.push(
      checkStatus(
        "firebase-generation-limit",
        reachedFirebase <= 1 ? "PASS" : "FAIL",
        `${reachedFirebase} generation request(s) reached Firebase.`
      )
    );
    evidence.checks.push(
      checkStatus(
        "one-generation-request",
        ONE_SHOT
          ? reachedFirebase === 1 && extrasBlocked === 0 && !guard.preflightFailed
            ? "PASS"
            : "FAIL"
          : evidence.requests.duringSend.generation === 1
            ? "PASS"
            : "FAIL",
        ONE_SHOT && extrasBlocked > 0
          ? "A later generation attempt was aborted. That is not a successful single-request test."
          : ONE_SHOT && guard.preflightFailed
            ? "The request body failed the canonical privacy preflight and was aborted before Firebase."
            : `${reachedFirebase} generation request(s) reached Firebase.`
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
    evidence.checks.push(ONE_SHOT ? oneShotAutomatedConsoleCheck() : consoleEnforcementCheck());
    if (ONE_SHOT) {
      evidence.checks.push(
        checkStatus(
          "owner-console-enforcement",
          "PASS",
          "Owner confirmation for noticelens-2026: Firebase AI Logic Basic Enforced, Replay Off. This run did not change those settings."
        )
      );
      const hostNames = [
        ...Object.keys(evidence.requests.hosts?.beforeSend ?? {}),
        ...Object.keys(evidence.requests.hosts?.duringSend ?? {}),
      ];
      const recaptchaSeen = hostNames.some(
        (host) => host === "recaptchaenterprise.googleapis.com" || host.endsWith(".recaptchaenterprise.googleapis.com")
      );
      const freshRecaptcha = !server.passDebugToken && server.startedByScript && recaptchaSeen;
      evidence.checks.push(
        checkStatus(
          "fresh-recaptcha-enterprise",
          freshRecaptcha ? "PASS" : "NOT TESTED",
          server.passDebugToken
            ? "Registered-debug mode leaves the fresh reCAPTCHA option unused."
            : freshRecaptcha
              ? "This script started Vite without a debug token, used a fresh temporary profile, and saw a reCAPTCHA Enterprise host."
              : "Fresh reCAPTCHA Enterprise attestation is not established."
        )
      );
      evidence.checks.push(...oneShotSkippedPhase());
      evidence.noRetry = true;
      evidence.noSecondApproval = true;
      evidence.noSecondGeneration = extrasBlocked === 0 && reachedFirebase <= 1;
      evidence.noArbitraryNotice = evidence.screenPreflight?.originalNotice === true;
      evidence.draftShown = outcome === "accepted";
      evidence.httpStatus = statuses.find((item) => item.status !== null)?.status ?? null;
      evidence.record = buildRunRecord({
        httpStatus: evidence.httpStatus,
        inferenceLabel: inference,
        modelLabel: model,
        appCheckHeaderPresent: attached,
        attempts:
          reachedFirebase +
          extrasBlocked +
          (evidence.requests.blocked?.beforeSend ?? 0) +
          (evidence.requests.blocked?.preflight ?? 0),
        allowed: reachedFirebase,
        blocked:
          extrasBlocked +
          (evidence.requests.blocked?.beforeSend ?? 0) +
          (evidence.requests.blocked?.preflight ?? 0),
        canonicalVerified: Boolean(
          evidence.body &&
            evidence.body.containsExactApprovedBytes &&
            evidence.body.containsFixedBriefLabel &&
            !evidence.body.anyMarkerPresent &&
            !evidence.body.containsRecovered760
        ),
        accepted: outcome === "accepted",
        rejected: outcome !== "accepted",
        violations: violationItems,
        prepareReplyShowedDraft: outcome === "accepted",
      });
      evidence.ui.inferenceSource = evidence.record.inferenceSource;
      evidence.ui.violations = evidence.record.violationCategories;
      evidence.checks.push(
        checkStatus(
          "no-http-retry",
          retryAfterHttpStatus(evidence.httpStatus) ? "FAIL" : "PASS",
          "An HTTP status, including 401, is not retried and does not start a second generation."
        )
      );
      for (const entry of seen) {
        entry.body = "";
      }
    }

    if (!ONE_SHOT) {
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
    try {
      await closeAll();
    } catch {
      // Profile cleanup must not replace the evidence already written.
    }
    try {
      await server.stop();
    } catch {
      // Stopping Vite must not replace the evidence already written.
    }
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

const HIDDEN_EVIDENCE_KEYS = new Set([
  "exact",
  "pendingExact",
  "postData",
  "headers",
  "authorization",
  "token",
  "debugToken",
  "apiKey",
  "siteKey",
  "credential",
  "secret",
  "noticeText",
  "rawBody",
]);

export function sanitiseEvidence(evidence) {
  return JSON.parse(
    JSON.stringify(evidence, (key, value) => {
      if (HIDDEN_EVIDENCE_KEYS.has(key)) {
        return undefined;
      }
      if (typeof value === "string") {
        return value
          .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
          .replace(/Bearer\s+\S+/g, "Bearer [redacted]");
      }
      return value;
    })
  );
}

export function writeSanitisedEvidence(evidence, target = EVIDENCE_PATH, preserved = PRESERVED_EVIDENCE_PATH) {
  const resolved = path.resolve(target);
  if (resolved === path.resolve(preserved)) {
    throw new Error("Refusing to overwrite the preserved one-shot evidence file.");
  }
  const safe = sanitiseEvidence(evidence);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(safe, null, 2)}\n`);
  outcomeWritten = true;
  return safe;
}

export async function persistThenCleanup(evidence, target, cleanup, preserved = PRESERVED_EVIDENCE_PATH) {
  const safe = writeSanitisedEvidence(evidence, target, preserved);
  try {
    await cleanup();
  } catch {
    // Cleanup is non-fatal and must not replace the outcome already written.
  }
  return safe;
}

function writeEvidence(evidence) {
  const safe = writeSanitisedEvidence(evidence);
  console.log(JSON.stringify({ evidencePath: EVIDENCE_PATH, checks: safe.checks, ui: safe.ui, requests: safe.requests, httpStatus: safe.httpStatus ?? null }, null, 2));
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
main().catch((error) => {
  if (outcomeWritten) {
    process.exit(process.exitCode || 1);
    return;
  }
  const message = safeErrorMessage(error);
  try {
    writeEvidence({
      script: "scripts/verify-approved-cloud-chrome.mjs",
      checks: [checkStatus("script", "BLOCKED", message)],
    });
  } catch {
    // A refused evidence path must not replace a preserved outcome.
  }
  process.exit(1);
});
}

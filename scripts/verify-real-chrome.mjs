import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const CHROME_EXE = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEFAULT_C_MODEL_DIR = path.join(
  process.env.LOCALAPPDATA || "C:\\Users\\User\\AppData\\Local",
  "Google",
  "Chrome",
  "User Data",
  "OptGuideOnDeviceModel"
);
const D_PROFILE_DIR =
  process.env.NOTICELENS_CHROME_PROFILE_DIR || "D:\\chrome-noticelens-dev";
const CDP_PORT = Number(process.env.NOTICELENS_CDP_PORT || "9335");
const DEV_URL = process.env.NOTICELENS_DEV_URL || "http://127.0.0.1:5173";

async function isHttpUp(url) {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureViteDevServer() {
  if (await isHttpUp(DEV_URL)) {
    return { startedByScript: false, stop: async () => {} };
  }

  const viteBin = path.resolve("node_modules", "vite", "bin", "vite.js");
  const proc = spawn(
    process.execPath,
    [viteBin, "--host", "127.0.0.1", "--port", "5173", "--strictPort"],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (await isHttpUp(DEV_URL)) {
      return {
        startedByScript: true,
        stop: async () => {
          proc.kill();
        },
      };
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  proc.kill();
  throw new Error(`Timed out waiting for Vite dev server at ${DEV_URL}`);
}

function inspectCachedModelDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return { exists: false, versions: [] };
  }
  const entries = fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const versionPath = path.join(dirPath, d.name);
      const files = fs.readdirSync(versionPath);
      const totalBytes = files.reduce((acc, f) => {
        const st = fs.statSync(path.join(versionPath, f));
        return acc + (st.isFile() ? st.size : 0);
      }, 0);
      return {
        version: d.name,
        files,
        sizeMB: Math.round((totalBytes / (1024 * 1024)) * 100) / 100,
      };
    });
  return { exists: true, versions: entries };
}

async function launchNativeChromeOverCdp(profileDir, cdpPort) {
  fs.mkdirSync(profileDir, { recursive: true });
  const localStatePath = path.join(profileDir, "Local State");
  let localState = {};
  if (fs.existsSync(localStatePath)) {
    try {
      localState = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
    } catch {
      localState = {};
    }
  }
  localState.browser = localState.browser || {};
  if (!Array.isArray(localState.browser.enabled_labs_experiments)) {
    localState.browser.enabled_labs_experiments = [
      "prompt-api@1",
      "prompt-api-multimodal-input@1",
    ];
    fs.writeFileSync(localStatePath, JSON.stringify(localState, null, 2));
  }

  // Spawn native chrome.exe directly so Playwright's default automation flags do not suppress OptimizationGuide
  const chromeProc = spawn(
    CHROME_EXE,
    [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${cdpPort}`,
      "--no-first-run",
      "--no-default-browser-check",
      DEV_URL,
    ],
    { stdio: "ignore" }
  );

  const cdpUrl = `http://127.0.0.1:${cdpPort}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await isHttpUp(`${cdpUrl}/json/version`)) {
      break;
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  const browser = await chromium.connectOverCDP(cdpUrl);
  return {
    browser,
    closeAll: async () => {
      try {
        await browser.close();
      } catch {
        // ignore
      }
      try {
        chromeProc.kill();
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, 1000));
    },
  };
}

async function main() {
  const cDriveModelCache = inspectCachedModelDir(DEFAULT_C_MODEL_DIR);
  const dDriveModelCache = inspectCachedModelDir(
    path.join(D_PROFILE_DIR, "OptGuideOnDeviceModel")
  );

  const server = await ensureViteDevServer();
  const { browser, closeAll } = await launchNativeChromeOverCdp(
    D_PROFILE_DIR,
    CDP_PORT
  );

  try {
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error("No default Chrome browser context found over CDP");
    }

    // Allow Chrome's On-Device Model Broker performance class check to settle
    await new Promise((r) => setTimeout(r, 3500));

    const page =
      context.pages().find((p) => p.url().startsWith(DEV_URL)) ??
      (await context.newPage());
    const outboundRequests = [];
    page.on("request", (req) => {
      const url = req.url();
      if (!url.startsWith("http://127.0.0.1") && !url.startsWith("data:")) {
        outboundRequests.push({ method: req.method(), url });
      }
    });

    await page.goto(DEV_URL, { waitUntil: "networkidle" });
    await page.getByTestId("btn-refresh-capability").click();
    await page.waitForTimeout(400);

    const chromeProbe = await page.evaluate(async () => {
      const hasGlobal = "LanguageModel" in self;
      if (!hasGlobal) {
        return {
          hasGlobal: false,
          availabilityTextEn: "api_missing",
          availabilityNoArgs: "api_missing",
          userAgent: navigator.userAgent,
        };
      }
      let availabilityTextEn = null;
      let availabilityNoArgs = null;
      let error = null;
      try {
        // @ts-expect-error Chrome built-in AI global
        availabilityNoArgs = await self.LanguageModel.availability();
        // @ts-expect-error Chrome built-in AI global
        availabilityTextEn = await self.LanguageModel.availability({
          expectedInputs: [{ type: "text", languages: ["en"] }],
          expectedOutputs: [{ type: "text", languages: ["en"] }],
        });
      } catch (e) {
        error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      }
      return {
        hasGlobal,
        availabilityNoArgs,
        availabilityTextEn,
        error,
        userAgent: navigator.userAgent,
      };
    });

    const uiFirebaseCoreStatus = await page
      .getByTestId("firebase-core-status")
      .innerText();
    const uiFirebaseAppCheckStatus = await page
      .getByTestId("firebase-appcheck-status")
      .innerText();

    // 1. Click Real ONLY_ON_DEVICE Inference button
    await page.getByTestId("btn-run-on-device").click();
    const onDeviceOutcome = await Promise.race([
      page
        .getByTestId("on-device-result")
        .waitFor({ state: "visible", timeout: 180_000 })
        .then(async () => ({
          status: "succeeded",
          inferenceSource: await page
            .getByTestId("inference-badge-on-device")
            .getAttribute("data-raw-inference-source"),
          badgeStatus: await page
            .getByTestId("inference-badge-on-device")
            .getAttribute("data-inference-status"),
          latency: await page.getByTestId("on-device-latency").innerText(),
          networkState: await page
            .getByTestId("on-device-network-state")
            .innerText(),
          fullText: await page.getByTestId("on-device-result").innerText(),
        })),
      page
        .getByTestId("on-device-error")
        .waitFor({ state: "visible", timeout: 180_000 })
        .then(async () => ({
          status: "blocked_or_failed",
          error: await page.getByTestId("on-device-error").innerText(),
        })),
    ]);

    // 2. Offline repeat ONLY if online ONLY_ON_DEVICE succeeded
    let offlineRepeatOutcome = {
      status: "skipped_due_to_primary_on_device_blocker",
    };
    if (onDeviceOutcome.status === "succeeded") {
      await context.setOffline(true);
      await page.getByTestId("btn-refresh-capability").click();
      await page.getByTestId("btn-run-on-device").click();
      offlineRepeatOutcome = await Promise.race([
        page
          .getByTestId("on-device-result")
          .waitFor({ state: "visible", timeout: 120_000 })
          .then(async () => ({
            status: "succeeded",
            inferenceSource: await page
              .getByTestId("inference-badge-on-device")
              .getAttribute("data-raw-inference-source"),
            latency: await page.getByTestId("on-device-latency").innerText(),
            networkState: await page
              .getByTestId("on-device-network-state")
              .innerText(),
          })),
        page
          .getByTestId("on-device-error")
          .waitFor({ state: "visible", timeout: 120_000 })
          .then(async () => ({
            status: "blocked_or_failed",
            error: await page.getByTestId("on-device-error").innerText(),
          })),
      ]);
      await context.setOffline(false);
    }

    // 3. Click Real ONLY_IN_CLOUD Inference button
    await page.getByTestId("btn-run-in-cloud").click();
    const inCloudOutcome = await Promise.race([
      page
        .getByTestId("cloud-result")
        .waitFor({ state: "visible", timeout: 60_000 })
        .then(async () => ({
          status: "succeeded",
          inferenceSource: await page
            .getByTestId("inference-badge-in-cloud")
            .getAttribute("data-raw-inference-source"),
          badgeStatus: await page
            .getByTestId("inference-badge-in-cloud")
            .getAttribute("data-inference-status"),
          latency: await page.getByTestId("cloud-latency").innerText(),
        })),
      page
        .getByTestId("cloud-error")
        .waitFor({ state: "visible", timeout: 60_000 })
        .then(async () => ({
          status: "blocked_or_failed",
          error: await page.getByTestId("cloud-error").innerText(),
        })),
    ]);

    // 4. Run 5-Fixture Benchmark ONLY if ONLY_ON_DEVICE succeeded
    let benchmarkOutcome = {
      status: "skipped_due_to_primary_on_device_blocker",
    };
    if (onDeviceOutcome.status === "succeeded") {
      await page.getByTestId("btn-run-benchmark").click();
      benchmarkOutcome = await Promise.race([
        page
          .getByTestId("benchmark-summary")
          .waitFor({ state: "visible", timeout: 300_000 })
          .then(async () => ({
            status: "succeeded",
            summaryText: await page
              .getByTestId("benchmark-summary")
              .innerText(),
          })),
        page
          .getByTestId("benchmark-error")
          .waitFor({ state: "visible", timeout: 300_000 })
          .then(async () => ({
            status: "blocked_or_failed",
            error: await page.getByTestId("benchmark-error").innerText(),
          })),
      ]);
    }

    console.log(
      JSON.stringify(
        {
          timestampIso: new Date().toISOString(),
          chromeExecutable: CHROME_EXE,
          dProfileDir: D_PROFILE_DIR,
          cDriveModelCache,
          dDriveModelCache,
          chromeProbe,
          uiReadiness: {
            uiFirebaseCoreStatus,
            uiFirebaseAppCheckStatus,
          },
          onDeviceOutcome,
          offlineRepeatOutcome,
          inCloudOutcome,
          benchmarkOutcome,
          outboundExternalRequestsCount: outboundRequests.length,
          outboundExternalRequests: outboundRequests,
        },
        null,
        2
      )
    );
  } finally {
    await closeAll();
    await server.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

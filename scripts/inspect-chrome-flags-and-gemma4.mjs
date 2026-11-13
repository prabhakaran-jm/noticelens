import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const CHROME_EXE = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEV_PROFILE = "D:\\chrome-noticelens-dev";
const GEMMA4_PROFILE = "D:\\chrome-noticelens-gemma4";
const DEV_URL = "http://127.0.0.1:5173";

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
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }
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
  throw new Error("Timed out starting Vite server");
}

async function launchNativeChromeOverCdp({
  profileDir,
  cdpPort,
  labsExperiments,
}) {
  fs.mkdirSync(profileDir, { recursive: true });

  if (labsExperiments && Array.isArray(labsExperiments)) {
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
    localState.browser.enabled_labs_experiments = labsExperiments;
    fs.writeFileSync(localStatePath, JSON.stringify(localState, null, 2));
  }

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
      await new Promise((r) => setTimeout(r, 1200));
    },
  };
}

async function probeNativeProfile({
  label,
  profileDir,
  cdpPort,
  labsExperiments,
}) {
  const { browser, closeAll } = await launchNativeChromeOverCdp({
    profileDir,
    cdpPort,
    labsExperiments,
  });

  try {
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error("No default browser context found over CDP");
    }

    // 1. Inspect chrome://flags for exact selected values
    const flagsPage = await context.newPage();
    await flagsPage.goto("chrome://flags/", { waitUntil: "domcontentloaded" });
    await flagsPage.waitForTimeout(1200);
    const activeAiFlags = await flagsPage.evaluate(() => {
      const targetIds = new Set([
        "prompt-api",
        "prompt-api-multimodal-input",
        "gemma4-for-built-in-ai",
        "decisions-api",
        "on-device-model-speculative-decoding",
        "optimization-guide-debug-logs",
        "ignore-gpu-blocklist",
      ]);
      const found = [];
      const walk = (root) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let node = walker.nextNode();
        while (node) {
          if (node.tagName === "FLAGS-EXPERIMENT") {
            const id = node.getAttribute("id") || "";
            if (targetIds.has(id)) {
              const sel = node.shadowRoot?.querySelector("select");
              found.push({
                id,
                selectedValue: sel ? sel.value : null,
                options: sel
                  ? Array.from(sel.options).map((o) => o.value)
                  : [],
              });
            }
          }
          if (node.shadowRoot) walk(node.shadowRoot);
          node = walker.nextNode();
        }
      };
      walk(document.body);
      return found;
    });
    await flagsPage.close();

    // 2. Enable internal debug pages and inspect chrome://on-device-internals Broker State
    const diagPage = await context.newPage();
    await diagPage.goto("chrome://chrome-urls/", {
      waitUntil: "domcontentloaded",
    });
    await diagPage.waitForTimeout(400);
    await diagPage.evaluate(() => {
      const clickEnable = (root) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let node = walker.nextNode();
        while (node) {
          if (
            (node.tagName === "BUTTON" || node.tagName === "CR-BUTTON") &&
            (node.textContent || "")
              .toLowerCase()
              .includes("enable internal debugging pages")
          ) {
            node.click();
            return true;
          }
          if (node.shadowRoot && clickEnable(node.shadowRoot)) return true;
          node = walker.nextNode();
        }
        return false;
      };
      return clickEnable(document.body);
    });
    await diagPage.waitForTimeout(400);
    await diagPage.goto("chrome://on-device-internals/", {
      waitUntil: "domcontentloaded",
    });

    let brokerStateDump = "";
    const deadline = Date.now() + 18_000;
    while (Date.now() < deadline) {
      await diagPage.evaluate(() => {
        const clickBroker = (root) => {
          const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_ELEMENT
          );
          let node = walker.nextNode();
          while (node) {
            if ((node.textContent || "").trim() === "Broker State") {
              node.click();
            }
            if (node.shadowRoot) clickBroker(node.shadowRoot);
            node = walker.nextNode();
          }
        };
        clickBroker(document.body);
      });
      await diagPage.waitForTimeout(1500);
      brokerStateDump = await diagPage.evaluate(() => {
        const collect = (root) => {
          const out = [];
          const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT
          );
          let node = walker.nextNode();
          while (node) {
            if (node.nodeType === Node.TEXT_NODE) {
              const t = node.textContent?.trim();
              if (t) out.push(t);
            } else if (node.shadowRoot) {
              out.push(collect(node.shadowRoot));
            }
            node = walker.nextNode();
          }
          return out.join(" ").replace(/\s+/g, " ").trim();
        };
        return collect(document.body);
      });
      if (!brokerStateDump.includes("Device performance class: Loading...")) {
        break;
      }
    }
    await diagPage.close();

    // 3. Test NoticeLens app page in this native Chrome instance
    const appPage =
      context.pages().find((p) => p.url().startsWith(DEV_URL)) ??
      (await context.newPage());
    await appPage.goto(DEV_URL, { waitUntil: "networkidle" });
    await appPage.getByTestId("btn-refresh-capability").click();
    await appPage.waitForTimeout(500);

    const availabilityEval = await appPage.evaluate(async () => {
      if (!("LanguageModel" in self)) {
        return {
          hasGlobal: false,
          noArgs: "api_missing",
          enText: "api_missing",
        };
      }
      try {
        // @ts-expect-error Chrome Prompt API global
        const noArgs = await self.LanguageModel.availability();
        // @ts-expect-error Chrome Prompt API global
        const enText = await self.LanguageModel.availability({
          expectedInputs: [{ type: "text", languages: ["en"] }],
          expectedOutputs: [{ type: "text", languages: ["en"] }],
        });
        return { hasGlobal: true, noArgs, enText, error: null };
      } catch (err) {
        return {
          hasGlobal: true,
          noArgs: "error",
          enText: "error",
          error:
            err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        };
      }
    });

    await appPage.getByTestId("btn-run-on-device").click();
    let lastObservedDownloadPct = null;
    const downloadTimeoutMs = Number(
      process.env.NOTICELENS_GEMMA4_TIMEOUT_MS || "90000"
    );
    const hb = setInterval(async () => {
      try {
        const mainText = await appPage.locator("main").innerText();
        const dl = mainText.match(
          /Device model download\/load progress:\s*([\d.]+)%/
        );
        if (dl) {
          lastObservedDownloadPct = Number(dl[1]);
        }
        console.error(
          `[verify-gemma4 heartbeat] ${label}: ${dl ? `download=${dl[1]}%` : "inferring/initializing"}`
        );
      } catch {
        // ignore
      }
    }, 10_000);

    let firebaseOnDeviceResult;
    try {
      firebaseOnDeviceResult = await Promise.race([
        appPage
          .getByTestId("on-device-result")
          .waitFor({ state: "visible", timeout: downloadTimeoutMs })
          .then(async () => ({
            status: "succeeded",
            inferenceSource: await appPage
              .getByTestId("inference-badge-on-device")
              .getAttribute("data-raw-inference-source"),
            latency: await appPage.getByTestId("on-device-latency").innerText(),
            text: await appPage.getByTestId("on-device-result").innerText(),
          })),
        appPage
          .getByTestId("on-device-error")
          .waitFor({ state: "visible", timeout: downloadTimeoutMs })
          .then(async () => ({
            status: "blocked_or_failed",
            error: await appPage.getByTestId("on-device-error").innerText(),
          })),
      ]);
    } catch (waitErr) {
      firebaseOnDeviceResult = {
        status: "cold_download_timeout",
        timeoutMs: downloadTimeoutMs,
        lastObservedDownloadPct,
        detail:
          waitErr instanceof Error ? waitErr.message.split("\n")[0] : String(waitErr),
      };
    } finally {
      clearInterval(hb);
    }

    return {
      label,
      profileDir,
      labsExperiments,
      activeAiFlags,
      availabilityEval,
      brokerStateDump: brokerStateDump.slice(0, 3500),
      firebaseOnDeviceResult,
    };
  } finally {
    await closeAll();
  }
}

async function main() {
  const server = await ensureViteDevServer();
  try {
    const baselineProfileResult = await probeNativeProfile({
      label: "Profile 1: Baseline Prompt API (Gemini Nano default, Gemma 4 Default/Off)",
      profileDir: DEV_PROFILE,
      cdpPort: 9333,
      labsExperiments: [
        "prompt-api@1",
        "prompt-api-multimodal-input@1",
        "optimization-guide-debug-logs@1",
      ],
    });

    const gemma4ProfileResult = await probeNativeProfile({
      label: "Profile 2: Isolated Gemma 4 for Built-in AI Enabled",
      profileDir: GEMMA4_PROFILE,
      cdpPort: 9334,
      labsExperiments: [
        "prompt-api@1",
        "prompt-api-multimodal-input@1",
        "gemma4-for-built-in-ai@1",
        "optimization-guide-debug-logs@1",
      ],
    });

    console.log(
      JSON.stringify(
        {
          chromeExecutable: CHROME_EXE,
          baselineProfileResult,
          gemma4ProfileResult,
        },
        null,
        2
      )
    );
  } finally {
    await server.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

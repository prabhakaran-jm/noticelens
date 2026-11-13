import { spawn } from "node:child_process";
import fs from "node:fs";

const CHROME_EXE = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PROFILE_DIR = process.env.NOTICELENS_CHROME_PROFILE_DIR || "D:\\chrome-noticelens-dev";
const TARGET_URL = process.env.NOTICELENS_DEV_URL || "http://127.0.0.1:5173";

if (!fs.existsSync(CHROME_EXE)) {
  console.error(`Desktop Chrome executable not found at: ${CHROME_EXE}`);
  process.exit(1);
}

fs.mkdirSync(PROFILE_DIR, { recursive: true });

const child = spawn(
  CHROME_EXE,
  [
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    TARGET_URL,
  ],
  {
    detached: true,
    stdio: "ignore",
  }
);

child.unref();
console.log(
  JSON.stringify(
    {
      launched: true,
      chromeExecutable: CHROME_EXE,
      userDataDir: PROFILE_DIR,
      url: TARGET_URL,
    },
    null,
    2
  )
);

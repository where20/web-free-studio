import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
export const DATA_DIR = path.join(ROOT, "data");
export const PROFILE_DIR = path.join(DATA_DIR, "profiles");
export const ASSET_DIR = path.join(DATA_DIR, "assets");
export const DB_FILE = path.join(DATA_DIR, "db.json");
export const WEB_DIR = path.join(ROOT, "web");

export const UPSTREAM = {
  origin: "https://www.paba.tv",
  api: "https://www.paba.tv",
  videoPage: "https://www.paba.tv/#video",
  loginPage: "https://www.paba.tv/#video",
  challengePage: "https://www.paba.tv/__h3c/fresh.html",
  contentHost: "https://media.paba.tv",
};

export const RUNTIME = {
  port: Number(process.env.PORT || 8790),
  headless: process.env.HEADED === "1" ? false : true,
  syncIntervalMs: Number(process.env.SYNC_INTERVAL_MS || 45_000),
  listLimit: 40,
  challengeTimeoutMs: Number(process.env.CHALLENGE_TIMEOUT_MS || 150_000),
  mirrorPerSync: Number(process.env.MIRROR_PER_SYNC || 6),
  debugPortBase: Number(process.env.CHROME_DEBUG_PORT || 9333),
};

export const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

export function chromePath() {
  for (const p of CHROME_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

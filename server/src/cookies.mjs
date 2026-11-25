import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, providerConfig } from "./config.mjs";

const DIR = path.join(DATA_DIR, "accounts");
const COOKIE_NAMES = ["h3v", "h3s", "__Host-h3d"];

async function ensure() {
  await fs.mkdir(DIR, { recursive: true });
}

export function cookiePath(accountId) {
  return path.join(DIR, `${accountId}.cookies.json`);
}

export function credPath(accountId) {
  return path.join(DIR, `${accountId}.cred.json`);
}

export async function readCookies(accountId) {
  try {
    const raw = await fs.readFile(cookiePath(accountId), "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((c) => c && c.name && c.value) : [];
  } catch {
    return [];
  }
}

export async function writeCookies(accountId, cookies, provider) {
  await ensure();
  const cfg = providerConfig(provider);
  const clean = (cookies || [])
    .filter((c) => c && c.name && typeof c.value === "string")
    .map((c) => ({
      name: c.name,
      value: c.value,
      path: c.path || "/",
      domain: c.domain || cfg.cookieDomain,
      httpOnly: c.httpOnly !== false,
      secure: c.secure !== false,
      expires: Number(c.expires || 0) || undefined,
    }));
  const tmp = `${cookiePath(accountId)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(clean, null, 1), { mode: 0o600 });
  await fs.rename(tmp, cookiePath(accountId));
  await fs.chmod(cookiePath(accountId), 0o600).catch(() => {});
  return clean.length;
}

export async function deleteCookies(accountId) {
  await fs.rm(cookiePath(accountId), { force: true }).catch(() => {});
}

/** 账号密码只落本地，mode 600；仅用于「邮箱密码登录」这一条路径 */
export async function writeCred(accountId, cred) {
  await ensure();
  const payload = { email: cred.email || "", password: cred.password || "", savedAt: Date.now() };
  const tmp = `${credPath(accountId)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 1), { mode: 0o600 });
  await fs.rename(tmp, credPath(accountId));
  await fs.chmod(credPath(accountId), 0o600).catch(() => {});
}

export async function readCred(accountId) {
  try {
    return JSON.parse(await fs.readFile(credPath(accountId), "utf8"));
  } catch {
    return null;
  }
}

export function maskCookies(cookies) {
  return (cookies || []).map((c) => ({
    name: c.name,
    len: (c.value || "").length,
    httpOnly: c.httpOnly,
    expires: c.expires || null,
    preview: `${(c.value || "").slice(0, 4)}…${(c.value || "").slice(-4)}`,
  }));
}

export { COOKIE_NAMES };

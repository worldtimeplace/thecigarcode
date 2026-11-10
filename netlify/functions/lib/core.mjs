import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

export const env = (k) => (typeof Netlify !== "undefined" && Netlify.env ? Netlify.env.get(k) : process.env[k]) || "";
export const store = () => getStore({ name: "club", consistency: "strong" });

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

export const isDemo = () => !env("LINE_CHANNEL_ID") || !env("LINE_CHANNEL_SECRET");
const secret = () => env("SESSION_SECRET") || env("LINE_CHANNEL_SECRET") || "tcc-demo-secret";
const b64 = (s) => Buffer.from(s).toString("base64url");
const sign = (v) => crypto.createHmac("sha256", secret()).update(v).digest("base64url");

export function makeSession(uid, days = 90) {
  const p = b64(JSON.stringify({ uid, exp: Date.now() + days * 864e5 }));
  return `${p}.${sign(p)}`;
}
export function cookie(name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
export function readCookie(req, name) {
  const c = req.headers.get("cookie") || "";
  const m = c.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? m[1] : "";
}
export function session(req) {
  const v = readCookie(req, "tcc_s");
  if (!v || !v.includes(".")) return null;
  const [p, s] = v.split(".");
  if (sign(p) !== s) return null;
  try {
    const o = JSON.parse(Buffer.from(p, "base64url").toString());
    return o.exp > Date.now() ? o : null;
  } catch { return null; }
}
export async function getUser(uid) {
  return (await store().get(`users/${uid}`, { type: "json" })) || null;
}
export async function putUser(u) {
  await store().setJSON(`users/${u.uid}`, u);
  return u;
}
export const clubCode = () => (env("CLUB_CODE") || "CIGARCODE").trim().toUpperCase();

export async function claude(system, messages, max = 900) {
  const key = env("ANTHROPIC_API_KEY");
  if (!key) return null;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: env("CLAUDE_MODEL") || "claude-sonnet-5-5", max_tokens: max, system, messages }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || "AI error");
  return (j.content || []).map((c) => c.text || "").join("").trim();
}
export const id = () => Date.now().toString(36) + crypto.randomBytes(4).toString("hex");

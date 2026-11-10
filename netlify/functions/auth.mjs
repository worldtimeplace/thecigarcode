import crypto from "node:crypto";
import { env, json, isDemo, makeSession, cookie, readCookie, session, getUser, putUser } from "./lib/core.mjs";

const ORIGIN = () => env("SITE_ORIGIN") || "https://thecigarcode.net";
const redirect = (to, cookies = []) => {
  const h = new Headers({ Location: to, "cache-control": "no-store" });
  cookies.forEach((c) => h.append("Set-Cookie", c));
  return new Response(null, { status: 302, headers: h });
};

export default async (req) => {
  const url = new URL(req.url);
  const action = url.pathname.split("/").pop();

  if (action === "login") {
    if (isDemo()) return redirect("/club/?demo=1");
    const state = crypto.randomBytes(16).toString("hex");
    const q = new URLSearchParams({
      response_type: "code",
      client_id: env("LINE_CHANNEL_ID"),
      redirect_uri: `${ORIGIN()}/api/auth/callback`,
      state,
      scope: "profile openid",
    });
    return redirect(`https://access.line.me/oauth2/v2.1/authorize?${q}`, [cookie("tcc_st", state, 600)]);
  }

  if (action === "callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state || state !== readCookie(req, "tcc_st")) return redirect("/club/?err=state");
    const tr = await fetch("https://api.line.me/oauth2/v2.1/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${ORIGIN()}/api/auth/callback`,
        client_id: env("LINE_CHANNEL_ID"),
        client_secret: env("LINE_CHANNEL_SECRET"),
      }),
    });
    const tok = await tr.json();
    if (!tok.access_token) return redirect("/club/?err=token");
    const pr = await fetch("https://api.line.me/v2/profile", { headers: { Authorization: `Bearer ${tok.access_token}` } });
    const p = await pr.json();
    if (!p.userId) return redirect("/club/?err=profile");
    const uid = "line-" + p.userId;
    const u = (await getUser(uid)) || { uid, member: false, at: Date.now() };
    u.lineName = p.displayName || "";
    u.pic = p.pictureUrl || "";
    if (!u.name) u.name = u.lineName;
    await putUser(u);
    return redirect("/club/", [cookie("tcc_s", makeSession(uid), 90 * 86400), cookie("tcc_st", "", 0)]);
  }

  if (action === "demo" && req.method === "POST") {
    if (!isDemo()) return json({ error: "disabled" }, 403);
    const b = await req.json().catch(() => ({}));
    const name = String(b.name || "").trim().slice(0, 40);
    if (!name) return json({ error: "name" }, 400);
    const uid = "demo-" + crypto.createHash("sha1").update(name).digest("hex").slice(0, 12);
    const u = (await getUser(uid)) || { uid, name, lineName: name, pic: "", member: false, at: Date.now() };
    await putUser(u);
    return json({ ok: true }, 200, { "Set-Cookie": cookie("tcc_s", makeSession(uid), 30 * 86400) });
  }

  if (action === "logout") return redirect("/club/", [cookie("tcc_s", "", 0)]);

  if (action === "me") {
    const s = session(req);
    const u = s ? await getUser(s.uid) : null;
    return json({ user: u, demo: isDemo(), ai: !!env("ANTHROPIC_API_KEY") });
  }
  return json({ error: "not found" }, 404);
};

export const config = { path: "/api/auth/*" };

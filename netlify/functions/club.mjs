import { json, store, session, getUser, putUser, clubCode, claude, id, env } from "./lib/core.mjs";
import K from "./lib/knowledge.mjs";

const clip = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

async function listJSON(prefix) {
  const st = store();
  const { blobs } = await st.list({ prefix });
  const rows = await Promise.all(blobs.map((b) => st.get(b.key, { type: "json" })));
  return rows.filter(Boolean);
}
const pub = (u) => ({ uid: u.uid, name: u.name, company: u.company || "", title: u.title || "", fav: u.fav || "", bio: u.bio || "", pic: u.pic || "", likes: u.likes || "" });

const KNOW = (() => {
  const b = K.brands.map((x) => `- ${x.name}（${x.kana}）[${x.kind}${x.country ? "・" + x.country : ""}] 強さ:${x.strength}。${x.note}${x.sizes?.length ? " 代表サイズ: " + x.sizes.join(", ") : ""}`).join("\n");
  const o = K.other_habanos.map((x) => `- ${x.name}（${x.kana}）創業${x.est}・${x.strength}`).join("\n");
  const l = K.lounges.map((x) => `- [${x.area}] ${x.name}（${x.where}）${x.about} 営業:${x.hours} 定休:${x.closed}`).join("\n");
  return `## 銘柄\n${b}\n${o}\n\n## 都内のシガーバー・ラウンジ\n${l}\n\n## 次回の会\n${K.next.date} ${K.next.venue}`;
})();

const SYS_CONCIERGE = `あなたは「THE CIGAR CODE」（東京の経営者20名ほどが集う、葉巻を嗜む紳士淑女の会）の専属シガー・コンシェルジュです。
口調は落ち着いた上質なバーの名バーテンダーのように、丁寧で簡潔に。日本語で質問されたら日本語、英語なら英語で答えます。
スマートフォンで読まれるため、答えは短め（目安200〜350字）にし、銘柄を勧めるときは2〜3本に絞って理由を一言添えます。
下の「知識」にある銘柄・ラウンジ情報を優先して使い、知らないことや不確かなことは推測と明示します。営業時間などは変わることがあるので「お店にご確認ください」と添えます。
健康上の効能をうたわず、20歳未満への助言はしません。

# 知識
`;

async function demoAnswer(q) {
  const t = q.toLowerCase();
  const hit = K.brands.filter((b) => t.includes(b.name.toLowerCase()) || q.includes(b.kana)).slice(0, 2);
  const pick = hit.length ? hit : K.brands.filter((b) => /ミディアム/.test(b.strength)).sort(() => Math.random() - 0.5).slice(0, 3);
  return `（お試しモード：AIキーを設定すると、ご質問に合わせて自由にお答えします）\n\n` +
    pick.map((b) => `・${b.name}（${b.strength}）— ${b.note.slice(0, 70)}…`).join("\n");
}

export default async (req) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/club\/?/, "").split("/").filter(Boolean);
  const [r0, r1, r2] = parts;
  const s = session(req);
  if (!s) return json({ error: "login" }, 401);
  const me = await getUser(s.uid);
  if (!me) return json({ error: "login" }, 401);
  const st = store();

  // join with invite code
  if (r0 === "join" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    if (String(b.code || "").trim().toUpperCase() !== clubCode()) return json({ error: "code" }, 403);
    me.member = true;
    me.joined = me.joined || Date.now();
    await putUser(me);
    return json({ user: me });
  }
  if (!me.member) return json({ error: "member" }, 403);

  // images (members only)
  if (r0 === "img" && r1) {
    const b = await st.getWithMetadata(`imgs/${r1}`, { type: "arrayBuffer" });
    if (!b) return new Response("", { status: 404 });
    return new Response(b.data, { headers: { "content-type": b.metadata?.type || "image/jpeg", "cache-control": "private, max-age=86400" } });
  }

  if (r0 === "profile" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    me.name = clip(b.name, 40) || me.name;
    me.company = clip(b.company, 60);
    me.title = clip(b.title, 60);
    me.fav = clip(b.fav, 60);
    me.likes = clip(b.likes, 120);
    me.bio = clip(b.bio, 400);
    await putUser(me);
    return json({ user: me });
  }

  if (r0 === "members") {
    const users = (await listJSON("users/")).filter((u) => u.member);
    const logs = await listJSON("logs/");
    const cnt = {};
    logs.forEach((l) => (cnt[l.uid] = (cnt[l.uid] || 0) + 1));
    if (r1) {
      const u = users.find((x) => x.uid === r1);
      if (!u) return json({ error: "nf" }, 404);
      return json({ member: pub(u), logs: logs.filter((l) => l.uid === r1).sort((a, b) => b.at - a.at) });
    }
    return json({ members: users.map((u) => ({ ...pub(u), count: cnt[u.uid] || 0 })).sort((a, b) => (a.name || "").localeCompare(b.name || "", "ja")) });
  }

  // humidor log
  if (r0 === "logs") {
    if (req.method === "GET") {
      let logs = await listJSON("logs/");
      if (url.searchParams.get("mine")) logs = logs.filter((l) => l.uid === me.uid);
      logs.sort((a, b) => b.at - a.at);
      const users = Object.fromEntries((await listJSON("users/")).map((u) => [u.uid, u]));
      return json({ logs: logs.slice(0, 120).map((l) => ({ ...l, who: users[l.uid]?.name || "", pic: users[l.uid]?.pic || "" })) });
    }
    if (req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const brand = clip(b.brand, 60);
      if (!brand) return json({ error: "brand" }, 400);
      const L = { id: id(), uid: me.uid, brand, line: clip(b.line, 60), vitola: clip(b.vitola, 60), rating: Math.max(0, Math.min(5, parseInt(b.rating) || 0)), note: clip(b.note, 300), place: clip(b.place, 60), date: clip(b.date, 10) || today(), at: Date.now(), img: "" };
      if (b.img && /^data:image\/(jpeg|png|webp);base64,/.test(b.img)) {
        const [head, data] = b.img.split(",");
        const buf = Buffer.from(data, "base64");
        if (buf.length < 4.5e6) {
          const k = id();
          await st.set(`imgs/${k}`, buf, { metadata: { type: head.slice(5, head.indexOf(";")) } });
          L.img = k;
        }
      }
      await st.setJSON(`logs/${L.id}`, L);
      return json({ log: L });
    }
    if (req.method === "DELETE" && r1) {
      const L = await st.get(`logs/${r1}`, { type: "json" });
      if (!L || L.uid !== me.uid) return json({ error: "nf" }, 404);
      await st.delete(`logs/${r1}`);
      if (L.img) await st.delete(`imgs/${L.img}`);
      return json({ ok: true });
    }
  }

  // AI: read a cigar band from a photo
  if (r0 === "scan" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(b.img || "");
    if (!m) return json({ error: "img" }, 400);
    const names = K.brands.map((x) => x.name).concat(K.other_habanos.map((x) => x.name)).join(", ");
    try {
      const out = await claude(
        "You identify premium cigars from photos of their bands. Reply ONLY with compact JSON: {\"brand\":\"\",\"line\":\"\",\"vitola\":\"\",\"confidence\":0-1}. Use the brand's common English spelling. If unsure, leave fields empty. Known brands: " + names,
        [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } }, { type: "text", text: "この葉巻の銘柄を教えてください。JSONのみで。" }] }],
        200
      );
      if (out === null) return json({ demo: true, brand: "", line: "", vitola: "" });
      const j = JSON.parse((out.match(/\{[\s\S]*\}/) || ["{}"])[0]);
      return json({ brand: clip(j.brand, 60), line: clip(j.line, 60), vitola: clip(j.vitola, 60), confidence: Number(j.confidence) || 0 });
    } catch (e) {
      return json({ error: "ai", message: String(e.message || e) }, 502);
    }
  }

  // AI concierge
  if (r0 === "ask" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    const msgs = (Array.isArray(b.messages) ? b.messages : []).slice(-12)
      .map((x) => ({ role: x.role === "assistant" ? "assistant" : "user", content: clip(x.content, 1500) }))
      .filter((x) => x.content);
    if (!msgs.length || msgs[msgs.length - 1].role !== "user") return json({ error: "msg" }, 400);
    const mine = (await listJSON("logs/")).filter((l) => l.uid === me.uid).sort((a, c) => c.at - a.at).slice(0, 15);
    const ctx = `\n\n# 質問者\n${me.name}${me.company ? "（" + me.company + "）" : ""}。好きな一本: ${me.fav || "未登録"}。好み: ${me.likes || "未登録"}。\n最近の記録: ${mine.map((l) => `${l.brand} ${l.line} ${l.vitola}（★${l.rating}${l.note ? "・" + l.note : ""}）`).join(" / ") || "なし"}`;
    try {
      const out = await claude(SYS_CONCIERGE + KNOW + ctx, msgs, 900);
      return json({ answer: out === null ? await demoAnswer(msgs[msgs.length - 1].content) : out, demo: out === null });
    } catch (e) {
      return json({ error: "ai", message: String(e.message || e) }, 502);
    }
  }

  // AI: who to talk to at the next gathering
  if (r0 === "intro") {
    const key = `intro/${today()}/${me.uid}`;
    if (!url.searchParams.get("fresh")) {
      const c = await st.get(key, { type: "json" });
      if (c) return json(c);
    }
    const others = (await listJSON("users/")).filter((u) => u.member && u.uid !== me.uid);
    if (!others.length) return json({ picks: [] });
    const logs = await listJSON("logs/");
    const desc = (u) => `${u.uid}: ${u.name}／${u.company || "-"}／${u.title || "-"}／好きな一本:${u.fav || "-"}／好み:${u.likes || "-"}／紹介:${(u.bio || "").slice(0, 120)}／最近:${logs.filter((l) => l.uid === u.uid).slice(0, 4).map((l) => l.brand).join("・") || "-"}`;
    let picks = [];
    try {
      const out = await claude(
        "あなたは経営者が集う葉巻の会の気の利いた幹事です。質問者が次回の会で話すと面白そうなメンバーを最大3名選び、理由を40字程度の自然な日本語で添えます。共通点（好きな銘柄・業種・関心）や、互いに助けになりそうな点を重視。JSONのみで返答: {\"picks\":[{\"uid\":\"\",\"why\":\"\"}]}",
        [{ role: "user", content: `質問者:\n${desc(me)}\n\nメンバー:\n${others.map(desc).join("\n")}` }],
        500
      );
      if (out !== null) picks = (JSON.parse((out.match(/\{[\s\S]*\}/) || ["{}"])[0]).picks || []).filter((p) => others.find((o) => o.uid === p.uid)).slice(0, 3);
      else picks = others.sort(() => Math.random() - 0.5).slice(0, 3).map((o) => ({ uid: o.uid, why: o.fav ? `「${o.fav}」がお好きな方。最初の一本の話題にどうぞ。` : "まだお話ししたことのない方かもしれません。" }));
    } catch (e) {
      return json({ error: "ai", message: String(e.message || e) }, 502);
    }
    const res = { picks: picks.map((p) => ({ ...pub(others.find((o) => o.uid === p.uid)), why: clip(p.why, 120) })), date: today() };
    await st.setJSON(key, res);
    return json(res);
  }

  // AI: my year in cigars
  if (r0 === "year") {
    const y = url.searchParams.get("y") || today().slice(0, 4);
    const mine = (await listJSON("logs/")).filter((l) => l.uid === me.uid && (l.date || "").startsWith(y)).sort((a, b) => (a.date > b.date ? 1 : -1));
    const by = {};
    mine.forEach((l) => (by[l.brand] = (by[l.brand] || 0) + 1));
    const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const best = mine.filter((l) => l.rating >= 4).slice(-5);
    let text = "";
    if (mine.length) {
      try {
        text = await claude(
          "葉巻の会の会員向けに、その人の一年の葉巻の記録を上品で温かい文章（日本語・200字程度）でまとめます。数字は正確に。押し付けがましい健康の話はしない。",
          [{ role: "user", content: `${me.name}さんの${y}年: 合計${mine.length}本。銘柄: ${top.map(([b, n]) => `${b}×${n}`).join("、")}。高評価: ${best.map((l) => `${l.brand} ${l.line}（${l.note}）`).join(" / ")}` }],
          500
        );
      } catch { text = null; }
      if (!text) text = `${y}年は${mine.length}本を記録しました。いちばん多く手に取ったのは${top[0][0]}（${top[0][1]}本）。`;
    }
    return json({ year: y, total: mine.length, top, best, text });
  }

  // requests & votes
  if (r0 === "ideas") {
    if (req.method === "GET") {
      const ideas = await listJSON("ideas/");
      const users = Object.fromEntries((await listJSON("users/")).map((u) => [u.uid, u.name]));
      return json({ ideas: ideas.map((i) => ({ ...i, who: users[i.uid] || "", n: i.votes.length, mine: i.votes.includes(me.uid), own: i.uid === me.uid, votes: undefined })).sort((a, b) => b.n - a.n || b.at - a.at) });
    }
    if (req.method === "POST" && !r1) {
      const b = await req.json().catch(() => ({}));
      const text = clip(b.text, 140);
      if (!text) return json({ error: "text" }, 400);
      const I = { id: id(), uid: me.uid, kind: ["venue", "cigar", "event"].includes(b.kind) ? b.kind : "event", text, votes: [me.uid], at: Date.now() };
      await st.setJSON(`ideas/${I.id}`, I);
      return json({ ok: true });
    }
    if (req.method === "POST" && r1 && r2 === "vote") {
      const I = await st.get(`ideas/${r1}`, { type: "json" });
      if (!I) return json({ error: "nf" }, 404);
      I.votes = I.votes.includes(me.uid) ? I.votes.filter((v) => v !== me.uid) : [...I.votes, me.uid];
      await st.setJSON(`ideas/${r1}`, I);
      return json({ ok: true, n: I.votes.length, mine: I.votes.includes(me.uid) });
    }
    if (req.method === "DELETE" && r1) {
      const I = await st.get(`ideas/${r1}`, { type: "json" });
      if (!I || I.uid !== me.uid) return json({ error: "nf" }, 404);
      await st.delete(`ideas/${r1}`);
      return json({ ok: true });
    }
  }

  return json({ error: "not found" }, 404);
};

export const config = { path: "/api/club/*" };

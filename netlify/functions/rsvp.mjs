import { getStore } from "@netlify/blobs";

const EVENTS = new Set(["2026-11-18"]);
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

async function summary(store, event) {
  const { blobs } = await store.list({ prefix: event + "/" });
  const rows = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);
  rows.sort((a, b) => (a.at || 0) - (b.at || 0));
  const yes = rows.filter((r) => r.status === "yes");
  return {
    event,
    attending: yes.reduce((n, r) => n + (r.guests || 1), 0),
    responses: yes.length,
    declined: rows.filter((r) => r.status === "no").length,
    people: yes.map((r) => ({ name: r.name, guests: r.guests || 1 })),
  };
}

export default async (req) => {
  const store = getStore({ name: "rsvp", consistency: "strong" });
  const url = new URL(req.url);

  if (req.method === "GET") {
    const event = url.searchParams.get("event") || "";
    if (!EVENTS.has(event)) return json({ error: "unknown event" }, 400);
    return json(await summary(store, event));
  }

  if (req.method === "POST") {
    let b;
    try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const event = String(b.event || "");
    const id = String(b.id || "");
    const name = String(b.name || "").replace(/\s+/g, " ").trim().slice(0, 40);
    const status = b.status === "yes" ? "yes" : b.status === "no" ? "no" : "";
    const guests = Math.min(4, Math.max(1, parseInt(b.guests, 10) || 1));
    if (b.website) return json({ ok: true }); // honeypot
    if (!EVENTS.has(event) || !/^[a-z0-9-]{16,64}$/.test(id) || !name || !status)
      return json({ error: "invalid" }, 400);
    await store.setJSON(`${event}/${id}`, { name, status, guests: status === "yes" ? guests : 0, at: Date.now() });
    return json(await summary(store, event));
  }

  return json({ error: "method" }, 405);
};

export const config = { path: "/api/rsvp" };

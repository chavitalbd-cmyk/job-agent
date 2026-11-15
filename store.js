/* Job Agent · storage layer
 * Gives the page the same small API it used inside Claude:
 *   db.collection(name).onSnapshot(cb, err) / .add(data)
 *   db.doc("collection/id").onSnapshot(cb, err) / .get() / .set(data) / .update(patch)
 * Backends:
 *   - Supabase (when config.js has supabaseUrl + supabaseAnonKey): data lives in your own Supabase project,
 *     each user sees only their own rows (Row Level Security).
 *   - local (no config): data lives in this browser only (localStorage). Good for trying the site.
 * Also exposes window.Store for the Claude agent (read/write from a logged-in browser tab) and for import/export.
 */
(function () {
  const CFG = window.JOB_AGENT_CONFIG || {};
  const listeners = new Set();           // {type:'col'|'doc', col, id, cb}
  let backend = null;

  const snapCol = (rows) => ({ metadata: { fromCache: false }, docs: rows.map(r => ({ id: r.id, exists: true, data: () => clone(r.data) })) });
  const snapDoc = (row) => ({ id: row ? row.id : undefined, exists: !!row, data: () => (row ? clone(row.data) : undefined) });
  const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const split = (path) => { const i = path.indexOf("/"); return [path.slice(0, i), path.slice(i + 1)]; };

  /* ---------- local backend ---------- */
  function localBackend() {
    const KEY = "jobAgentLocalDB";
    let mem = {};
    try { mem = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (_) { mem = {}; }
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch (_) {} };
    const col = (c) => (mem[c] = mem[c] || {});
    return {
      mode: "local",
      async list(c) { return Object.entries(col(c)).map(([id, data]) => ({ id, data })); },
      async get(c, id) { const d = col(c)[id]; return d ? { id, data: d } : null; },
      async set(c, id, data) { col(c)[id] = clone(data); save(); changed(c, id); },
      async merge(c, id, patch) { col(c)[id] = Object.assign({}, col(c)[id] || {}, clone(patch)); save(); changed(c, id); },
      async remove(c, id) { delete col(c)[id]; save(); changed(c, id); },
      async bulk(rows) { rows.forEach(r => { col(r.collection)[r.id] = clone(r.data); }); save(); rows.forEach(r => changed(r.collection, r.id)); },
      async clearAll() { mem = {}; save(); },
    };
  }

  /* ---------- Supabase backend ---------- */
  function supaBackend(sb) {
    const T = "docs";
    const chk = ({ data, error }) => { if (error) throw error; return data; };
    const b = {
      mode: "supabase",
      async list(c) {
        const out = []; let from = 0;
        for (;;) {
          const rows = chk(await sb.from(T).select("id,data").eq("collection", c).range(from, from + 999));
          out.push(...rows); if (rows.length < 1000) break; from += 1000;
        }
        return out;
      },
      async get(c, id) { const rows = chk(await sb.from(T).select("id,data").eq("collection", c).eq("id", id).limit(1)); return rows[0] || null; },
      async set(c, id, data) { chk(await sb.from(T).upsert({ collection: c, id, data }, { onConflict: "owner,collection,id" })); changed(c, id); },
      async merge(c, id, patch) { chk(await sb.rpc("doc_merge", { p_collection: c, p_id: id, p_patch: patch })); changed(c, id); },
      async remove(c, id) { chk(await sb.from(T).delete().eq("collection", c).eq("id", id)); changed(c, id); },
      async bulk(rows) {
        for (let i = 0; i < rows.length; i += 200) {
          chk(await sb.from(T).upsert(rows.slice(i, i + 200).map(r => ({ collection: r.collection, id: r.id, data: r.data })), { onConflict: "owner,collection,id" }));
        }
        [...new Set(rows.map(r => r.collection))].forEach(c => changed(c, null));
      },
      async clearAll() { chk(await sb.from(T).delete().neq("collection", "")); },
    };
    // live updates (other tabs, the agent, the nightly collector)
    try {
      sb.channel("docs-live").on("postgres_changes", { event: "*", schema: "public", table: T }, (p) => {
        const r = p.new && p.new.collection ? p.new : p.old || {};
        if (r.collection) changed(r.collection, r.id || null); else refreshAll();
      }).subscribe();
    } catch (_) {}
    return b;
  }

  /* ---------- change fan-out ---------- */
  const timers = {};
  function changed(c, id) {
    clearTimeout(timers[c]);
    timers[c] = setTimeout(() => fire(c), 120);
  }
  async function fire(c) {
    const ls = [...listeners].filter(l => l.col === c);
    if (!ls.length) return;
    let rows; try { rows = await backend.list(c); } catch (e) { ls.forEach(l => l.err && l.err(e)); return; }
    ls.forEach(l => {
      try {
        if (l.type === "col") l.cb(snapCol(rows));
        else l.cb(snapDoc(rows.find(r => r.id === l.id) || null));
      } catch (e) { console.error(e); }
    });
  }
  function refreshAll() { [...new Set([...listeners].map(l => l.col))].forEach(fire); }

  /* ---------- Firestore-like API for the page ---------- */
  const db = {
    collection(c) {
      return {
        onSnapshot(cb, err) { const l = { type: "col", col: c, cb, err }; listeners.add(l); fire(c); return () => listeners.delete(l); },
        async add(data) { const id = uid(); await backend.set(c, id, data); return { id }; },
        doc(id) { return db.doc(c + "/" + id); },
      };
    },
    doc(path) {
      const [c, id] = split(path);
      return {
        id,
        onSnapshot(cb, err) { const l = { type: "doc", col: c, id, cb, err }; listeners.add(l); fire(c); return () => listeners.delete(l); },
        async get() { return snapDoc(await backend.get(c, id)); },
        async set(data) { await backend.set(c, id, data); },
        async update(patch) { await backend.merge(c, id, patch); },
        async delete() { await backend.remove(c, id); },
      };
    },
  };

  /* ---------- auth + init ---------- */
  let sb = null;
  async function init() {
    if (CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase) {
      sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });
      const { data } = await sb.auth.getSession();
      if (!data.session) return null;           // page shows the login screen
      backend = supaBackend(sb);
    } else {
      backend = localBackend();
    }
    return db;
  }
  async function signIn(email, password) {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }
  async function signOut() { if (sb) await sb.auth.signOut(); location.reload(); }
  async function user() { if (!sb) return null; const { data } = await sb.auth.getUser(); return data.user || null; }

  /* ---------- import / export (backup, moving data, onboarding others) ---------- */
  const COLS = ["jobs", "settings", "courses", "roles", "inbox", "sourceInbox"];
  async function exportAll() {
    const out = { format: "job-agent-export", version: 1, exportedAt: new Date().toISOString(), collections: {} };
    for (const c of COLS) { out.collections[c] = {}; (await backend.list(c)).forEach(r => { out.collections[c][r.id] = r.data; }); }
    return out;
  }
  async function importAll(obj) {
    const cols = (obj && obj.collections) || obj || {};
    const rows = [];
    Object.entries(cols).forEach(([c, docs]) => { Object.entries(docs || {}).forEach(([id, data]) => rows.push({ collection: c, id, data })); });
    await backend.bulk(rows);
    return rows.length;
  }

  window.Store = {
    init, signIn, signOut, user, exportAll, importAll,
    get mode() { return backend ? backend.mode : (CFG.supabaseUrl ? "supabase" : "local"); },
    get configured() { return !!(CFG.supabaseUrl && CFG.supabaseAnonKey); },
    // simple helpers for the Claude agent working from a logged-in tab
    list: (c) => backend.list(c),
    get: (c, id) => backend.get(c, id),
    set: (c, id, data) => backend.set(c, id, data),
    merge: (c, id, patch) => backend.merge(c, id, patch),
    remove: (c, id) => backend.remove(c, id),
    bulk: (rows) => backend.bulk(rows),
  };
})();

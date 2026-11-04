// 院の連絡帳（多機能・数店舗対応）
// 今日のボード・今日いる人・申し送り・訪問の動き・点検表・備品・暗証番号・全店まとめ・設定
// 院の帳（予定・決まり・練習・ありがとう・探す）・定型文・スマホへのお知らせ
// 置き場所：院が自分で持つCloudflareのアカウント
//
// 設定（院名・店舗・スタッフ・店長・連絡の種類・残す日数）は、院長の画面から変えて、データベースに残す。
// まだ一度も保存していないときだけ、wrangler.toml の [vars] をはじめの値として使う。
// 合言葉は、置くときに INCHO_PASSCODE / STAFF_PASSCODE として登録する。院長の画面で変えたら、そちらが優先される。
// DEMO = "1" のときは「お試し用」：合言葉なしで役を選んで入れて、毎日元に戻る。

const VISIT_LABELS = ["出発しました", "到着しました", "終わりました", "遅れます"];
const STAFF_STATUS = ["出勤", "遅れます", "休みます"];
const INCHO_STATUS = ["院内", "外出"];
const PHASES = ["開院前", "閉院後"];
const DEFAULT_TAGS = ["朝礼", "予約の変更", "連絡"];
const DEFAULT_CHECKLIST = [
  ["開院前", "施術室の換気"], ["開院前", "ベッドとタオルの準備"], ["開院前", "消毒用品の補充"], ["開院前", "受付の準備"],
  ["閉院後", "使ったタオルの片付け"], ["閉院後", "器具の片付け"], ["閉院後", "火の元・電気の確認"], ["閉院後", "戸締まり"],
];
const DEFAULT_PRACTICE = [
  "受付での挨拶と案内", "ベッドメイク", "タオルのたたみ方", "器具の片付け",
  "予約の取り方", "電話の受け方", "開院前の準備", "閉院後の片付け",
];
const DEFAULT_TEMPLATES = ["今日は特に連絡なし", "本日は16時で受付終了です", "〇時から院長は外出します"];
const ALL = "*"; // 全店舗に出す連絡
const MAX_TEXT = 1000;
const MAX_SHORT = 200;
const SESSION_DAYS = 30;
const PIN_MAX_FAIL = 5;
const PIN_LOCK_MIN = 15;
const enc = new TextEncoder();

// お試し用の院（DEMO = "1" のとき）
const DEMO_CONFIG = {
  clinic: "見本の院", stores: ["本院", "北店"],
  staff: { 北川: ["本院"], 小野: ["本院", "北店"], 松井: ["北店"] },
  managers: ["松井@北店"], tags: DEFAULT_TAGS, templates: DEFAULT_TEMPLATES, retainPost: 0, retainHandoff: 0,
};

// ---------- 小道具 ----------
const jstDay = (offsetDays = 0) =>
  new Date(Date.now() + 9 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();
const list = (s) => String(s || "").replace(/[、，]/g, ",").split(",").map((x) => x.trim()).filter(Boolean);
const isDemo = (env) => env.DEMO === "1";

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}
const fail = (msg, status = 400) => json({ error: msg }, status);

function b64url(buf) {
  let s = "";
  new Uint8Array(buf).forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const b64urlText = (str) => b64url(enc.encode(str));
function fromB64urlText(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}
function safeEqual(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}
function cleanText(t, max = MAX_TEXT) {
  const s = String(t || "").trim();
  return s ? s.slice(0, max) : null;
}
const randomStr = (n = 16) => b64url(crypto.getRandomValues(new Uint8Array(n)));

// ---------- 記録の入れ物（アプリが自分で作る） ----------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, tag TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, store TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '')`,
  `CREATE INDEX IF NOT EXISTS posts_day ON posts(day)`,
  `CREATE TABLE IF NOT EXISTS checks (post_id INTEGER NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (post_id, name))`,
  `CREATE TABLE IF NOT EXISTS post_important (post_id INTEGER PRIMARY KEY)`,
  `CREATE TABLE IF NOT EXISTS replies (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS replies_post ON replies(post_id)`,
  `CREATE TABLE IF NOT EXISTS handoffs (id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, done_at TEXT, done_by TEXT, store TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS visit_routes (day TEXT NOT NULL, name TEXT NOT NULL, stops TEXT NOT NULL, store TEXT NOT NULL DEFAULT '', PRIMARY KEY (day, name))`,
  `CREATE TABLE IF NOT EXISTS visit_status (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, name TEXT NOT NULL, label TEXT NOT NULL, created_at TEXT NOT NULL, store TEXT NOT NULL DEFAULT '')`,
  `CREATE INDEX IF NOT EXISTS visit_status_day ON visit_status(day, name)`,
  `CREATE TABLE IF NOT EXISTS attendance (day TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', set_by TEXT NOT NULL, updated_at TEXT NOT NULL, store TEXT NOT NULL DEFAULT '', PRIMARY KEY (day, name))`,
  `CREATE TABLE IF NOT EXISTS checklist_items (id INTEGER PRIMARY KEY AUTOINCREMENT, phase TEXT NOT NULL, label TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, store TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS checklist_done (day TEXT NOT NULL, item_id INTEGER NOT NULL, name TEXT NOT NULL, done_at TEXT NOT NULL, PRIMARY KEY (day, item_id))`,
  `CREATE TABLE IF NOT EXISTS supplies (id INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', author TEXT NOT NULL, created_at TEXT NOT NULL, done_at TEXT, done_by TEXT, store TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS pins (name TEXT PRIMARY KEY, hash TEXT NOT NULL, salt TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS pin_fail (name TEXT PRIMARY KEY, count INTEGER NOT NULL, until TEXT)`,
  // 院の帳
  `CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, store TEXT NOT NULL, day TEXT NOT NULL, time TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS events_day ON events(day)`,
  `CREATE TABLE IF NOT EXISTS rules (id INTEGER PRIMARY KEY AUTOINCREMENT, store TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS rule_reads (rule_id INTEGER NOT NULL, name TEXT NOT NULL, read_at TEXT NOT NULL, PRIMARY KEY (rule_id, name))`,
  `CREATE TABLE IF NOT EXISTS practice_items (id INTEGER PRIMARY KEY AUTOINCREMENT, store TEXT NOT NULL, label TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS practice_marks (item_id INTEGER NOT NULL, name TEXT NOT NULL, level INTEGER NOT NULL, set_by TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (item_id, name))`,
  `CREATE TABLE IF NOT EXISTS thanks (id INTEGER PRIMARY KEY AUTOINCREMENT, store TEXT NOT NULL, from_name TEXT NOT NULL, to_name TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL)`,
  // スマホへのお知らせ
  `CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS notices (id INTEGER PRIMARY KEY AUTOINCREMENT, endpoint TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS notices_ep ON notices(endpoint, seen)`,
];
const STORE_COLS = { posts: ["store", "author"], handoffs: ["store"], visit_routes: ["store"], visit_status: ["store"],
  attendance: ["store"], checklist_items: ["store"], supplies: ["store"] };

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  // 前の版の入れ物には、店舗の列を足す
  for (const [t, cs] of Object.entries(STORE_COLS)) {
    const have = (await env.DB.prepare(`PRAGMA table_info(${t})`).all()).results.map((r) => r.name);
    for (const c of cs) {
      if (!have.includes(c)) {
        try { await env.DB.prepare(`ALTER TABLE ${t} ADD COLUMN ${c} TEXT NOT NULL DEFAULT ''`).run(); } catch (e) { /* 同時に足された */ }
      }
    }
  }
  schemaReady = true;
}
// 店舗が空の記録（前の版の記録）を、いちばん初めの店舗のものにする
let storesFilled = false;
async function fillStores(env) {
  if (storesFilled) return;
  const first = env.CFG.stores[0];
  await env.DB.batch([
    ...Object.keys(STORE_COLS).map((t) => env.DB.prepare(`UPDATE ${t} SET store = ? WHERE store = ''`).bind(first)),
    env.DB.prepare("UPDATE posts SET author = '院長' WHERE author = ''"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS posts_store ON posts(store, day)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS handoffs_store ON handoffs(store)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS supplies_store ON supplies(store)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS checklist_store ON checklist_items(store)"),
  ]);
  storesFilled = true;
}

// ---------- 設定 ----------
const getSetting = async (env, key) => {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  return r ? r.value : null;
};
const putSetting = (env, key, value) =>
  env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, value).run();

// wrangler.toml の [vars] から、はじめの設定を組み立てる
function configFromVars(env) {
  const stores = list(env.STORES).length ? list(env.STORES) : ["本院"];
  const staff = {};
  list(env.STAFF).forEach((e) => {
    const [n, st] = e.split("@").map((x) => (x || "").trim());
    if (!n) return;
    const ss = st ? st.split("+").map((x) => x.trim()).filter((x) => stores.includes(x)) : stores.slice();
    staff[n] = [...new Set([...(staff[n] || []), ...ss])];
  });
  const managers = list(env.MANAGERS).map((e) => e.split("@").map((x) => (x || "").trim()).join("@"));
  return {
    clinic: env.CLINIC_NAME && env.CLINIC_NAME !== "〇〇院" ? env.CLINIC_NAME : "",
    stores, staff, managers,
    tags: list(env.TAGS).slice(0, 4).length ? list(env.TAGS).slice(0, 4) : DEFAULT_TAGS,
    retainPost: parseInt(env.RETAIN_POST_DAYS || "0", 10) || 0,
    retainHandoff: parseInt(env.RETAIN_HANDOFF_DAYS || "0", 10) || 0,
  };
}
async function loadConfig(env) {
  if (isDemo(env)) return { ...DEMO_CONFIG, saved: true };
  const raw = await getSetting(env, "config");
  if (raw) {
    try {
      const c = JSON.parse(raw);
      return { ...c, templates: Array.isArray(c.templates) ? c.templates : DEFAULT_TEMPLATES, saved: true };
    } catch (e) { /* 壊れていたら [vars] を使う */ }
  }
  return { ...configFromVars(env), templates: DEFAULT_TEMPLATES, saved: false };
}
// 院名かスタッフが決まっていなければ「はじめの設定」が要る
const needsSetup = (cfg) => !cfg.clinic || !Object.keys(cfg.staff).length;

// セッションの署名に使う鍵（登録されていなければ、アプリが作って残す）
async function sessionSecret(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  let s = await getSetting(env, "session_secret");
  if (!s) {
    await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('session_secret', ?)").bind(randomStr(32)).run();
    s = await getSetting(env, "session_secret");
  }
  return s;
}

// ---------- 店舗と人 ----------
const storesOf = (env) => env.CFG.stores;
const staffMap = (env) => env.CFG.staff;
const staffNames = (env) => Object.keys(staffMap(env));
function staffOfStore(env, store) {
  const m = staffMap(env);
  return Object.keys(m).filter((n) => store === ALL || m[n].includes(store));
}
const managersOf = (env) => new Set(env.CFG.managers);
function myStores(env, me) {
  return me.role === "incho" ? storesOf(env) : staffMap(env)[me.name] || [];
}
function myManages(env, me) {
  if (me.role === "incho") return storesOf(env);
  const mg = managersOf(env);
  return myStores(env, me).filter((s) => mg.has(`${me.name}@${s}`));
}
const canSee = (env, me, store) => myStores(env, me).includes(store);
const canManage = (env, me, store) => (store === ALL ? me.role === "incho" : myManages(env, me).includes(store));

async function ensureChecklist(env, store) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM checklist_items WHERE store = ?").bind(store).first();
  if (r && r.n > 0) return;
  await env.DB.batch(DEFAULT_CHECKLIST.map(([ph, lb], i) =>
    env.DB.prepare("INSERT INTO checklist_items (phase, label, sort, store) VALUES (?, ?, ?, ?)").bind(ph, lb, (i % 4) + 1, store)));
}

async function ensurePractice(env, store) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM practice_items WHERE store = ?").bind(store).first();
  if (r && r.n > 0) return;
  await env.DB.batch(DEFAULT_PRACTICE.map((lb, i) =>
    env.DB.prepare("INSERT INTO practice_items (store, label, sort) VALUES (?, ?, ?)").bind(store, lb, i + 1)));
}

// ---------- 合言葉 ----------
// 院長の画面で変えた合言葉（まぜた形）があればそれを、なければ置くときに登録したものを使う
async function passInfo(env, role) {
  const key = role === "incho" ? "pass_incho" : "pass_staff";
  const raw = await getSetting(env, key);
  if (raw) { try { const p = JSON.parse(raw); return { kind: "db", ...p }; } catch (e) {} }
  const plain = role === "incho" ? env.INCHO_PASSCODE : env.STAFF_PASSCODE;
  return plain ? { kind: "env", plain } : null;
}
async function passMatches(env, role, input) {
  const p = await passInfo(env, role);
  if (!p) return false;
  if (p.kind === "env") return safeEqual(input, p.plain);
  return safeEqual(await hmac(`${env.SECRET}:pass`, `${role}:${p.salt}:${input}`), p.hash);
}
async function passVersion(env, role) {
  const p = await passInfo(env, role);
  return p ? (p.kind === "env" ? p.plain : p.hash) : "";
}

// ---------- 暗証番号 ----------
const pinHash = (env, name, salt, pin) => hmac(`${env.SECRET}:pin`, `${name}:${salt}:${pin}`);
const getPin = (env, name) => env.DB.prepare("SELECT hash, salt, updated_at FROM pins WHERE name = ?").bind(name).first();

// ---------- 入る・出る ----------
// 署名の鍵に合言葉をまぜるので、合言葉を変えると全員がいったん入り直しになる
async function signingKey(env, role) {
  return `${env.SECRET}:${role}:${isDemo(env) ? "demo" : await passVersion(env, role)}`;
}
async function makeSession(env, name, role, pinVer = "") {
  const body = b64urlText(JSON.stringify({ n: name, r: role, p: pinVer, e: Date.now() + SESSION_DAYS * 86400e3 }));
  return `${body}.${await hmac(await signingKey(env, role), body)}`;
}
async function readSession(request, env) {
  const m = (request.headers.get("cookie") || "").match(/(?:^|;\s*)sb=([^;]+)/);
  if (!m) return null;
  const [body, sig] = m[1].split(".");
  if (!body || !sig) return null;
  let data;
  try { data = JSON.parse(fromB64urlText(body)); } catch { return null; }
  if (!data || !["incho", "staff"].includes(data.r)) return null;
  if (!safeEqual(sig, await hmac(await signingKey(env, data.r), body))) return null;
  if (Date.now() > data.e) return null;
  if (data.r === "staff") {
    if (!staffNames(env).includes(data.n)) return null;
    if (!isDemo(env)) {
      const pin = await getPin(env, data.n);
      if (!pin || pin.updated_at !== data.p) return null;
    }
  }
  return { name: data.n, role: data.r };
}
const cookie = (value, maxAge) => `sb=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const loggedIn = async (env, name, role, pinVer = "") =>
  json({ ok: true, me: { name, role } }, 200, { "set-cookie": cookie(await makeSession(env, name, role, pinVer), SESSION_DAYS * 86400) });

async function login(request, env) {
  const { passcode = "", name = "", pin = "", pin2 = "", as = "" } = await request.json().catch(() => ({}));

  // お試し用：合言葉なしで役を選んで入る
  if (isDemo(env)) {
    if (as === "院長") return loggedIn(env, "院長", "incho");
    if (staffNames(env).includes(as)) return loggedIn(env, as, "staff", "demo");
    return fail("役を選んでください。");
  }

  if (!(await passInfo(env, "incho")) || !(await passInfo(env, "staff")))
    return fail("合言葉がまだ登録されていません。置き方の手順書の「合言葉がまだ登録されていません、と出たとき」を見てください。", 500);

  if (await passMatches(env, "incho", passcode)) return loggedIn(env, "院長", "incho");
  if (!(await passMatches(env, "staff", passcode))) {
    await sleep(800);
    return fail("合言葉がちがいます。", 401);
  }

  const map = staffMap(env), names = Object.keys(map);
  if (!names.length) return fail("院長がまだスタッフの名前を入れていません。院長に伝えてください。", 403);
  if (!name) {
    const multi = storesOf(env).length > 1;
    return json({ needName: true, names: names.map((n) => ({ name: n, stores: multi ? map[n].join("・") : "" })) });
  }
  if (!names.includes(name)) return fail("その名前は登録されていません。");

  const row = await getPin(env, name);
  if (!pin) return json(row ? { needPin: true, name } : { needSetPin: true, name });
  if (!/^\d{4}$/.test(pin)) return fail("暗証番号は数字4けたです。");

  if (!row) {
    if (pin !== pin2) return fail("二回の暗証番号がちがいます。もう一度入れてください。");
    const salt = randomStr(), at = nowIso();
    const r = await env.DB.prepare("INSERT OR IGNORE INTO pins (name, hash, salt, updated_at) VALUES (?, ?, ?, ?)")
      .bind(name, await pinHash(env, name, salt, pin), salt, at).run();
    if (!r.meta || !r.meta.changes) return fail("この名前の暗証番号はもう決まっています。暗証番号を入れてください。", 409);
    return loggedIn(env, name, "staff", at);
  }

  const f = await env.DB.prepare("SELECT count, until FROM pin_fail WHERE name = ?").bind(name).first();
  if (f && f.until && new Date(f.until) > new Date())
    return fail(`まちがいが続いたため、${PIN_LOCK_MIN}分ほど入れません。急ぐときは院長に暗証番号の再設定を頼んでください。`, 429);

  if (!safeEqual(await pinHash(env, name, row.salt, pin), row.hash)) {
    const count = (f && !f.until ? f.count : 0) + 1;
    const until = count >= PIN_MAX_FAIL ? new Date(Date.now() + PIN_LOCK_MIN * 60e3).toISOString() : null;
    await env.DB.prepare("INSERT OR REPLACE INTO pin_fail (name, count, until) VALUES (?, ?, ?)").bind(name, until ? 0 : count, until).run();
    await sleep(800);
    return fail(until ? `まちがいが続いたため、${PIN_LOCK_MIN}分ほど入れません。` : "暗証番号がちがいます。", 401);
  }
  await env.DB.prepare("DELETE FROM pin_fail WHERE name = ?").bind(name).run();
  return loggedIn(env, name, "staff", row.updated_at);
}

// ---------- スマホへのお知らせ（Web Push） ----------
// 送るのは「お知らせがある」という合図だけ。中身はスマホの側がこのアプリへ取りに来る。
// 画面に出すのは「誰から・何の種類か」だけで、書いた内容は出さない（スマホの鍵の画面に出るため）。
const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
function pushEndpointOk(ep) {
  try {
    const u = new URL(String(ep || ""));
    return u.protocol === "https:" && ep.length <= 1000 && PUSH_HOSTS.some((r) => r.test(u.hostname));
  } catch { return false; }
}
let vapidCache = null;
async function vapidKeys(env) {
  if (vapidCache) return vapidCache;
  let raw = await getSetting(env, "vapid");
  if (!raw) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const pub = b64url(await crypto.subtle.exportKey("raw", kp.publicKey));
    const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('vapid', ?)").bind(JSON.stringify({ pub, jwk })).run();
    raw = await getSetting(env, "vapid");
  }
  const v = JSON.parse(raw);
  v.key = await crypto.subtle.importKey("jwk", v.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return (vapidCache = v);
}
async function vapidAuth(env, endpoint) {
  const v = await vapidKeys(env);
  const head = b64urlText(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64urlText(JSON.stringify({
    aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.ORIGIN,
  }));
  const sig = b64url(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, v.key, enc.encode(`${head}.${claims}`)));
  return `vapid t=${head}.${claims}.${sig}, k=${v.pub}`;
}
async function notify(env, names, title, body) {
  if (isDemo(env) || !env.ORIGIN) return;
  const valid = new Set(["院長", ...staffNames(env)]);
  const targets = [...new Set(names)].filter((n) => valid.has(n));
  if (!targets.length) return;
  const subs = await q(env, `SELECT endpoint FROM push_subs WHERE name IN (${targets.map(() => "?").join(",")})`, ...targets);
  if (!subs.length) return;
  const at = nowIso();
  await env.DB.batch(subs.map((x) => env.DB.prepare("INSERT INTO notices (endpoint, title, body, created_at) VALUES (?, ?, ?, ?)")
    .bind(x.endpoint, String(title).slice(0, 60), String(body).slice(0, 120), at)));
  await Promise.all(subs.map(async (x) => {
    try {
      const r = await fetch(x.endpoint, {
        method: "POST",
        headers: { TTL: "86400", Urgency: "high", "Content-Length": "0", Authorization: await vapidAuth(env, x.endpoint) },
      });
      if (r.status === 404 || r.status === 410) {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(x.endpoint),
          env.DB.prepare("DELETE FROM notices WHERE endpoint = ?").bind(x.endpoint),
        ]);
      } else if (!r.ok) console.error("push", r.status, await r.text().catch(() => ""));
    } catch (e) { console.error("push", e); }
  }));
}
// 院長と、その店舗の店長
const bosses = (env, store) => ["院長", ...env.CFG.managers.filter((m) => m.endsWith("@" + store)).map((m) => m.split("@")[0])];

// ---------- お試し用：毎日元に戻す ----------
async function resetDemo(env, force = false) {
  const today = jstDay();
  if (!force && (await getSetting(env, "demo_day")) === today) return;
  const at = (h, m) => new Date(`${today}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+09:00`).toISOString();
  await env.DB.batch([
    ...["posts", "checks", "post_important", "replies", "handoffs", "visit_routes", "visit_status", "attendance",
      "checklist_done", "supplies", "pins", "pin_fail", "events", "rules", "rule_reads", "practice_marks", "thanks",
      "push_subs", "notices"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
    env.DB.prepare("DELETE FROM practice_items WHERE store NOT IN ('本院','北店') OR id > 16"),
    env.DB.prepare("UPDATE practice_items SET active = 1"),
    env.DB.prepare("DELETE FROM checklist_items WHERE id > 8 OR store NOT IN ('本院','北店')"),
    env.DB.prepare("UPDATE checklist_items SET active = 1"),
    env.DB.prepare("INSERT INTO posts (id, day, tag, text, created_at, store, author) VALUES (1, ?, '朝礼', '本日は16時で受付終了です。片付けは15時半から始めてください。', ?, ?, '院長')").bind(today, at(8, 40), ALL),
    env.DB.prepare("INSERT INTO post_important (post_id) VALUES (1)"),
    env.DB.prepare("INSERT INTO posts (id, day, tag, text, created_at, store, author) VALUES (2, ?, '予約の変更', '11時の方 → 明日の同じ時間へ変更になりました。', ?, '本院', '院長')").bind(today, at(9, 15)),
    env.DB.prepare("INSERT INTO posts (id, day, tag, text, created_at, store, author) VALUES (3, ?, '連絡', 'タオルの業者さんが13時ごろ来ます。受け取りをお願いします。', ?, '北店', '松井')").bind(today, at(9, 30)),
    env.DB.prepare("INSERT INTO checks (post_id, name, created_at) VALUES (1, '北川', ?), (2, '北川', ?)").bind(at(8, 55), at(9, 20)),
    env.DB.prepare("INSERT INTO replies (post_id, author, text, created_at) VALUES (3, '小野', '受け取ります', ?)").bind(at(9, 40)),
    env.DB.prepare("INSERT INTO attendance (day, name, status, note, set_by, updated_at, store) VALUES (?, '北川', '出勤', '', '北川', ?, '本院'), (?, '小野', '遅れます', '10時ごろ着きます', '小野', ?, '北店'), (?, '院長', '外出', '14時〜16時', '院長', ?, '本院')")
      .bind(today, at(8, 50), today, at(8, 30), today, at(8, 35)),
    env.DB.prepare("INSERT INTO handoffs (author, text, created_at, store) VALUES ('北川', 'ベッド2の高さ調整のレバーが固いです。', ?, '本院')").bind(at(8, 58)),
    env.DB.prepare("INSERT INTO supplies (item, note, author, created_at, store) VALUES ('フェイスタオル', 'あと3枚', '北川', ?, '本院')").bind(at(9, 0)),
    env.DB.prepare("INSERT INTO visit_routes (day, name, stops, store) VALUES (?, '松井', ?, '北店')").bind(today, JSON.stringify(["10:00 出発", "10:30 1件目", "11:40 2件目", "12:30 帰院予定"])),
    env.DB.prepare("INSERT INTO visit_status (day, name, label, created_at, store) VALUES (?, '松井', '出発しました', ?, '北店')").bind(today, at(10, 0)),
    env.DB.prepare("INSERT INTO events (store, day, time, text, author, created_at) VALUES (?, ?, '18:30', '院内の勉強会（タオルワーク）', '院長', ?), ('本院', ?, '', 'ベッドの点検の業者さんが来ます', '院長', ?), (?, ?, '', '年末の大掃除', '院長', ?)")
      .bind(ALL, today, at(8, 0), jstDay(2), at(8, 0), ALL, jstDay(9), at(8, 0)),
    env.DB.prepare("INSERT INTO rules (id, store, title, body, updated_at, updated_by) VALUES (1, ?, '休むときの連絡', '前の日までに、このアプリの「今日いる人」で「休みます」を押し、院長にも電話で伝えます。\n当日の朝に休むときは、8時半までに電話します。', ?, '院長'), (2, '本院', 'タオルの洗い方', '使ったタオルは、閉院後に洗濯機へ。\n乾いたら、受付の奥の棚へ（色ごとに分けます）。', ?, '院長')")
      .bind(ALL, at(8, 0), at(8, 0)),
    env.DB.prepare("INSERT INTO rule_reads (rule_id, name, read_at) VALUES (1, '北川', ?)").bind(at(8, 10)),
    env.DB.prepare("INSERT INTO thanks (store, from_name, to_name, text, created_at) VALUES ('本院', '小野', '北川', '朝のタオルの準備、ありがとうございました！', ?), ('北店', '松井', '小野', '急な予約の変更に対応してくれて助かりました', ?)")
      .bind(at(9, 5), at(9, 50)),
    env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('demo_day', ?)").bind(today),
  ]);
  for (const s of DEMO_CONFIG.stores) { await ensureChecklist(env, s); await ensurePractice(env, s); }
  const pi = await q(env, "SELECT id FROM practice_items WHERE store = '本院' ORDER BY sort LIMIT 3");
  if (pi.length === 3) {
    await env.DB.batch([
      env.DB.prepare("INSERT OR REPLACE INTO practice_marks (item_id, name, level, set_by, updated_at) VALUES (?, '北川', 2, '院長', ?), (?, '北川', 2, '院長', ?), (?, '北川', 1, '北川', ?)")
        .bind(pi[0].id, at(8, 0), pi[1].id, at(8, 0), pi[2].id, at(8, 0)),
    ]);
  }
}

// ---------- 読む ----------
const q = (env, sql, ...b) => env.DB.prepare(sql).bind(...b).all().then((r) => r.results);

function recipients(env, post, store) {
  const base = post.store === ALL ? staffOfStore(env, store) : staffOfStore(env, post.store);
  return base.filter((n) => n !== post.author);
}

async function state(env, me, store) {
  const today = jstDay();
  const pastFrom = jstDay(-14);
  const weekAgo = new Date(Date.now() - 7 * 86400e3).toISOString();
  await ensureChecklist(env, store);
  await ensurePractice(env, store);
  const people = staffOfStore(env, store);
  const manage = canManage(env, me, store);
  const monthAgo = new Date(Date.now() - 30 * 86400e3).toISOString();

  const [posts, checks, imp, reps, handoffs, routes, statuses, att, items, done, supplies, pins] = await Promise.all([
    q(env, "SELECT id, day, tag, text, created_at, store, author FROM posts WHERE day >= ? AND (store = ? OR store = ?) ORDER BY created_at ASC", pastFrom, store, ALL),
    q(env, "SELECT c.post_id, c.name FROM checks c JOIN posts p ON p.id = c.post_id WHERE p.day >= ? AND (p.store = ? OR p.store = ?)", pastFrom, store, ALL),
    q(env, "SELECT i.post_id FROM post_important i JOIN posts p ON p.id = i.post_id WHERE p.day >= ?", pastFrom),
    q(env, "SELECT r.id, r.post_id, r.author, r.text, r.created_at FROM replies r JOIN posts p ON p.id = r.post_id WHERE p.day >= ? AND (p.store = ? OR p.store = ?) ORDER BY r.created_at ASC", pastFrom, store, ALL),
    q(env, "SELECT id, author, text, created_at, done_at, done_by FROM handoffs WHERE store = ? AND (done_at IS NULL OR done_at >= ?) ORDER BY created_at DESC LIMIT 100", store, weekAgo),
    q(env, "SELECT name, stops FROM visit_routes WHERE day = ? AND store = ?", today, store),
    q(env, "SELECT name, label, created_at FROM visit_status WHERE day = ? AND store = ? ORDER BY created_at ASC", today, store),
    q(env, "SELECT name, status, note, set_by, updated_at, store FROM attendance WHERE day = ?", today),
    q(env, "SELECT id, phase, label FROM checklist_items WHERE active = 1 AND store = ? ORDER BY phase, sort, id", store),
    q(env, "SELECT d.item_id, d.name, d.done_at FROM checklist_done d JOIN checklist_items i ON i.id = d.item_id WHERE d.day = ? AND i.store = ?", today, store),
    q(env, "SELECT id, item, note, author, created_at, done_at, done_by FROM supplies WHERE store = ? AND (done_at IS NULL OR done_at >= ?) ORDER BY created_at DESC LIMIT 100", store, weekAgo),
    me.role === "incho" ? q(env, "SELECT name FROM pins") : Promise.resolve([]),
  ]);
  const [events, rules, reads, pItems, pMarks, thanks] = await Promise.all([
    q(env, "SELECT id, store, day, time, text, author FROM events WHERE day >= ? AND day <= ? AND (store = ? OR store = ?) ORDER BY day, time, id", today, jstDay(60), store, ALL),
    q(env, "SELECT id, store, title, body, updated_at, updated_by FROM rules WHERE active = 1 AND (store = ? OR store = ?) ORDER BY store = ? DESC, id", store, ALL, ALL),
    q(env, "SELECT d.rule_id, d.name, d.read_at FROM rule_reads d JOIN rules r ON r.id = d.rule_id WHERE r.active = 1 AND d.read_at >= r.updated_at AND (r.store = ? OR r.store = ?)", store, ALL),
    q(env, "SELECT id, label FROM practice_items WHERE active = 1 AND store = ? ORDER BY sort, id", store),
    q(env, "SELECT m.item_id, m.name, m.level, m.set_by, m.updated_at FROM practice_marks m JOIN practice_items i ON i.id = m.item_id WHERE i.store = ? AND i.active = 1", store),
    q(env, "SELECT id, from_name, to_name, text, created_at FROM thanks WHERE store = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 60", store, monthAgo),
  ]);
  const readBy = {};
  reads.forEach((r) => (readBy[r.rule_id] ||= []).push(r.name));
  const marks = {};
  pMarks.filter((x) => manage || x.name === me.name).forEach((x) => ((marks[x.name] ||= {})[x.item_id] = { level: x.level, by: x.set_by, at: x.updated_at }));

  const byPost = {}, repBy = {};
  checks.forEach((c) => (byPost[c.post_id] ||= []).push(c.name));
  reps.forEach((r) => (repBy[r.post_id] ||= []).push(r));
  const impSet = new Set(imp.map((i) => i.post_id));
  const full = posts.map((p) => ({
    ...p, checked: byPost[p.id] || [], important: impSet.has(p.id), replies: repBy[p.id] || [],
    recipients: recipients(env, p, store),
  }));

  const visits = {};
  routes.forEach((r) => (visits[r.name] = { stops: JSON.parse(r.stops), log: [] }));
  statuses.forEach((s) => (visits[s.name] ||= { stops: [], log: [] }).log.push({ label: s.label, at: s.created_at }));

  const attendance = {};
  att.filter((a) => a.name === "院長" || people.includes(a.name)).forEach((a) => (attendance[a.name] = a));
  const doneMap = {};
  done.forEach((d) => (doneMap[d.item_id] = d));

  const map = staffMap(env);
  const cfg = env.CFG;
  return {
    me: { ...me, stores: myStores(env, me), manages: myManages(env, me) },
    demo: isDemo(env),
    store, stores: storesOf(env), today, staff: people,
    allStaff: me.role === "incho" ? Object.keys(map).map((n) => ({ name: n, stores: map[n] })) : [],
    config: me.role === "incho"
      ? { clinic: cfg.clinic, stores: cfg.stores, staff: cfg.staff, managers: cfg.managers, tags: cfg.tags, templates: cfg.templates,
          retainPost: cfg.retainPost, retainHandoff: cfg.retainHandoff, saved: cfg.saved, needsSetup: needsSetup(cfg) }
      : null,
    clinic: cfg.clinic,
    tags: cfg.tags,
    templates: cfg.templates,
    canManage: manage,
    events,
    rules: rules.map((r) => ({ ...r, readBy: readBy[r.id] || [] })),
    practice: { items: pItems, marks, people: manage ? people : people.includes(me.name) ? [me.name] : [] },
    thanks,
    visitLabels: VISIT_LABELS, staffStatus: STAFF_STATUS, inchoStatus: INCHO_STATUS, phases: PHASES,
    posts: full.filter((p) => p.day === today),
    past: full.filter((p) => p.day !== today).reverse(),
    handoffs, visits, attendance,
    checklist: { items, done: doneMap },
    supplies,
    pinsSet: pins.map((p) => p.name),
  };
}

async function overview(env) {
  const today = jstDay(), stores = storesOf(env);
  for (const s of stores) await ensureChecklist(env, s);
  const [posts, checks, att, items, done, sup, hands, vstat] = await Promise.all([
    q(env, "SELECT id, store, author FROM posts WHERE day = ?", today),
    q(env, "SELECT c.post_id, c.name FROM checks c JOIN posts p ON p.id = c.post_id WHERE p.day = ?", today),
    q(env, "SELECT name, status, store FROM attendance WHERE day = ?", today),
    q(env, "SELECT id, store FROM checklist_items WHERE active = 1"),
    q(env, "SELECT item_id FROM checklist_done WHERE day = ?", today),
    q(env, "SELECT store FROM supplies WHERE done_at IS NULL"),
    q(env, "SELECT store FROM handoffs WHERE done_at IS NULL"),
    q(env, "SELECT name, label, store FROM visit_status WHERE day = ? ORDER BY created_at ASC", today),
  ]);
  const checked = {};
  checks.forEach((c) => (checked[c.post_id] ||= new Set()).add(c.name));
  const doneSet = new Set(done.map((d) => d.item_id));
  return stores.map((s) => {
    const people = staffOfStore(env, s);
    const sp = posts.filter((p) => p.store === s || p.store === ALL);
    const unread = sp.filter((p) => recipients(env, p, s).some((n) => !(checked[p.id] && checked[p.id].has(n)))).length;
    const a = att.filter((x) => people.includes(x.name));
    const lastVisit = {};
    vstat.filter((v) => v.store === s).forEach((v) => (lastVisit[v.name] = v.label));
    return {
      store: s, people: people.length,
      in: a.filter((x) => x.status === "出勤" && (x.store === s || !x.store)).length,
      late: a.filter((x) => x.status === "遅れます" && (x.store === s || !x.store)).length,
      off: a.filter((x) => x.status === "休みます").length,
      noword: people.filter((n) => !att.find((x) => x.name === n)).length,
      posts: sp.length, unread,
      checkLeft: items.filter((i) => i.store === s && !doneSet.has(i.id)).length,
      supplies: sup.filter((x) => x.store === s).length,
      handoffs: hands.filter((x) => x.store === s).length,
      visitLate: Object.values(lastVisit).filter((l) => l === "遅れます").length,
    };
  });
}

// ---------- 控え（院長だけ） ----------
function jstTime(iso) {
  if (!iso) return "";
  const d = new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)}`;
}
function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
async function exportCsv(env, only) {
  const all = (sql) => env.DB.prepare(sql).all().then((r) => r.results);
  const rows = [["店舗", "種類", "日時", "書いた人", "内容", "状態"]];
  const [events, rules, pItems, pMarks, thanks] = await Promise.all([
    all("SELECT * FROM events ORDER BY day, time"), all("SELECT * FROM rules WHERE active = 1 ORDER BY id"),
    all("SELECT * FROM practice_items"), all("SELECT * FROM practice_marks ORDER BY name"), all("SELECT * FROM thanks ORDER BY created_at"),
  ]);
  const [posts, checks, imp, reps, hands, routes, vstat, att, items, done, sup] = await Promise.all([
    all("SELECT * FROM posts ORDER BY created_at"), all("SELECT * FROM checks"), all("SELECT * FROM post_important"),
    all("SELECT * FROM replies ORDER BY created_at"), all("SELECT * FROM handoffs ORDER BY created_at"),
    all("SELECT * FROM visit_routes ORDER BY day"), all("SELECT * FROM visit_status ORDER BY created_at"),
    all("SELECT * FROM attendance ORDER BY day, name"), all("SELECT * FROM checklist_items"),
    all("SELECT * FROM checklist_done ORDER BY day, done_at"), all("SELECT * FROM supplies ORDER BY created_at"),
  ]);
  const st = (s) => (s === ALL ? "全店舗" : s);
  const keep = (s) => !only || s === only || s === ALL;
  const impSet = new Set(imp.map((i) => i.post_id));
  const item = Object.fromEntries(items.map((i) => [i.id, i]));
  posts.filter((p) => keep(p.store)).forEach((p) => {
    const who = checks.filter((c) => c.post_id === p.id).map((c) => c.name).join("・");
    rows.push([st(p.store), `ボード（${p.tag}）${impSet.has(p.id) ? "【大事】" : ""}`, jstTime(p.created_at), p.author || "院長", p.text, who ? `確認：${who}` : "確認なし"]);
    reps.filter((r) => r.post_id === p.id).forEach((r) => rows.push([st(p.store), "　返信", jstTime(r.created_at), r.author, r.text, ""]));
  });
  hands.filter((h) => keep(h.store)).forEach((h) => rows.push([h.store, "申し送り", jstTime(h.created_at), h.author, h.text, h.done_at ? `済み（${h.done_by}・${jstTime(h.done_at)}）` : "まだ"]));
  routes.filter((r) => keep(r.store)).forEach((r) => rows.push([r.store, "訪問の流れ", r.day, r.name, JSON.parse(r.stops).join(" → "), ""]));
  vstat.filter((s) => keep(s.store)).forEach((s) => rows.push([s.store, "訪問の動き", jstTime(s.created_at), s.name, s.label, ""]));
  att.filter((a) => keep(a.store)).forEach((a) => rows.push([a.store, "今日いる人", a.day, a.name, a.status + (a.note ? `（${a.note}）` : ""), `${a.set_by}が入力・${jstTime(a.updated_at)}`]));
  done.forEach((d) => {
    const i = item[d.item_id];
    if (i && keep(i.store)) rows.push([i.store, "点検", jstTime(d.done_at), d.name, `${i.phase}：${i.label}`, "済み"]);
  });
  sup.filter((s) => keep(s.store)).forEach((s) => rows.push([s.store, "備品", jstTime(s.created_at), s.author, s.item + (s.note ? `（${s.note}）` : ""), s.done_at ? `済み（${s.done_by}・${jstTime(s.done_at)}）` : "まだ"]));
  events.filter((x) => keep(x.store)).forEach((x) => rows.push([st(x.store), "予定", `${x.day} ${x.time}`.trim(), x.author, x.text, ""]));
  rules.filter((x) => keep(x.store)).forEach((x) => rows.push([st(x.store), `決まり（${x.title}）`, jstTime(x.updated_at), x.updated_by, x.body, ""]));
  const pItem = Object.fromEntries(pItems.map((i) => [i.id, i]));
  pMarks.forEach((x) => {
    const i = pItem[x.item_id];
    if (i && keep(i.store)) rows.push([i.store, "練習", jstTime(x.updated_at), x.name, i.label, x.level >= 2 ? `できた（${x.set_by}が確かめた）` : "練習した"]);
  });
  thanks.filter((x) => keep(x.store)).forEach((x) => rows.push([x.store, "ありがとう", jstTime(x.created_at), x.from_name, `${x.to_name === "院長" ? "院長" : x.to_name + "さん"}へ：${x.text}`, ""]));
  const body = "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  const fname = `renraku-hikae${only ? "-" + encodeURIComponent(only) : ""}-${jstDay()}.csv`;
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${fname}"; filename*=UTF-8''${fname}`,
      "cache-control": "no-store",
    },
  });
}

// ---------- 決めた期間で消す ----------
async function cleanup(env) {
  const postDays = env.CFG.retainPost || 0;
  const handDays = env.CFG.retainHandoff || 0;
  if (postDays > 0) {
    const before = jstDay(-postDays);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM checks WHERE post_id IN (SELECT id FROM posts WHERE day < ?)").bind(before),
      env.DB.prepare("DELETE FROM replies WHERE post_id IN (SELECT id FROM posts WHERE day < ?)").bind(before),
      env.DB.prepare("DELETE FROM post_important WHERE post_id IN (SELECT id FROM posts WHERE day < ?)").bind(before),
      env.DB.prepare("DELETE FROM posts WHERE day < ?").bind(before),
      env.DB.prepare("DELETE FROM visit_routes WHERE day < ?").bind(before),
      env.DB.prepare("DELETE FROM visit_status WHERE day < ?").bind(before),
      env.DB.prepare("DELETE FROM attendance WHERE day < ?").bind(before),
      env.DB.prepare("DELETE FROM checklist_done WHERE day < ?").bind(before),
      env.DB.prepare("DELETE FROM events WHERE day < ?").bind(before),
      env.DB.prepare("DELETE FROM thanks WHERE created_at < ?").bind(new Date(Date.now() - postDays * 86400e3).toISOString()),
    ]);
  }
  if (handDays > 0) {
    const before = new Date(Date.now() - handDays * 86400e3).toISOString();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM handoffs WHERE done_at IS NOT NULL AND done_at < ?").bind(before),
      env.DB.prepare("DELETE FROM supplies WHERE done_at IS NOT NULL AND done_at < ?").bind(before),
    ]);
  }
}

// 日に一度、その日はじめて開かれたときに、決めた期間を過ぎた記録を消す
// （時刻の予約を使わないので、Cloudflareの無料プランの上限にかからない）
async function dailyCleanup(env) {
  const today = jstDay();
  if ((await getSetting(env, "cleanup_day")) === today) return;
  await putSetting(env, "cleanup_day", today);
  // スマホへのお知らせの中身は、3日で消す
  await env.DB.prepare("DELETE FROM notices WHERE created_at < ?").bind(new Date(Date.now() - 3 * 86400e3).toISOString()).run();
  if (env.CFG.retainPost > 0 || env.CFG.retainHandoff > 0) await cleanup(env);
}

// ---------- 設定を保存する（院長だけ） ----------
function validateConfig(b) {
  const clinic = cleanText(b.clinic, 40);
  if (!clinic) return { error: "院の名前を入れてください。" };
  const stores = [...new Set((Array.isArray(b.stores) ? b.stores : list(b.stores)).map((s) => String(s).trim().slice(0, 20)).filter(Boolean))];
  if (!stores.length) return { error: "店舗の名前を一つ以上入れてください。" };
  if (stores.length > 20) return { error: "店舗は20までにしてください。" };
  if (stores.includes(ALL)) return { error: "店舗の名前に「*」は使えません。" };
  const staff = {};
  for (const s of stores) {
    const names = (Array.isArray(b.staffBy?.[s]) ? b.staffBy[s] : list(b.staffBy?.[s])).map((n) => String(n).trim().slice(0, 20)).filter(Boolean);
    for (const n of names) {
      if (n === "院長") return { error: "スタッフの名前に「院長」は使えません。" };
      if (/[@+,]/.test(n)) return { error: `名前「${n}」に使えない文字（@ + ,）があります。` };
      (staff[n] ||= []).includes(s) || staff[n].push(s);
    }
  }
  if (!Object.keys(staff).length) return { error: "スタッフを一人以上入れてください。" };
  if (Object.keys(staff).length > 100) return { error: "スタッフは100人までにしてください。" };
  const managers = [];
  for (const s of stores) {
    const m = String(b.mgrBy?.[s] || "").trim();
    if (!m) continue;
    if (!staff[m] || !staff[m].includes(s)) return { error: `「${s}」の店長は、${s}のスタッフから選んでください。` };
    managers.push(`${m}@${s}`);
  }
  const tags = [...new Set((Array.isArray(b.tags) ? b.tags : list(b.tags)).map((t) => String(t).trim().slice(0, 12)).filter(Boolean))];
  if (!tags.length || tags.length > 4) return { error: "連絡の種類は一つから四つまでにしてください。" };
  const templates = [...new Set((Array.isArray(b.templates) ? b.templates : String(b.templates || "").split(/\r?\n/))
    .map((t) => String(t).trim().slice(0, 80)).filter(Boolean))];
  if (templates.length > 10) return { error: "定型文は10までにしてください。" };
  const num = (v) => Math.max(0, Math.min(3650, parseInt(v, 10) || 0));
  return { config: { clinic, stores, staff, managers, tags, templates, retainPost: num(b.retainPost), retainHandoff: num(b.retainHandoff) } };
}

// ---------- 探す ----------
async function search(env, me, word) {
  const stores = myStores(env, me);
  if (!stores.length) return [];
  const ph = stores.map(() => "?").join(",");
  const like = `%${word.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
  const L = "LIKE ? ESCAPE '\\'";
  const S = (col = "store") => `(${col} IN (${ph}) OR ${col} = ?)`;
  const sv = [...stores, ALL];
  const [posts, reps, hands, rules, events, thanks] = await Promise.all([
    q(env, `SELECT store, created_at AS at, author AS who, tag, text FROM posts WHERE ${S()} AND text ${L} ORDER BY created_at DESC LIMIT 40`, ...sv, like),
    q(env, `SELECT p.store, r.created_at AS at, r.author AS who, r.text, p.text AS parent FROM replies r JOIN posts p ON p.id = r.post_id WHERE ${S("p.store")} AND r.text ${L} ORDER BY r.created_at DESC LIMIT 20`, ...sv, like),
    q(env, `SELECT store, created_at AS at, author AS who, text FROM handoffs WHERE ${S()} AND text ${L} ORDER BY created_at DESC LIMIT 20`, ...sv, like),
    q(env, `SELECT store, updated_at AS at, updated_by AS who, title, body AS text FROM rules WHERE active = 1 AND ${S()} AND (title ${L} OR body ${L}) LIMIT 20`, ...sv, like, like),
    q(env, `SELECT store, day AS at, author AS who, time, text FROM events WHERE ${S()} AND text ${L} ORDER BY day DESC LIMIT 20`, ...sv, like),
    q(env, `SELECT store, created_at AS at, from_name AS who, to_name, text FROM thanks WHERE ${S()} AND text ${L} ORDER BY created_at DESC LIMIT 20`, ...sv, like),
  ]);
  const cut = (t) => String(t).slice(0, 200);
  return [
    ...posts.map((x) => ({ kind: `ボード（${x.tag}）`, tab: "board", store: x.store, at: x.at, who: x.who, text: cut(x.text) })),
    ...reps.map((x) => ({ kind: "返信", tab: "board", store: x.store, at: x.at, who: x.who, text: cut(x.text), parent: cut(x.parent).slice(0, 40) })),
    ...hands.map((x) => ({ kind: "申し送り", tab: "handoff", store: x.store, at: x.at, who: x.who, text: cut(x.text) })),
    ...rules.map((x) => ({ kind: `決まり（${x.title}）`, tab: "rules", store: x.store, at: x.at, who: x.who, text: cut(x.text) })),
    ...events.map((x) => ({ kind: `予定（${x.at}${x.time ? " " + x.time : ""}）`, tab: "events", store: x.store, at: x.at, who: x.who, text: cut(x.text) })),
    ...thanks.map((x) => ({ kind: `ありがとう（${x.to_name}さんへ）`, tab: "thanks", store: x.store, at: x.at, who: x.who, text: cut(x.text) })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 60);
}

// ---------- 書く ----------
async function api(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // 入る前でも見られる：お試し用かどうか、院の名前
  if (path === "/api/hello" && method === "GET") {
    return json({ demo: isDemo(env), clinic: env.CFG.clinic,
      people: isDemo(env) ? [{ name: "院長", role: "院長（全店舗）" }, ...staffNames(env).map((n) => ({
        name: n, role: `${staffMap(env)[n].join("・")}${env.CFG.managers.some((m) => m.startsWith(n + "@")) ? "・店長" : ""}` }))] : [] });
  }
  if (path === "/api/login" && method === "POST") return login(request, env);
  if (path === "/api/logout" && method === "POST") return json({ ok: true }, 200, { "set-cookie": cookie("", 0) });

  // スマホの側が、届いた合図の中身を取りに来る（入っていなくても、登録された印で見分ける）
  if (path === "/api/notices/latest" && method === "POST") {
    const { endpoint = "" } = await request.json().catch(() => ({}));
    const fallback = { title: env.CFG.clinic || "院の連絡帳", body: "新しいお知らせがあります。開いて確かめてください。" };
    if (!endpoint) return json(fallback);
    const n = await env.DB.prepare("SELECT id, title, body FROM notices WHERE endpoint = ? AND seen = 0 ORDER BY id LIMIT 1").bind(String(endpoint)).first();
    if (!n) return json(fallback);
    await env.DB.prepare("UPDATE notices SET seen = 1 WHERE id = ?").bind(n.id).run();
    return json({ title: n.title, body: n.body });
  }

  const me = await readSession(request, env);
  if (!me) return fail("入り直してください。", 401);
  const incho = me.role === "incho";

  if (method !== "GET") {
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return fail("受け付けられません。", 403);
  }

  if (method === "GET") {
    if (path === "/api/state") {
      const mine = myStores(env, me);
      if (!mine.length) return fail("所属する店舗が決まっていません。院長に伝えてください。", 403);
      const store = url.searchParams.get("store");
      return json(await state(env, me, mine.includes(store) ? store : mine[0]));
    }
    if (path === "/api/overview") {
      if (!incho) return fail("全店まとめは院長だけが見られます。", 403);
      return json({ stores: await overview(env) });
    }
    if (path === "/api/search") {
      const word = String(url.searchParams.get("q") || "").trim().slice(0, 40);
      if (!word) return fail("探す言葉を入れてください。");
      return json({ results: await search(env, me, word) });
    }
    if (path === "/api/push/key") {
      if (isDemo(env)) return json({ enabled: false });
      return json({ enabled: true, key: (await vapidKeys(env)).pub });
    }
    if (path === "/api/export") {
      if (!incho) return fail("控えを取れるのは院長だけです。", 403);
      const only = url.searchParams.get("store");
      return exportCsv(env, only && storesOf(env).includes(only) ? only : null);
    }
    return fail("見つかりません。", 404);
  }

  const body = await request.json().catch(() => ({}));
  const run = (sql, ...b) => env.DB.prepare(sql).bind(...b).run();
  const ok = () => json({ ok: true });
  const store = body.store;
  const needStore = () => (canSee(env, me, store) ? null : fail("この店舗は見られません。", 403));
  const storeOfRow = async (table, id) => {
    const r = await env.DB.prepare(`SELECT store FROM ${table} WHERE id = ?`).bind(id).first();
    return r ? r.store : null;
  };
  let m, e;
  // お知らせを送る（返事を待たずに、裏で送る）
  const tell = (names, title, text) => env.later(notify(env, names.filter((n) => n !== me.name), title, text).catch((x) => console.error(x)));
  const from = me.name === "院長" ? "院長" : `${me.name}さん`;
  const where = (st) => (storesOf(env).length > 1 ? (st === ALL ? "（全店舗）" : `（${st}）`) : "");

  // --- スマホへのお知らせ ---
  if (path === "/api/push/subscribe" || path === "/api/push/unsubscribe" || path === "/api/push/test") {
    if (isDemo(env)) return fail("お試し用では、スマホへのお知らせは使えません。自院のアドレスで置くと使えます。", 403);
    if (path === "/api/push/test") {
      env.later(notify(env, [me.name], env.CFG.clinic || "院の連絡帳", "お知らせの試しです。これが見えていれば届いています。").catch((x) => console.error(x)));
      return ok();
    }
    if (!pushEndpointOk(body.endpoint)) return fail("このスマホでは、お知らせを受け取れないようです。");
    if (path === "/api/push/unsubscribe") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(body.endpoint),
        env.DB.prepare("DELETE FROM notices WHERE endpoint = ?").bind(body.endpoint),
      ]);
      return ok();
    }
    await run("INSERT OR REPLACE INTO push_subs (endpoint, name, created_at) VALUES (?, ?, ?)", body.endpoint, me.name, nowIso());
    return ok();
  }

  // --- 設定（院長だけ） ---
  if (path === "/api/settings") {
    if (!incho) return fail("設定を変えられるのは院長だけです。", 403);
    if (isDemo(env)) return fail("お試し用では、設定は保存できません。自院のアドレスで置くと使えます。", 403);
    const v = validateConfig(body);
    if (v.error) return fail(v.error);
    await putSetting(env, "config", JSON.stringify(v.config));
    return ok();
  }
  if (path === "/api/passcodes") {
    if (!incho) return fail("合言葉を変えられるのは院長だけです。", 403);
    if (isDemo(env)) return fail("お試し用では、合言葉は変えられません。", 403);
    const changes = [];
    for (const role of ["incho", "staff"]) {
      const v = String(body[role] || "").trim();
      if (!v) continue;
      if (v.length < 6) return fail("合言葉は6文字以上にしてください。");
      changes.push([role, v]);
    }
    if (!changes.length) return fail("新しい合言葉を入れてください。");
    if (changes.length === 2 && changes[0][1] === changes[1][1]) return fail("院長とスタッフの合言葉は、別のものにしてください。");
    for (const [role, v] of changes) {
      if (changes.length === 1 && (await passMatches(env, role === "incho" ? "staff" : "incho", v))) return fail("院長とスタッフの合言葉は、別のものにしてください。");
      const salt = randomStr();
      await putSetting(env, role === "incho" ? "pass_incho" : "pass_staff",
        JSON.stringify({ salt, hash: await hmac(`${env.SECRET}:pass`, `${role}:${salt}:${v}`) }));
    }
    // 院長の合言葉を変えたら、院長も入り直しになるので、入り直した形で返す
    if (changes.some(([r]) => r === "incho")) return loggedIn(env, "院長", "incho");
    return ok();
  }

  // --- 今日のボード ---
  if (path === "/api/posts") {
    const dest = body.dest === ALL ? ALL : store;
    if (dest !== ALL && (e = needStore())) return e;
    if (!canManage(env, me, dest)) return fail(dest === ALL ? "全店舗に出せるのは院長だけです。" : "この店舗のボードに書けるのは、院長と店長です。", 403);
    const text = cleanText(body.text);
    if (!text) return fail("内容を書いてください。");
    if (!env.CFG.tags.includes(body.tag)) return fail("種類を選んでください。");
    const r = await run("INSERT INTO posts (day, tag, text, created_at, store, author) VALUES (?, ?, ?, ?, ?, ?)", jstDay(), body.tag, text, nowIso(), dest, me.name);
    if (body.important && r.meta && r.meta.last_row_id) await run("INSERT OR IGNORE INTO post_important (post_id) VALUES (?)", r.meta.last_row_id);
    tell(staffOfStore(env, dest), `${body.important ? "【大事】" : ""}新しい連絡${where(dest)}`, `${from}から「${body.tag}」の連絡があります。開いて確認してください。`);
    return ok();
  }
  if ((m = path.match(/^\/api\/posts\/(\d+)\/(check|important|reply)$/))) {
    const id = Number(m[1]);
    const p = await env.DB.prepare("SELECT store, author FROM posts WHERE id = ?").bind(id).first();
    if (!p) return fail("その連絡は見つかりません。", 404);
    const visible = p.store === ALL ? myStores(env, me).length > 0 : canSee(env, me, p.store);
    if (!visible) return fail("この店舗は見られません。", 403);
    if (m[2] === "check") {
      if (incho) return fail("確認を押すのはスタッフです。", 403);
      if (p.author === me.name) return fail("自分で書いた連絡です。", 400);
      await run("INSERT OR IGNORE INTO checks (post_id, name, created_at) VALUES (?, ?, ?)", id, me.name, nowIso());
      return ok();
    }
    if (m[2] === "important") {
      if (!canManage(env, me, p.store)) return fail("大事の印を付けられるのは、院長と店長です。", 403);
      if (body.on) await run("INSERT OR IGNORE INTO post_important (post_id) VALUES (?)", id);
      else await run("DELETE FROM post_important WHERE post_id = ?", id);
      return ok();
    }
    const text = cleanText(body.text, MAX_SHORT);
    if (!text) return fail("返信を書いてください。");
    await run("INSERT INTO replies (post_id, author, text, created_at) VALUES (?, ?, ?, ?)", id, me.name, text, nowIso());
    tell([p.author || "院長"], "返信がありました", `${from}が、あなたの連絡に返信しました。`);
    return ok();
  }

  // --- 今日いる人 ---
  if (path === "/api/attendance") {
    if ((e = needStore())) return e;
    const name = body.name || me.name;
    if (name !== "院長" && !staffOfStore(env, store).includes(name)) return fail("名前を選んでください。");
    if (name === "院長" && !incho) return fail("院長の分は院長だけが入れられます。", 403);
    if (name !== me.name && !canManage(env, me, store)) return fail("自分の分だけ入れられます。", 403);
    if (body.status === "") {
      await run("DELETE FROM attendance WHERE day = ? AND name = ?", jstDay(), name);
      return ok();
    }
    const allowed = name === "院長" ? INCHO_STATUS : STAFF_STATUS;
    if (!allowed.includes(body.status)) return fail("選び方が正しくありません。");
    await run("INSERT OR REPLACE INTO attendance (day, name, status, note, set_by, updated_at, store) VALUES (?, ?, ?, ?, ?, ?, ?)",
      jstDay(), name, body.status, cleanText(body.note, 60) || "", me.name, nowIso(), store);
    if (name === me.name && (body.status === "遅れます" || body.status === "休みます"))
      tell(bosses(env, store), `今日いる人${where(store)}`, `${from}：「${body.status}」が入りました。`);
    return ok();
  }

  // --- 申し送り ---
  if (path === "/api/handoffs") {
    if ((e = needStore())) return e;
    const text = cleanText(body.text);
    if (!text) return fail("内容を書いてください。");
    await run("INSERT INTO handoffs (author, text, created_at, store) VALUES (?, ?, ?, ?)", me.name, text, nowIso(), store);
    tell(staffOfStore(env, store), `申し送り${where(store)}`, `${from}から申し送りがあります。`);
    return ok();
  }
  if ((m = path.match(/^\/api\/handoffs\/(\d+)\/done$/))) {
    if (!canSee(env, me, await storeOfRow("handoffs", Number(m[1])))) return fail("この店舗は見られません。", 403);
    await run("UPDATE handoffs SET done_at = ?, done_by = ? WHERE id = ? AND done_at IS NULL", nowIso(), me.name, Number(m[1]));
    return ok();
  }

  // --- 訪問の動き ---
  if (path === "/api/visits/route") {
    if ((e = needStore())) return e;
    const name = canManage(env, me, store) ? body.name || me.name : me.name;
    if (!staffOfStore(env, store).includes(name)) return fail("名前を選んでください。");
    const stops = (Array.isArray(body.stops) ? body.stops : []).map((s) => String(s).trim().slice(0, 60)).filter(Boolean).slice(0, 12);
    if (!stops.length) await run("DELETE FROM visit_routes WHERE day = ? AND name = ?", jstDay(), name);
    else await run("INSERT OR REPLACE INTO visit_routes (day, name, stops, store) VALUES (?, ?, ?, ?)", jstDay(), name, JSON.stringify(stops), store);
    return ok();
  }
  if (path === "/api/visits/status") {
    if (incho) return fail("ボタンを押すのは外に出ている本人です。", 403);
    if ((e = needStore())) return e;
    if (!VISIT_LABELS.includes(body.label)) return fail("ボタンが正しくありません。");
    await run("INSERT INTO visit_status (day, name, label, created_at, store) VALUES (?, ?, ?, ?, ?)", jstDay(), me.name, body.label, nowIso(), store);
    if (body.label === "遅れます") tell(bosses(env, store), `訪問${where(store)}`, `${from}：「遅れます」が押されました。`);
    return ok();
  }

  // --- 点検表 ---
  if ((m = path.match(/^\/api\/checklist\/(\d+)\/toggle$/))) {
    const id = Number(m[1]);
    if (!canSee(env, me, await storeOfRow("checklist_items", id))) return fail("この店舗は見られません。", 403);
    if (body.on) await run("INSERT OR IGNORE INTO checklist_done (day, item_id, name, done_at) SELECT ?, id, ?, ? FROM checklist_items WHERE id = ? AND active = 1", jstDay(), me.name, nowIso(), id);
    else await run("DELETE FROM checklist_done WHERE day = ? AND item_id = ?", jstDay(), id);
    return ok();
  }
  if (path === "/api/checklist/items") {
    if ((e = needStore())) return e;
    if (!canManage(env, me, store)) return fail("点検の項目を変えられるのは、院長と店長です。", 403);
    const label = cleanText(body.label, 40);
    if (!label) return fail("項目を書いてください。");
    if (!PHASES.includes(body.phase)) return fail("開院前か閉院後かを選んでください。");
    await run("INSERT INTO checklist_items (phase, label, sort, store) VALUES (?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM checklist_items WHERE phase = ? AND store = ?), ?)",
      body.phase, label, body.phase, store, store);
    return ok();
  }
  if ((m = path.match(/^\/api\/checklist\/items\/(\d+)\/remove$/))) {
    if (!canManage(env, me, await storeOfRow("checklist_items", Number(m[1])))) return fail("点検の項目を変えられるのは、院長と店長です。", 403);
    await run("UPDATE checklist_items SET active = 0 WHERE id = ?", Number(m[1]));
    return ok();
  }

  // --- 備品 ---
  if (path === "/api/supplies") {
    if ((e = needStore())) return e;
    const item = cleanText(body.item, 40);
    if (!item) return fail("なくなりそうな物を書いてください。");
    await run("INSERT INTO supplies (item, note, author, created_at, store) VALUES (?, ?, ?, ?, ?)", item, cleanText(body.note, 60) || "", me.name, nowIso(), store);
    return ok();
  }
  if ((m = path.match(/^\/api\/supplies\/(\d+)\/done$/))) {
    if (!canSee(env, me, await storeOfRow("supplies", Number(m[1])))) return fail("この店舗は見られません。", 403);
    await run("UPDATE supplies SET done_at = ?, done_by = ? WHERE id = ? AND done_at IS NULL", nowIso(), me.name, Number(m[1]));
    return ok();
  }

  // --- 院の帳：予定 ---
  const seeable = (st) => (st === ALL ? myStores(env, me).length > 0 : canSee(env, me, st));
  if (path === "/api/events") {
    const dest = body.dest === ALL ? ALL : store;
    if (dest !== ALL && (e = needStore())) return e;
    if (!canManage(env, me, dest)) return fail(dest === ALL ? "全店舗の予定を入れられるのは院長だけです。" : "予定を入れられるのは、院長と店長です。", 403);
    const day = String(body.day || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < jstDay(-1) || day > jstDay(400)) return fail("日にちを選んでください。");
    const time = /^\d{2}:\d{2}$/.test(String(body.time || "")) ? body.time : "";
    const text = cleanText(body.text, MAX_SHORT);
    if (!text) return fail("予定の中身を書いてください。");
    await run("INSERT INTO events (store, day, time, text, author, created_at) VALUES (?, ?, ?, ?, ?, ?)", dest, day, time, text, me.name, nowIso());
    return ok();
  }
  if ((m = path.match(/^\/api\/events\/(\d+)\/remove$/))) {
    const r = await env.DB.prepare("SELECT store, author FROM events WHERE id = ?").bind(Number(m[1])).first();
    if (!r) return ok();
    if (!canManage(env, me, r.store) && r.author !== me.name) return fail("消せるのは、院長・店長と、入れた人です。", 403);
    await run("DELETE FROM events WHERE id = ?", Number(m[1]));
    return ok();
  }

  // --- 院の帳：決まり・マニュアル ---
  if (path === "/api/rules") {
    const id = Number(body.id) || 0;
    let dest = body.dest === ALL ? ALL : store;
    if (id) {
      const r = await env.DB.prepare("SELECT store FROM rules WHERE id = ? AND active = 1").bind(id).first();
      if (!r) return fail("その決まりは見つかりません。", 404);
      dest = r.store;
    } else if (dest !== ALL && (e = needStore())) return e;
    if (!canManage(env, me, dest)) return fail(dest === ALL ? "全店舗の決まりを書けるのは院長だけです。" : "決まりを書けるのは、院長と店長です。", 403);
    const title = cleanText(body.title, 40);
    const text = cleanText(body.body, 4000);
    if (!title || !text) return fail("題と中身を書いてください。");
    if (id) await run("UPDATE rules SET title = ?, body = ?, updated_at = ?, updated_by = ? WHERE id = ?", title, text, nowIso(), me.name, id);
    else await run("INSERT INTO rules (store, title, body, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)", dest, title, text, nowIso(), me.name);
    tell(staffOfStore(env, dest), `決まり・マニュアル${where(dest)}`, `「${title}」が${id ? "新しくなりました" : "加わりました"}。読んだら「読みました」を押してください。`);
    return ok();
  }
  if ((m = path.match(/^\/api\/rules\/(\d+)\/(read|remove)$/))) {
    const id = Number(m[1]);
    const r = await env.DB.prepare("SELECT store FROM rules WHERE id = ? AND active = 1").bind(id).first();
    if (!r || !seeable(r.store)) return fail("その決まりは見つかりません。", 404);
    if (m[2] === "read") {
      if (incho) return fail("「読みました」を押すのはスタッフです。", 403);
      await run("INSERT OR REPLACE INTO rule_reads (rule_id, name, read_at) VALUES (?, ?, ?)", id, me.name, nowIso());
      return ok();
    }
    if (!canManage(env, me, r.store)) return fail("決まりを消せるのは、院長と店長です。", 403);
    await run("UPDATE rules SET active = 0 WHERE id = ?", id);
    return ok();
  }

  // --- 院の帳：新人の練習 ---
  if (path === "/api/practice/items") {
    if ((e = needStore())) return e;
    if (!canManage(env, me, store)) return fail("練習の項目を変えられるのは、院長と店長です。", 403);
    const label = cleanText(body.label, 40);
    if (!label) return fail("項目を書いてください。");
    await run("INSERT INTO practice_items (store, label, sort) VALUES (?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM practice_items WHERE store = ?))", store, label, store);
    return ok();
  }
  if ((m = path.match(/^\/api\/practice\/items\/(\d+)\/remove$/))) {
    if (!canManage(env, me, await storeOfRow("practice_items", Number(m[1])))) return fail("練習の項目を変えられるのは、院長と店長です。", 403);
    await run("UPDATE practice_items SET active = 0 WHERE id = ?", Number(m[1]));
    return ok();
  }
  if (path === "/api/practice/mark") {
    const item = Number(body.item);
    const st = await storeOfRow("practice_items", item);
    if (!st || !canSee(env, me, st)) return fail("この店舗は見られません。", 403);
    const name = String(body.name || "");
    if (!staffOfStore(env, st).includes(name)) return fail("名前を選んでください。");
    const level = [0, 1, 2].includes(Number(body.level)) ? Number(body.level) : -1;
    if (level < 0) return fail("選び方が正しくありません。");
    if (!canManage(env, me, st)) {
      if (name !== me.name) return fail("自分の分だけ入れられます。", 403);
      if (level === 2) return fail("「できた」を付けるのは、院長と店長です。", 403);
      const cur = await env.DB.prepare("SELECT level FROM practice_marks WHERE item_id = ? AND name = ?").bind(item, name).first();
      if (cur && cur.level === 2) return fail("「できた」が付いた項目は、院長か店長が変えます。", 403);
    }
    if (level === 0) await run("DELETE FROM practice_marks WHERE item_id = ? AND name = ?", item, name);
    else await run("INSERT OR REPLACE INTO practice_marks (item_id, name, level, set_by, updated_at) VALUES (?, ?, ?, ?, ?)", item, name, level, me.name, nowIso());
    return ok();
  }

  // --- 院の帳：ありがとうカード ---
  if (path === "/api/thanks") {
    if ((e = needStore())) return e;
    const to = String(body.to || "");
    if (to === me.name) return fail("自分には送れません。");
    if (to !== "院長" && !staffOfStore(env, store).includes(to)) return fail("送る相手を選んでください。");
    const text = cleanText(body.text, MAX_SHORT);
    if (!text) return fail("ひとこと書いてください。");
    await run("INSERT INTO thanks (store, from_name, to_name, text, created_at) VALUES (?, ?, ?, ?, ?)", store, me.name, to, text, nowIso());
    tell([to], "ありがとうカード", `${from}から、ありがとうカードが届きました。`);
    return ok();
  }
  if ((m = path.match(/^\/api\/thanks\/(\d+)\/remove$/))) {
    const r = await env.DB.prepare("SELECT from_name FROM thanks WHERE id = ?").bind(Number(m[1])).first();
    if (!r) return ok();
    if (!incho && r.from_name !== me.name) return fail("消せるのは、送った人と院長です。", 403);
    await run("DELETE FROM thanks WHERE id = ?", Number(m[1]));
    return ok();
  }

  // --- 暗証番号の再設定（院長だけ） ---
  if (path === "/api/pins/reset") {
    if (!incho) return fail("暗証番号の再設定は院長だけができます。", 403);
    if (isDemo(env)) return fail("お試し用では、暗証番号はありません。", 403);
    if (!staffNames(env).includes(body.name)) return fail("名前を選んでください。");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM pins WHERE name = ?").bind(body.name),
      env.DB.prepare("DELETE FROM pin_fail WHERE name = ?").bind(body.name),
    ]);
    return ok();
  }

  return fail("見つかりません。", 404);
}

// 毎回のはじめに：入れ物を用意し、設定と鍵を読み込む
async function prepare(env) {
  await ensureSchema(env);
  const CFG = await loadConfig(env);
  const SECRET = await sessionSecret(env);
  const e = { ...env, CFG, SECRET };
  await fillStores(e);
  if (isDemo(e)) await resetDemo(e);
  else await dailyCleanup(e);
  return e;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        const e = await prepare(env);
        e.ORIGIN = url.origin;
        e.later = (p) => (ctx && ctx.waitUntil ? ctx.waitUntil(p) : p);
        return await api(request, e, url);
      } catch (e) {
        console.error(e);
        return fail("うまく保存できませんでした。少し待ってからもう一度押してください。", 500);
      }
    }
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
  },
  // 時刻の予約（crons）を付けたときだけ動く。付けなくても、毎日はじめに開かれたときに同じことをする
  async scheduled(event, env, ctx) {
    ctx.waitUntil(prepare(env).then((e) => (isDemo(e) ? resetDemo(e, true) : cleanup(e))));
  },
};

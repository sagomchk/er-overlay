/**
 * 이터널 리턴 랭크 오버레이용 Worker
 *
 * - ER Open API 키는 Cloudflare 비밀 값(ER_API_KEY)에만 저장하고, 브라우저에는 절대 보내지 않아요.
 * - 페이지는 GET /overlay?nick=닉네임&count=10 한 번만 부르고,
 *   Worker가 안에서 필요한 ER API를 모두 호출해 계산된 결과만 돌려줘요.
 *   (Workers 무료 플랜은 "Worker로 들어온 요청" 수로 한도를 세서, 한 번으로 합치면 그만큼 많은 사람이 쓸 수 있어요)
 * - ALLOWED_ORIGINS에 적힌 사이트(예: GitHub Pages 주소)에서 온 요청만 받아요.
 * - 결과와 공용 데이터(시즌·상위 랭커)는 잠시 캐시해서 ER API 호출을 줄여요.
 *
 * 환경 변수 (wrangler.toml [vars] 또는 대시보드)
 *   ALLOWED_ORIGINS  쉼표로 구분한 허용 출처. 예: "https://아이디.github.io,http://localhost:8080"
 *   ALLOWED_NICKS    (선택) 쉼표로 구분한 허용 닉네임. 비워 두면 모든 닉네임 허용
 * 비밀 값
 *   ER_API_KEY       `npx wrangler secret put ER_API_KEY` 로 등록
 */

const UPSTREAM = "https://open-api.bser.io";

/* 캐시 시간(초) */
const TTL = {
  result: 150,     // /overlay 결과. 3분 갱신보다 조금 짧게 → 같은 닉네임을 여러 곳에서 띄워도 한 번만 조회
  nickname: 600,   // 닉네임 → userId
  olderGames: 3600, // 경기 목록 2페이지 이후 (지난 경기라 바뀌지 않음)
  top: 600,        // 상위 랭커 (컷 점수)
  season: 3600,    // 시즌 데이터
};
const MAXP = 5;          // 최근 랭크 경기·오늘 경기를 찾을 때 더 불러올 경기 목록 페이지 수 (1페이지 = 10판)
const ETERNITY = 300;    // 이터니티 순위 (공식: 미스릴 700점 이상 중 TOP 300)
const DEMIGOD = 1000;    // 데미갓 순위 (TOP 301~1,000)
const KST_OFFSET = 9 * 3600000;

function list(v) {
  return String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Accept",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(status, body, origin, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(origin ? corsHeaders(origin) : {}), ...(extra || {}) },
  });
}

const cacheStore = () => (typeof caches !== "undefined" ? caches.default : null);

/* ER API 호출. 문서 기준: HTTP 상태 확인 후 본문 code가 200인지 따로 확인 (HTTP 200 + code 404가 올 수 있음).
   ttl이 있으면 성공 응답만 캐시해요. 실패는 {status, retryAfter}를 던져요. */
async function upstream(path, env, ctx, ttl) {
  const target = UPSTREAM + path;
  const cache = cacheStore();
  const key = new Request(target);
  if (cache && ttl) {
    const hit = await cache.match(key);
    if (hit) return hit.json();
  }
  let res;
  try {
    res = await fetch(target, { headers: { "x-api-key": env.ER_API_KEY, Accept: "application/json" } });
  } catch (e) {
    throw { status: 502, message: "ER API에 연결하지 못했어요." };
  }
  if (res.status === 429) throw { status: 429, retryAfter: res.headers.get("Retry-After") };
  if (res.status === 401 || res.status === 403) throw { status: 403, message: "ER API 키가 올바르지 않거나 권한이 없어요." };
  if (res.status === 404) throw { status: 404 };
  if (!res.ok) throw { status: 502, message: "ER API 오류 (HTTP " + res.status + ")" };
  const text = await res.text();
  let d;
  try { d = JSON.parse(text); } catch (e) { throw { status: 502, message: "ER API 응답 형식이 올바르지 않아요." }; }
  if (!d || d.code !== 200) {
    const c = d && d.code;
    if (c === 404) throw { status: 404 };
    if (c === 429) throw { status: 429 };
    if (c === 401 || c === 403) throw { status: 403, message: "ER API 키가 올바르지 않거나 권한이 없어요." };
    throw { status: 502, message: "ER API 오류 (code " + c + ")" };
  }
  if (cache && ttl) {
    ctx.waitUntil(cache.put(key, new Response(text, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=" + ttl } })));
  }
  return d;
}

/* ---- 계산 도우미 ---- */
function isRanked(x) { return x.matchingMode === undefined || Number(x.matchingMode) === 3; }
/* "2026-11-11T20:55:45.045+0900" 같은 형식을 시각(ms)으로 */
function parseDtm(s) { return s ? Date.parse(String(s).replace(/([+-]\d\d)(\d\d)$/, "$1:$2")) : NaN; }
/* 시즌 시작·종료 "2027-02-18 09:00:00"은 한국 시간으로 봐요 */
function parseKst(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d(:\d\d)?)$/.exec(String(s).trim());
  const t = m ? Date.parse(m[1] + "T" + m[2] + (m[3] ? "" : ":00") + "+09:00") : Date.parse(s);
  return isNaN(t) ? null : t;
}
/* 한국 시간(KST) 기준 오늘 0시 */
function kstDayStart(ms) { return Math.floor((ms + KST_OFFSET) / 86400000) * 86400000 - KST_OFFSET; }
/* 경기 한 판의 실제 RP 변화: mmrGain은 갬빗 배수가 빠진 값이라 mmrGainGambit(실제 RP)을 먼저 써요 */
function gainOf(x) {
  if (typeof x.mmrGainGambit === "number") return x.mmrGainGambit;
  return typeof x.mmrGain === "number" ? x.mmrGain : 0;
}
/* 상위 랭커 목록에서 n위 안에 드는 최저 점수 (n명이 안 되면 null) */
function cutAt(list, n) {
  const top = (list || []).filter((x) => x.rank <= n);
  return top.length >= n ? Math.min(...top.map((x) => x.mmr)) : null;
}

/* 한 사람의 오버레이 데이터를 만들어요 */
async function buildOverlay(nick, count, env, ctx, freshNickname) {
  let u;
  try {
    u = await upstream("/v1/user/nickname?query=" + encodeURIComponent(nick), env, ctx, freshNickname ? 0 : TTL.nickname);
  } catch (e) {
    if (e && e.status === 404) e.noUser = true; // 닉네임 자체가 없음 → 다시 시도할 필요 없음
    throw e;
  }
  const uid = u.user && u.user.userId; // 문서: user.userId (임시 ID, 닉네임 변경 시 초기화)
  if (!uid) throw { status: 404, noUser: true };
  const name = u.user.nickname || nick;

  const s = await upstream("/v2/data/Season", env, ctx, TTL.season);
  const cur = (s.data || []).find((x) => x.isCurrent === 1);
  if (!cur) throw { status: 502, message: "현재 시즌 정보를 찾지 못했어요." };
  const season = cur.seasonID;

  // 경기 목록: 첫 페이지는 매번 새로, 이후 페이지는 캐시. 랭크 경기가 count판 모이고
  // 오늘(KST) 이전 경기까지 닿으면 멈춰요. 커서가 없거나, 비었거나, 반복되면 멈춰요.
  const gp = "/v1/user/games/uid/" + encodeURIComponent(uid);
  const t0 = kstDayStart(Date.now());
  const g = await upstream(gp, env, ctx, 0);
  const games = (g.userGames || []).slice();
  let next = g.next, pages = 0;
  const seen = new Set();
  const enough = () => {
    const ranked = games.filter(isRanked).length >= count;
    const pastToday = games.some((x) => { const t = parseDtm(x.startDtm); return !isNaN(t) && t < t0; });
    return ranked && pastToday;
  };
  while (!enough() && next !== undefined && next !== null && !seen.has(next) && pages < MAXP) {
    seen.add(next);
    const gn = await upstream(gp + "?next=" + encodeURIComponent(next), env, ctx, TTL.olderGames);
    pages++;
    const rows = gn.userGames || [];
    if (!rows.length) break;
    games.push(...rows);
    next = gn.next;
  }
  const ranked = games.filter(isRanked);
  const daily = ranked.reduce((sum, x) => { const t = parseDtm(x.startDtm); return !isNaN(t) && t >= t0 ? sum + gainOf(x) : sum; }, 0);

  const r = await upstream("/v1/rank/uid/" + encodeURIComponent(uid) + "/" + season + "/3", env, ctx, 0);
  const tp = await upstream("/v1/rank/top/" + season + "/3", env, ctx, TTL.top);

  return {
    code: 200,
    name,
    season,
    mmr: r.userRank ? r.userRank.mmr : null,
    rank: r.userRank ? r.userRank.rank : null,
    recent: ranked.slice(0, count).map((x) => x.gameRank),
    daily,
    cut: cutAt(tp.topRanks, ETERNITY),
    dcut: cutAt(tp.topRanks, DEMIGOD),
    start: parseKst(cur.seasonStart),
    end: parseKst(cur.seasonEnd),
    updated: Date.now(),
  };
}

async function handleOverlay(url, env, ctx, origin) {
  const nick = (url.searchParams.get("nick") || "").trim();
  if (!nick || nick.length > 40) return json(400, { code: 400, message: "닉네임이 필요해요." }, origin);
  const count = Math.min(10, Math.max(1, parseInt(url.searchParams.get("count"), 10) || 10));

  const nicks = list(env.ALLOWED_NICKS);
  if (nicks.length && !nicks.includes(nick)) return json(403, { code: 403, message: "허용되지 않은 닉네임이에요." }, origin);
  if (!env.ER_API_KEY) return json(500, { code: 500, message: "Worker에 API 키가 설정되지 않았어요." }, origin);

  // 같은 닉네임·판수의 결과는 잠시 재사용해요
  const cache = cacheStore();
  const ckey = new Request("https://overlay.cache/v2?nick=" + encodeURIComponent(nick) + "&count=" + count);
  if (cache) {
    const hit = await cache.match(ckey);
    if (hit) return withCors(hit, origin, "HIT");
  }

  let data;
  try {
    try {
      data = await buildOverlay(nick, count, env, ctx, false);
    } catch (e) {
      // 캐시해 둔 userId가 만료됐을 수 있어서, 404면 닉네임을 새로 조회해 한 번 더 시도해요
      if (e && e.status === 404 && !e.noUser) data = await buildOverlay(nick, count, env, ctx, true);
      else throw e;
    }
  } catch (e) {
    const status = (e && e.status) || 500;
    const message = status === 404 ? "닉네임을 찾을 수 없어요." : status === 429 ? "ER API 요청이 많아요. 잠시 후 다시 시도해 주세요." : (e && e.message) || "알 수 없는 오류가 발생했어요.";
    const extra = e && e.retryAfter ? { "Retry-After": e.retryAfter } : {};
    return json(status, { code: status, message }, origin, extra);
  }

  const body = JSON.stringify(data);
  if (cache) {
    ctx.waitUntil(cache.put(ckey, new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=" + TTL.result } })));
  }
  return withCors(new Response(body, { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } }), origin, "MISS");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const okOrigin = origin && list(env.ALLOWED_ORIGINS).includes(origin) ? origin : null;

    // 상태 확인용 (출처 확인 없이 응답, ER API는 호출하지 않음)
    if (url.pathname === "/" || url.pathname === "/health") {
      return json(200, { ok: true, keySet: !!env.ER_API_KEY }, okOrigin);
    }

    if (!okOrigin) return json(403, { code: 403, message: "허용되지 않은 출처예요." }, null);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(okOrigin) });
    if (request.method !== "GET") return json(405, { code: 405, message: "GET만 지원해요." }, okOrigin);

    if (url.pathname === "/overlay") return handleOverlay(url, env, ctx, okOrigin);
    return json(404, { code: 404, message: "지원하지 않는 경로예요." }, okOrigin);
  },
};

function withCors(res, origin, state) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin))) h.set(k, v);
  h.set("X-Cache", state);
  h.delete("Cache-Control");
  return new Response(res.body, { status: res.status, headers: h });
}

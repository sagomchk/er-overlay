/**
 * 이터널 리턴 랭크 오버레이용 API 중계 Worker
 *
 * - ER Open API 키는 Cloudflare 비밀 값(ER_API_KEY)에만 저장하고, 브라우저에는 절대 보내지 않아요.
 * - 오버레이에 필요한 경로 5개만 중계해요.
 * - ALLOWED_ORIGINS에 적힌 사이트(예: GitHub Pages 주소)에서 온 요청만 받아요.
 * - 같은 요청은 잠시 캐시해서 API 호출 수(=키 한도 소모)를 줄여요.
 *
 * 환경 변수 (wrangler.toml [vars] 또는 대시보드)
 *   ALLOWED_ORIGINS  쉼표로 구분한 허용 출처. 예: "https://아이디.github.io,http://localhost:8080"
 *   ALLOWED_NICKS    (선택) 쉼표로 구분한 허용 닉네임. 비워 두면 모든 닉네임 허용
 * 비밀 값
 *   ER_API_KEY       `npx wrangler secret put ER_API_KEY` 로 등록
 */

const UPSTREAM = "https://open-api.bser.io";

/* 허용 경로와 캐시 시간(초). 문서: https://developer.eternalreturn.io */
const ROUTES = [
  { re: /^\/v1\/user\/nickname$/, ttl: 600, query: ["query"] },
  { re: /^\/v1\/user\/games\/uid\/[^/]+$/, ttl: 30, query: ["next"] },
  { re: /^\/v1\/rank\/uid\/[^/]+\/\d{1,4}\/3$/, ttl: 30, query: [] },
  { re: /^\/v1\/rank\/top\/\d{1,4}\/3$/, ttl: 600, query: [] },
  { re: /^\/v2\/data\/Season$/, ttl: 3600, query: [] },
];

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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const allowed = list(env.ALLOWED_ORIGINS);
    const okOrigin = origin && allowed.includes(origin) ? origin : null;

    // 상태 확인용 (출처 확인 없이 응답, API는 호출하지 않음)
    if (url.pathname === "/" || url.pathname === "/health") {
      return json(200, { ok: true, keySet: !!env.ER_API_KEY }, okOrigin);
    }

    if (!okOrigin) return json(403, { code: 403, message: "허용되지 않은 출처예요." }, null);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(okOrigin) });
    if (request.method !== "GET") return json(405, { code: 405, message: "GET만 지원해요." }, okOrigin);

    const route = ROUTES.find((r) => r.re.test(url.pathname));
    if (!route) return json(404, { code: 404, message: "지원하지 않는 경로예요." }, okOrigin);

    // 필요한 쿼리만 남겨서 캐시 키와 중계 주소를 만들어요
    const q = new URLSearchParams();
    for (const name of route.query) {
      const v = url.searchParams.get(name);
      if (v !== null && v !== "") q.set(name, v);
    }
    if (route.query.includes("query") && !q.get("query")) {
      return json(400, { code: 400, message: "닉네임이 필요해요." }, okOrigin);
    }
    if (q.get("next") && !/^\d{1,20}$/.test(q.get("next"))) {
      return json(400, { code: 400, message: "next 값이 올바르지 않아요." }, okOrigin);
    }

    const nicks = list(env.ALLOWED_NICKS);
    if (nicks.length && url.pathname === "/v1/user/nickname" && !nicks.includes(q.get("query"))) {
      return json(403, { code: 403, message: "허용되지 않은 닉네임이에요." }, okOrigin);
    }

    if (!env.ER_API_KEY) return json(500, { code: 500, message: "Worker에 API 키가 설정되지 않았어요." }, okOrigin);

    const target = UPSTREAM + url.pathname + (q.toString() ? "?" + q.toString() : "");
    const cache = typeof caches !== "undefined" ? caches.default : null;
    const cacheKey = new Request(target, { method: "GET" });

    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) return withCors(hit, okOrigin, "HIT");
    }

    let up;
    try {
      up = await fetch(target, { headers: { "x-api-key": env.ER_API_KEY, Accept: "application/json" } });
    } catch (e) {
      return json(502, { code: 502, message: "ER API에 연결하지 못했어요." }, okOrigin);
    }

    const body = await up.text();
    const headers = { "Content-Type": up.headers.get("Content-Type") || "application/json; charset=utf-8" };
    const ra = up.headers.get("Retry-After");
    if (ra) headers["Retry-After"] = ra;

    // 본문 code가 200인 성공 응답만 캐시해요 (HTTP 200 + code 404 같은 실패는 캐시하지 않음)
    let cacheable = false;
    if (up.status === 200) {
      try { cacheable = JSON.parse(body).code === 200; } catch (e) { cacheable = false; }
    }
    const res = new Response(body, { status: up.status, headers });
    if (cache && cacheable) {
      const toCache = new Response(body, { status: 200, headers: { ...headers, "Cache-Control": "public, max-age=" + route.ttl } });
      ctx.waitUntil(cache.put(cacheKey, toCache));
    }
    return withCors(res, okOrigin, "MISS");
  },
};

function withCors(res, origin, state) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin))) h.set(k, v);
  h.set("X-Cache", state);
  h.delete("Cache-Control");
  return new Response(res.body, { status: res.status, headers: h });
}

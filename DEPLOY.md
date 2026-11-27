# 배포 안내

```
OBS / 브라우저 ──▶ GitHub Pages (docs/index.html, API 키 없음)
                        ▼
                 Cloudflare Worker (worker/, API 키 보관)
                        ▼
                 ER Open API (open-api.bser.io)
```

## 1. Cloudflare Worker

```powershell
cd worker
npx wrangler login                     # 브라우저에서 Cloudflare 로그인·승인 (직접)
npx wrangler secret put ER_API_KEY     # 프롬프트에 API 키 붙여넣기 (직접)
npx wrangler deploy                    # 배포 → https://er-overlay-proxy.<서브도메인>.workers.dev
```

- `worker/wrangler.toml`의 `ALLOWED_ORIGINS`에 GitHub Pages 주소를 넣고 다시 `npx wrangler deploy` 해요.
  예: `"https://아이디.github.io"` (경로 없이 출처만, 끝에 / 없이)
- 본인 닉네임만 허용하려면 `ALLOWED_NICKS = "연소"`처럼 적어요.
- 확인: `https://er-overlay-proxy.<서브도메인>.workers.dev/health` → `{"ok":true,"keySet":true}`

## 2. 페이지 설정

`docs/index.html`의 `WORKER_URL`을 1번에서 받은 Worker 주소로 바꿔요.

## 3. GitHub Pages

1. GitHub에 공개 저장소를 만들고 이 폴더를 올려요 (`.gitignore`가 API 키·계정 파일을 막아 줘요).
2. 저장소 Settings → Pages → Source: `Deploy from a branch`, Branch: `main`, 폴더: `/docs`
3. `https://아이디.github.io/저장소이름/` 에서 닉네임으로 조회 → "OBS용 링크 만들기"

## 로컬 테스트

```powershell
cd worker
# .dev.vars 파일에 ER_API_KEY=키 를 적어 두면 wrangler dev가 읽어요 (.gitignore에 포함)
npx wrangler dev --port 8787
```
페이지를 `http://localhost:8080`에서 띄우고 주소 뒤에 `?api=http://localhost:8787`을 붙여요.

## Worker가 하는 일

- 오버레이에 필요한 5개 경로만 중계: 닉네임 조회, 경기 목록, 랭크, 상위 랭커, 시즌 데이터
- `ALLOWED_ORIGINS`에 없는 사이트의 요청은 403
- 성공 응답 캐시: 경기·랭크 30초, 닉네임·상위 랭커 10분, 시즌 1시간
- ER API의 429(요청 제한)와 `Retry-After`를 그대로 전달

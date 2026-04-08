# Cloudflare Workers Deploy

## Durable Objects

이 프로젝트는 Durable Object를 3개 사용한다.

- `GROUP_DO`
  그룹 단위 상태, 요청, 투표 저장
- `AUTH_DO`
  Discord OAuth 매핑, 세션 저장
- `GROUP_REGISTRY_DO`
  3인 그룹 registry 저장

현재 설정은 루트 [wrangler.jsonc](/c:/Users/wjws9/바탕%20화면/Vibe_projects/Chain-type_YouTube_Shorts_Blocker/wrangler.jsonc)에 고정되어 있다.

## GitHub 연동 배포 기준

Cloudflare Workers에서 이 저장소를 GitHub로 연결할 때 기준은 다음과 같다.

1. Production branch: `main`
2. Root directory: 저장소 루트
3. Build command: `npm run build`
4. Deploy command: `npm run deploy:worker`

이 저장소는 npm workspace 루트이므로 기본 `npx wrangler deploy`를 그대로 쓰면 실패할 수 있다.

반드시 루트에서 아래 명령으로 배포한다.

```bash
npm run deploy:worker
```

위 스크립트는 내부적으로 다음을 실행한다.

```bash
wrangler deploy --config wrangler.jsonc
```

`wrangler.jsonc`가 루트에 있으므로 Worker 대상이 명확하게 지정된다.

## 반드시 넣어야 하는 Secret / Variable

Secret으로 넣을 값:

- `ADMIN_API_TOKEN`
- `EXTENSION_API_TOKEN`
- `DISCORD_API_TOKEN`
- `DISCORD_PUBLIC_KEY`
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_OAUTH_REDIRECT_URI`

`wrangler.jsonc`의 `secrets.required`에 등록되어 있으므로 누락된 secret이 있으면 deploy 단계에서 바로 실패한다.

Variable로 넣을 값:

- `ALLOWED_ORIGINS`
- `DISCORD_API_BASE_URL`

`ALLOWED_ORIGINS` 예시:

```text
chrome-extension://<실제-확장프로그램-id>
```

여러 origin을 허용해야 하면 현재 Worker 코드 기준으로 쉼표 구분 문자열로 관리하는 쪽이 안전하다.

## Durable Object 변경 규칙

Durable Object 클래스에 대해 아래 변경이 생기면 `wrangler.jsonc`의 `migrations`를 추가해야 한다.

- 새 DO 클래스 추가
- 기존 DO 클래스 이름 변경
- 기존 DO 클래스 삭제

현재 클래스명:

- `GroupDurableObject`
- `AuthDurableObject`
- `GroupRegistryDurableObject`

코드만 수정하고 클래스명과 바인딩이 그대로라면 새 migration은 필요 없다.

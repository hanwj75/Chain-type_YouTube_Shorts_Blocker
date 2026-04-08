# youtube-shorts-chain-blocker

YouTube Shorts 접근을 3인 그룹 투표로 제어하는 시스템의 초기 모노레포 스캐폴딩입니다.

## Structure

```text
youtube-shorts-chain-blocker/
├─ apps/
│  ├─ extension/
│  └─ worker/
├─ packages/
│  ├─ domain/
│  └─ api-contract/
├─ docs/
├─ package.json
├─ tsconfig.base.json
└─ README.md
```

## Run

```bash
npm install
npm run typecheck
npm run build
```

## Deploy

Cloudflare Workers + Durable Objects 배포 설정은 [docs/cloudflare-workers-deploy.md](/c:/Users/wjws9/바탕%20화면/Vibe_projects/Chain-type_YouTube_Shorts_Blocker/docs/cloudflare-workers-deploy.md) 와 [wrangler.jsonc](/c:/Users/wjws9/바탕%20화면/Vibe_projects/Chain-type_YouTube_Shorts_Blocker/wrangler.jsonc) 기준으로 관리한다.

Cloudflare GitHub 연동 시 권장 설정:

```bash
Build command: npm run build
Deploy command: npm run deploy:worker
```

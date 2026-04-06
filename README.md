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

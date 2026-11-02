# cardnovel · 카드소설 제작소

이야기를 넣으면 20장 카드소설(표지 1 · 본문 18 · 마지막 1)을 만들어 주는 개인용 웹앱(PWA).

- 기획 문서: [docs/PRD.md](docs/PRD.md) (원본은 Claude Docs 문서)
- 디자인(색·서체·카드 규격·테마 13종)은 기존 아티팩트 「카드소설 제작소」에서 그대로 옮겼다.

## 실행

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run build
```

배포: https://cardnovel.vercel.app (Vercel 프로젝트 `cardnovel`). 정적 앱(`dist/`)과 Canva 연결용 서버리스 함수(`api/canva/*`)가 함께 올라간다. 홈 화면 설치·오프라인은 HTTPS(또는 localhost)에서만 동작한다.

### Canva 연결 설정

| 위치 | 값 |
| --- | --- |
| Canva 개발자 포털 → Authorized redirects | `https://cardnovel.vercel.app/api/canva/callback` |
| Canva 개발자 포털 → Return navigation URL | `https://cardnovel.vercel.app/api/canva/return` |
| Canva 개발자 포털 → Scopes | `asset:read` `asset:write` `design:content:read` `design:content:write` `design:meta:read` |
| Vercel 환경 변수 | `CANVA_CLIENT_ID`, `CANVA_CLIENT_SECRET`, `CANVA_REDIRECT_URI`, `SESSION_SECRET` |

Canva 토큰은 `/api/canva` 경로에만 붙는 암호화된 HttpOnly 쿠키에 보관되며, 브라우저 스크립트나 다른 서버로 가지 않는다.

## 데스크톱 설치형 (macOS · Windows · Ubuntu)

`desktop/`은 배포된 앱(https://cardnovel.vercel.app)을 띄우는 Electron 앱이다. 웹을 고치면 설치형도 자동으로 최신이 되고, Canva 편집·로그인은 앱 창 안에서 열려 돌아오기가 앱 저장소로 바로 들어온다.

- 설치 파일은 GitHub Actions(`.github/workflows/desktop.yml`)가 세 OS에서 만든다. `desktop/`을 바꿔 푸시하면 실행 결과(Artifacts)에, `desktop-v*` 태그를 푸시하면 Release에 올라간다.
- 파일: macOS `CardNovel-<버전>-mac-arm64.dmg`·`-mac-x64.dmg`, Windows `CardNovel-<버전>-win-x64.exe`, Ubuntu `CardNovel-<버전>-linux-amd64.deb`·`-linux-x86_64.AppImage`
- 개발자 서명이 없어 처음 열 때 경고가 뜬다. 맥: 시스템 설정 → 개인정보 보호 및 보안 → 「그래도 열기」. 윈도우: 「추가 정보」 → 「실행」.
- 데스크톱 앱의 작품·키 저장소는 브라우저와 따로다. 옮기려면 보관함의 「내보내기」/「가져오기」를 쓴다.

```bash
cd desktop && npm install && npm start
```

## 지금 되는 것 (PRD P0 기준)

| PRD | 내용 | 상태 |
| --- | --- | --- |
| P0-1 | PWA: 홈 화면 설치, 오프라인 열기, 1초 안 자동 저장 | 됨 |
| P0-2 | API 키 설정: 모델 목록으로 키 확인, 끝 4자리만 표시, 지우기 | 됨 |
| P0-3 | 글 AI(Claude·Gemini·GPT)와 그림 AI(Gemini·GPT·Claude SVG·Canva·올리기) 따로 선택 | 됨 |
| P0-4 | 긴 원고 압축 · 줄거리 확장 · 나눈 원고 그대로(18장 아니면 합치기/나누기 미리 보기) | 됨 |
| P0-5 | 카드 편집: 본문 순서 바꾸기, 카드별 다시 쓰기, 되돌리기 20단계 | 됨 |
| P0-6 | 기존 캔버스 렌더러 이식(비율 4종, 테마 13종, 서체 6종, 01/20) | 됨 |
| P0-7 | AI 삽화: 표지 먼저 그리고 참조 이미지로 그림체 맞춤, 비용 확인, 이야기마다 그림체 제안 | 됨 |
| P0-8 | 마지막 장: 시리즈·핸들·팔로우 문구 고정 + 덧붙임(질문·예고·한마디·여운·없음) | 됨 |
| P0-9 | 보관함: 자동 저장, 사본, 파일로 내보내기·가져오기 | 됨 |
| P0-10 | PNG/JPG 한 장, 20장 ZIP, 캡션 복사, 공유 시트로 인스타에 20장 | 됨 |
| P0-11 | Canva에서 삽화 만들기: 카드 그림 자리 크기 디자인 → Canva 편집 → 돌아가기로 PNG 자동 반영 | 됨 (`api/canva/*`) |

P1(Canva 완성 카드 마감, 구글 드라이브 백업, 인스타 API 직접 게시, AI 평가)은 아직이다.

## 구조

```
src/
  main.ts          화면과 동작 (편집기, 미리보기, 설정, 보관함, 내보내기)
  render.ts        캔버스 카드 렌더러 (아티팩트에서 이식 + 마지막 장 배치)
  themes.ts        테마 13종, 비율 4종, 서체
  model.ts         20장 작품 구조, 그림체 프리셋, 기본값
  parse.ts         나눈 원고 읽기, 18장 맞추기
  ai/providers.ts  Anthropic · OpenAI · Gemini 호출 (브라우저에서 직접, 사용자 키)
  ai/prompts.ts    구성·다시 쓰기·덧붙임·그림 프롬프트, JSON 스키마
  ai/compose.ts    이야기 → 20장, 그림 그리기
  export.ts        PNG/JPG, ZIP, 공유
  store.ts         IndexedDB (localStorage 대체)
  canva.ts         Canva 연결 (브라우저 쪽)
api/canva/         Canva 서버리스 함수: login, callback, status, logout, design, export, return
api/_lib/canva.ts  토큰 쿠키 암호화, PKCE, Canva API 호출, 돌아오기 서명 검증
public/
  sw.js            오프라인 캐시
  manifest.webmanifest, icons/, fonts/
tests/             vitest 단위 테스트
```

## API 키

키는 이 기기의 브라우저(IndexedDB)에만 저장되고 각 AI 회사 API로만 전송된다. 공용 기기에서는 쓰지 말고, 각 회사 콘솔에서 월 사용 한도를 걸어 두는 것을 권한다.

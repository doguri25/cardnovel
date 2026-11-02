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

### 공유 링크 설정

「공유 링크 만들기」는 카드 20장을 JPEG로 Vercel Blob(공개 저장소 `cardnovel-shares`, 서울)에 올리고 `https://cardnovel.vercel.app/s/<id>` 주소의 넘겨 읽기 페이지를 만든다. 링크 미리보기(카톡·X 등)에는 표지가 뜨고, 검색 엔진에는 올라가지 않는다(noindex).

| 위치 | 값 |
| --- | --- |
| Vercel 환경 변수 | `BLOB_READ_WRITE_TOKEN`(Blob 저장소를 프로젝트에 연결하면 자동), `SHARE_KEY`(링크 만들기·지우기 권한) |
| 앱 설정 → 공유 링크 | `SHARE_KEY`와 같은 값을 한 번 넣는다 |

링크를 지우면 그림과 목록 파일이 모두 지워지고 주소는 「없거나 지워졌어요」를 보여 준다(엣지 캐시 때문에 최대 1분 늦을 수 있다).

### 구글 드라이브 백업 설정

브라우저만으로 동작하고 서버를 거치지 않는다. 권한은 앱이 만든 파일만 다루는 `drive.file` 하나다. 처음 한 번 Google Cloud에서 OAuth 클라이언트를 만든다.

1. https://console.cloud.google.com 에서 프로젝트를 하나 만든다(이름 예: cardnovel).
2. 「API 및 서비스 → 라이브러리」에서 **Google Drive API**를 사용 설정한다.
3. 「API 및 서비스 → OAuth 동의 화면」(Google Auth Platform → 브랜딩/대상): 사용자 유형 **외부**, 앱 이름·지원 이메일을 넣고, 「대상」에서 게시 상태를 **테스트**로 두고 **테스트 사용자**에 내 구글 계정을 추가한다. 범위(데이터 액세스)에 `.../auth/drive.file`을 넣는다.
4. 「사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID」: 유형 **웹 애플리케이션**, **승인된 자바스크립트 원본**에 `https://cardnovel.vercel.app` (다른 주소로도 쓰면 `https://3m-novel.vercel.app`, 개발용 `http://localhost:5173`)을 넣는다. 리디렉션 URI는 비워 둔다.
5. 만들어진 클라이언트 ID(`….apps.googleusercontent.com`)를 앱 「설정 → 구글 드라이브 백업」에 붙여 넣는다. 모든 기기에 기본으로 넣으려면 Vercel 환경 변수 `VITE_GOOGLE_CLIENT_ID`에 넣고 다시 배포한다(클라이언트 ID는 비밀이 아니다).

작품 하나는 드라이브 `카드소설 제작소` 폴더에 `시리즈 N화 제목.cardnovel.json` 파일 하나(글·그림 포함)로 저장된다. 같은 작품을 다른 기기에서 고쳐 드라이브 쪽이 더 최신이면 덮어쓰기 전에 묻는다. 토큰은 1시간짜리라, 한 시간이 지나면 보관함에서 다시 「드라이브 연결」을 누른다. 데스크톱 앱에서는 구글이 로그인 창을 막을 수 있어 웹에서 쓰는 것을 권한다.

## 데스크톱 설치형 (macOS · Windows · Ubuntu)

`desktop/`은 배포된 앱(https://cardnovel.vercel.app)을 띄우는 Electron 앱이다. 웹을 고치면 설치형도 자동으로 최신이 되고, Canva 편집·로그인은 앱 창 안에서 열려 돌아오기가 앱 저장소로 바로 들어온다.

- 설치 파일은 GitHub Actions(`.github/workflows/desktop.yml`)가 세 OS에서 만든다. `desktop/`을 바꿔 푸시하면 빌드 후 `desktop-v<버전>` 릴리즈(https://github.com/doguri25/cardnovel/releases)에 설치 파일이 올라간다. 버전은 `desktop/package.json`에서 정한다.
- 파일: macOS(Apple Silicon만) `CardNovel-<버전>-mac-arm64.dmg`, Windows `CardNovel-<버전>-win-x64.exe`, Ubuntu `CardNovel-<버전>-linux-amd64.deb`·`-linux-x86_64.AppImage`
- 설치된 앱 파일 이름은 영문 `CardNovel`이다(맥에서 한글 앱 파일 이름은 패키징한 앱이 실행 직후 꺼지는 문제가 있어서). 창 제목·메뉴·Dock·바로 가기 이름은 「카드소설 제작소」이고, 작품·키가 저장되는 폴더 이름도 그대로다.
- CI가 세 OS에서 설치 파일을 만든 뒤 각 OS에서 한 번씩 실행해 20장 화면이 뜨는지 확인한다(맥은 dmg에서 꺼낸 앱으로).
- 개발자 서명이 없어 처음 열 때 경고가 뜬다. 맥: 「열리지 않음」 창에서 「완료」 → 시스템 설정 → 개인정보 보호 및 보안 → 「그래도 열기」(「손상되었기 때문에…」가 뜨면 터미널에서 `xattr -cr /Applications/CardNovel.app`). 윈도우: 「추가 정보」 → 「실행」.
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

### 그다음에 넣은 것

| 기능 | 내용 |
| --- | --- |
| 카드 배치 | 카드마다 기본(그림 위·글 아래) / 전면 그림(그림이 카드 전체, 아래쪽 그늘 위에 글) / 대사(큰따옴표와 큰 글씨, 그림은 흐리게 뒤에). 전면·대사 카드는 그림을 카드 비율로 그린다 |
| 인물 기준 그림 | 그림체 상자에서 AI로 만들기·올리기·표지 그림 쓰기. Gemini·GPT 이미지 요청마다 첫 참조로 보내고, 본문 카드는 표지를 둘째 참조로 함께 보낸다 |
| AI 평가 (Ⅲ) | 흡입력·몰입·개연성·반전·여운 각 20점, 고칠 카드(최대 6장)와 「이 문장으로 바꾸기」, 제목·훅 후보 「표지에 넣기」. 글이 바뀌면 다시 평가하라고 알려 준다 |
| 인스타 미리보기 | 폰 화면 모양으로 20장 넘겨 보기(점·n/20·캡션 두 줄), 프로필 격자(3:4)에 다른 작품 표지와 함께 |
| 시리즈 | 회차 입력(표지에 ‘시리즈 · N화’), 보관함이 시리즈별로 묶임, 「다음 회 만들기」가 테마·비율·서체·그림체·인물 기준 그림을 이어받음, AI가 회마다 줄거리 요약을 남기고 다음 회 구성 때 앞 회(최대 5편) 줄거리를 넘김 |
| 공유 링크 | 위 「공유 링크 설정」 참고. 만든 링크 목록·복사·지우기 |
| 구글 드라이브 | 위 「구글 드라이브 백업 설정」 참고. 이 작품 백업·모두 백업·불러오기·저장할 때 자동 백업 |

아직 없는 것: Canva 완성 카드 마감(P1-1), 인스타 API 직접 게시(P1-3), 비용 기록(P1-5).

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
  series.ts        시리즈: 앞 회 찾기, 다음 회 만들기, 보관함 묶기
  share.ts         공유 링크 (브라우저 쪽: 올리기·목록·지우기)
  drive.ts         구글 드라이브 (로그인, 폴더, 이어 올리기, 불러오기)
  ai/review.ts     AI 평가 스키마·프롬프트·정리
  ui/              평가 패널, 인스타 미리보기, 공유 링크, 드라이브 화면
api/canva/         Canva 서버리스 함수: login, callback, status, logout, design, export, return
api/share/         공유 링크 함수: status, upload, create, delete, page(/s/<id> 뷰어)
api/_lib/canva.ts  토큰 쿠키 암호화, PKCE, Canva API 호출, 돌아오기 서명 검증
api/_lib/share.ts  공유 열쇠 확인, 목록 검사, 뷰어 HTML
public/
  sw.js            오프라인 캐시
  manifest.webmanifest, icons/, fonts/
tests/             vitest 단위 테스트
```

## API 키

키는 이 기기의 브라우저(IndexedDB)에만 저장되고 각 AI 회사 API로만 전송된다. 공용 기기에서는 쓰지 말고, 각 회사 콘솔에서 월 사용 한도를 걸어 두는 것을 권한다.

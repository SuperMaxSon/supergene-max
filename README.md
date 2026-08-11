# Supergene 기획 허브

팀이 함께 보는 기획 · 수치 · 검증 문서 인덱스. 정적 사이트라 빌드 과정이 없습니다.

**주소:** https://supermaxson.github.io/supergene-max/

---

## 문서 카드 추가하기

`data.js` **한 파일만** 고치면 됩니다. 원하는 섹션의 `cards` 배열에 객체를 하나 넣으세요.

```js
{
  title:   "가을 이벤트 기획서",
  desc:    "한 줄 설명",
  url:     "https://docs.google.com/...",   // 외부 링크 또는 docs/xxx.html
  status:  "진행중",                         // Live | 진행중 | 완료 | 초안
  version: "v1.2",
  updated: "2026-08-10",
  pinned:  false,                           // true 면 상단 강조 스타일
  tags:    ["이벤트", "가을"],
}
```

`url` 이 `http` 로 시작하면 새 탭으로 열리고 `↗` 표시가 붙습니다.

## 섹션 추가·변경

`data.js` 의 `SECTIONS` 배열을 고칩니다.

```js
{
  id: "analysis",       // 앵커 id (영문)
  label: "분석",         // 네비/제목에 보이는 이름
  accent: "analysis",   // analysis | plan | balance | validate | deploy
  desc: "섹션 한 줄 설명",
  cards: [ ... ],
}
```

`accent` 는 `style.css` 상단에 정의된 색 이름 5종 중 하나입니다.

## 문서 페이지 직접 만들기

표나 그래프가 있는 긴 문서는 `docs/` 안에 HTML 로 만듭니다.
`docs/ad-placements.html` 을 복사해서 내용만 갈아끼우는 게 제일 빠릅니다.
(상대 경로 `../style.css`, `../app.js` 는 그대로 두세요.)

만든 뒤 `data.js` 에 `url: "docs/새파일.html"` 로 카드를 추가하면 허브에 노출됩니다.

Claude Code 를 쓴다면 `/create-web-doc` 스킬이 이 절차를 그대로 수행합니다.
(템플릿 · 클래스 카탈로그 포함)

## 파일 구성

| 파일 | 역할 |
| --- | --- |
| `index.html` | 허브 페이지 뼈대 |
| `data.js` | **콘텐츠 단일 소스** — 보통 여기만 고침 |
| `app.js` | 렌더링 · 검색 · 스크롤스파이 |
| `style.css` | 디자인 시스템 (**라이트 단일 테마**) |
| `docs/` | 개별 문서 페이지 |

다크 테마와 테마 토글은 2026-08-10 에 제거했습니다.
문서가 표·수치 위주라 흰 배경이 대비가 안정적이고, 테마가 둘이면 새 문서마다
양쪽을 확인해야 해서 비용만 늘었습니다. `data-theme` 을 다시 넣지 마세요.

## 로컬에서 미리 보기

```bash
python3 -m http.server 8000
```

브라우저에서 http://localhost:8000 을 엽니다.

## 배포

`main` 브랜치에 푸시하면 GitHub Pages 가 자동 반영합니다.
(최초 1회: Settings → Pages → Source `main` / `/ (root)`)

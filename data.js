/* ==========================================================================
   data.js — 이 파일만 고치면 사이트 내용이 바뀝니다.
   카드 추가: 원하는 섹션의 cards 배열에 객체 하나 추가.
   --------------------------------------------------------------------------
   card = {
     title:   "카드 제목",            // 필수
     desc:    "한 줄 설명",           // 선택
     url:     "https://... 또는 docs/xxx.html",  // 필수 (없으면 "#")
     status:  "Live" | "진행중" | "완료" | "초안",
     version: "v1.0",
     updated: "2026-08-07",
     pinned:  true,                  // 상단 강조
     tags:    ["태그", "태그"],
   }
   ========================================================================== */

const SITE = {
  title: "Supergene 기획 허브",
  subtitle: "팀이 함께 보는 기획 · 수치 · 검증 문서 인덱스",
  updated: "2026-08-10",
};

const SECTIONS = [
  {
    id: "analysis",
    label: "분석",
    accent: "analysis",
    desc: "라이브 데이터 · 코드베이스 실측 분석",
    cards: [
      {
        title: "전면광고 지면 — 4개 프로젝트 플로우 비교",
        desc: "솔리테어 · 퍼블마 · 코지 · 마종의 전면광고를 유저 플로우 노드 13개 축에 올려 비교. 빌드 438 전환 거절 지면 첫 실측(비중 6.9%) 반영.",
        url: "docs/ad-placements.html",
        status: "완료",
        version: "v1.9",
        updated: "2026-08-10",
        pinned: true,
        tags: ["광고", "전면", "4프로젝트", "커버리지", "실측", "추가제안"],
      },
      {
        title: "로딩 속도 — 3개 프로젝트 비교",
        desc: "솔리테어 · 코지 · 퍼블마의 로딩 소요를 NRU/RU · US 기준으로 실측. 부팅 지연 전량이 LOAD_FB→LOAD_INTRO 한 구간에 집중(솔리테어 0.97초 = 코지 3.3배), OS를 맞춰도 2.5배 격차. 5개 클라 NRU 첫 판 로그 순서 감사에 실측 시각·발화율을 얹어 교차 검증.",
        url: "docs/loading-speed-compare.html",
        status: "진행중",
        version: "v1.3",
        updated: "2026-08-11",
        pinned: false,
        tags: ["로딩", "속도", "BigQuery", "NRU", "RU", "로그순서", "5프로젝트"],
      },
      {
        title: "토너먼트 바이럴 조사 — 전환율 4.9% vs 31%",
        desc: "과노출 → 채널 이동 → 전환율로 좁힌 기록. 억제 배포(빌드 438) 후 총 노출은 마종보다 낮아졌고(45% vs 55%), '생성 24배 폭락'은 공유로 옮겨간 채널 이동인 착시였다. 남은 격차는 총 바이럴 6.8배 = 다이얼로그 수락률 4.9%(마종 31%) 하나. 08-03 A/B 게이트 삭제가 채널을 옮긴 범인으로 확정. 가설 13개 중 8개 기각, 정정 7건.",
        url: "docs/tournament-share-rate.html",
        status: "진행중",
        version: "v5.0",
        updated: "2026-08-12",
        pinned: false,
        tags: ["토너먼트", "바이럴", "전환율", "BigQuery", "빌드컷", "가설기각", "채널이동"],
      },
    ],
  },
  {
    id: "plan",
    label: "기획",
    accent: "plan",
    desc: "기능 스펙 · 기획 리뷰 문서",
    cards: [
      {
        title: "여기에 기획 문서를 추가하세요",
        desc: "data.js 의 plan 섹션 cards 배열에 객체를 하나 추가하면 이 자리에 카드가 생깁니다.",
        url: "#",
        status: "초안",
        updated: "2026-08-07",
        tags: ["예시"],
      },
    ],
  },
  {
    id: "balance",
    label: "수치 · 밸런스",
    accent: "balance",
    desc: "경제 밸런스 · 난이도 · 보상 파라미터",
    cards: [
      {
        title: "여기에 밸런스 시트를 추가하세요",
        desc: "Google Sheets 링크를 url 에 넣으면 바로 열리는 카드가 됩니다.",
        url: "#",
        status: "초안",
        updated: "2026-08-07",
        tags: ["예시"],
      },
    ],
  },
  {
    id: "validate",
    label: "검증",
    accent: "validate",
    desc: "시뮬레이션 결과 · 파라미터 테스트",
    cards: [
      {
        title: "여기에 검증 결과를 추가하세요",
        desc: "시뮬레이션 리포트나 A/B 테스트 결과 링크를 모아두는 자리입니다.",
        url: "#",
        status: "초안",
        updated: "2026-08-07",
        tags: ["예시"],
      },
    ],
  },
  {
    id: "deploy",
    label: "도구 · 배포",
    accent: "deploy",
    desc: "협업 문서 · 배포 가이드 · 사내 툴",
    cards: [
      {
        title: "솔리테어 커밋 히스토리 — 왜 이렇게 고쳤나",
        desc: "커밋 문구로 훑고 필요한 것만 눌러서 펼치는 목록. 행마다 작성자 → 커밋 문구 → 해시가 한 줄로 서고, 펼치면 언제·어디서·무엇을·왜·어떻게가 나온다. 왼쪽 색 띠는 영역(이벤트·광고·로그·전환·인프라). 키워드 필터 내장 — 커밋 문구·해시·파일명·사유 전체를 검색하고 본문에만 걸린 행은 자동으로 펼친다. 2026-07-13~08-12 Max 커밋 113건(머지 제외) diff 전량 실측, 주 단위 5섹션.",
        url: "docs/commit-history-solitaire.html",
        status: "진행중",
        version: "v4.0",
        updated: "2026-08-12",
        pinned: false,
        tags: ["커밋", "작업기록", "솔리테어", "육하원칙", "토글", "diff실측"],
      },
      {
        title: "이 사이트에 문서 추가하는 법",
        desc: "data.js 파일 하나만 고치면 됩니다. README 에 설명이 있습니다.",
        url: "https://github.com/SuperMaxSon/supergene-max#readme",
        status: "Live",
        updated: "2026-08-07",
        tags: ["가이드"],
      },
    ],
  },
];

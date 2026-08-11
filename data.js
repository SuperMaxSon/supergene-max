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
        title: "토너먼트 바이럴 조사 — 생성 거절률 78.5%",
        desc: "공유율에서 출발해 본체가 생성 거절률임을 확인. 생성 성공률 1.25%(마종 29.9%)인데 판당 시도는 우리가 1위 — 과하게 띄우고 다 거절당한다. 억제 도입(08-07)으로 거절률 89.3→78.5% 회수 확인, 마종까지 20.3%p 남음. 가설 10개 중 6개 기각·정정 3건 기록.",
        url: "docs/tournament-share-rate.html",
        status: "진행중",
        version: "v3.0",
        updated: "2026-08-11",
        pinned: false,
        tags: ["토너먼트", "생성", "바이럴", "BigQuery", "가설기각", "4프로젝트"],
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

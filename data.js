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
        version: "v1.8",
        updated: "2026-08-10",
        pinned: true,
        tags: ["광고", "전면", "4프로젝트", "커버리지", "실측", "추가제안"],
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

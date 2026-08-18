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
   --------------------------------------------------------------------------
   ★ 카드를 추가·수정했으면 아래 SITE.updated 와 index.html 의
     <script src="data.js?v=YYYYMMDD"> 를 **같은 날짜로** 함께 고칠 것.
     이걸 빼먹으면 브라우저 캐시 때문에 새 카드가 최대 10분간 안 보입니다.
   ========================================================================== */

const SITE = {
  title: "Supergene 기획 허브",
  subtitle: "팀이 함께 보는 기획 · 수치 · 검증 문서 인덱스",
  updated: "2026-08-19 08:49",
};

const SECTIONS = [
  {
    id: "analysis",
    label: "분석",
    accent: "analysis",
    desc: "라이브 데이터 · 코드베이스 실측 분석",
    cards: [
      {
        title: "주간 KPI 3축 — 분석 입구",
        desc: "광고 노출 · 플레이 횟수 · 컨텍스트/공유 3축을 전주 대비 숫자로만 본다. 원인은 축마다 걸린 '왜 그런가' 링크로 내려간다. 매주 이 URL이 갱신된다.",
        url: "docs/weekly-kpi.html",
        status: "Live",
        version: "v1.0",
        updated: "2026-08-18 19:03",
        pinned: true,
        tags: ["주간KPI", "3축", "상시", "입구", "BigQuery"],
      },
      {
        title: "공유 · 메시지 — 왜 실패하나",
        desc: "축3 · 컨텍스트/공유. 피드공유 실패의 81%가 유저 취소가 아니라 PENDING_REQUEST(호출 충돌). 메시지는 전환을 더 많이 하는데 그 94.6%가 토너로 가고 친구는 5.4%뿐.",
        url: "docs/viral-surface-cross-project.html",
        status: "진행중",
        version: "v5.0",
        updated: "2026-08-18",
        pinned: false,
        tags: ["축3", "공유", "메시지", "PENDING_REQUEST", "퍼널"],
      },
      {
        title: "NRU 0~10분 — 6개 프로젝트 온보딩 비교",
        desc: "축2 · 플레이 횟수. 같은 정의로 재는 지표 4개에서 3승 1패 — 10분 도달률 · 세션당 판수 · 체류 1위, 첫 판 완료율만 열세. 값이 갈리는 이유는 가설 7건으로 분해.",
        url: "docs/nru-first-10min-compare.html",
        status: "진행중",
        version: "v4.2",
        updated: "2026-08-18",
        pinned: false,
        tags: ["축2", "NRU", "온보딩", "가설보드", "6프로젝트"],
      },
      {
        title: "토너먼트 — 생성 · 수락률",
        desc: "축3 · 컨텍스트/공유. 공유 격차의 100%가 수락률이고 발사는 1.22배 더 많다. 생성은 모바일만 붕괴. 로그 후보는 소진 — 다음은 실기 확인. 대표값/이력값 기준표 있음.",
        url: "docs/tournament-share-rate.html",
        status: "진행중",
        version: "v7.0",
        updated: "2026-08-18",
        pinned: false,
        tags: ["축3", "토너먼트", "수락률", "생성", "가설이력"],
      },
      {
        title: "5프로젝트 소셜 코드 대조표",
        desc: "축3 · 레퍼런스. 공유 호출 · 지면과 게이트 · 로그를 5개 프로젝트 코드로 나란히 대조한 28행. 수치가 아니라 코드가 바뀔 때만 갱신한다.",
        url: "docs/social-code-matrix.html",
        status: "완료",
        version: "v1.0",
        updated: "2026-08-18",
        pinned: false,
        tags: ["축3", "레퍼런스", "코드대조", "5프로젝트"],
      },
      {
        title: "로딩 속도 — 3개 프로젝트 비교",
        desc: "축2 · 플레이 횟수. 부팅 지연 전량이 LOAD_FB→LOAD_INTRO 한 구간에 몰린다(코지의 3.3배). 로그 발화 순서 · 시각 · 발화율 실측은 이 문서가 정본.",
        url: "docs/loading-speed-compare.html",
        status: "완료",
        version: "v2.1",
        updated: "2026-08-18",
        pinned: false,
        tags: ["축2", "로딩", "속도", "로그순서", "정본"],
      },
      {
        title: "전면광고 지면 — 4개 프로젝트 플로우 비교",
        desc: "축1 · 광고 노출. 솔리테어 · 퍼블마 · 코지 · 마종의 전면광고를 유저 플로우 13개 노드에 올려 비교한 코드 레퍼런스. 빌드 438 전환 거절 지면 실측 포함.",
        url: "docs/ad-placements.html",
        status: "완료",
        version: "v1.9",
        updated: "2026-08-10",
        pinned: false,
        tags: ["축1", "광고", "전면", "4프로젝트", "레퍼런스"],
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
        title: "QA 이슈 트래커",
        desc: "솔리테어 QA 채널의 이슈와 그 대응을 한눈에 보는 상시 목록. 남은 것 4건이 맨 위, 끝난 22건은 히스토리로 쌓인다. 접수→해결 시각과 소요 시간이 한 줄에 같이 있고, 줄을 누르면 어떤 커밋으로 어떻게 고쳤는지(어디서·어떻게·지금 코드) 펼쳐진다. 해시를 누르면 커밋 히스토리의 해당 항목으로 바로 넘어간다. 08-18 갱신 — SPEC-039·2100 기믹 필드 2건 완료 편입, 토너 생성 재시도 분기 1건 신규. 그리고 4932a540의 joinAsync·목록 필터가 9ea1a797에서 롤백돼 토너 조인 QA 가이드 ②번이 코드와 어긋난 상태를 표시했다.",
        url: "docs/qa-issue-code-audit.html",
        status: "Live",
        version: "v6.0",
        updated: "2026-08-18 17:10",
        pinned: true,
        tags: ["QA", "이슈", "트래커", "상시", "히스토리"],
      },
      {
        title: "토너먼트 참가 · 전환 다이얼로그 1회 — QA 가이드",
        desc: "토너먼트 목록에서 참가할 때 전환 다이얼로그를 Play 시점 1회로 줄이고, 페이스북이 참가를 허용하지 않는 토너먼트를 목록에서 제외한 수정의 QA 순서. 수정 전에는 목록 참가가 한 번도 성공하지 않았기 때문에 점수·공유·미션이 처음 동작하는 구간(C 섹션)이 핵심이다. prod 빌드 필수.",
        url: "docs/tournament-join-context-qa.html",
        status: "완료",
        version: "v1.0",
        updated: "2026-08-13 18:40",
        pinned: false,
        tags: ["토너먼트", "QA", "참가", "컨텍스트전환", "점수등록", "회귀"],
      },
      {
        title: "토너먼트 만들기 복구 · 솔로 전환 대기 — QA 가이드",
        desc: "네트워크가 끊긴 채로 만들어진 토너먼트를 성공으로 처리하고, 혼자 방으로 돌아가는 대기 시간을 30초에서 2초로 줄인 수정의 QA 순서. 평소 플레이에서는 아무 변화가 없어야 정상이고, 네트워크를 끊은 순간과 초대 링크로 들어왔다 나온 뒤가 핵심이다.",
        url: "docs/tournament-create-recovery-qa.html",
        status: "완료",
        version: "v1.0",
        updated: "2026-08-13 17:13",
        pinned: false,
        tags: ["토너먼트", "QA", "네트워크오류", "컨텍스트전환", "회귀"],
      },
      {
        title: "인게임 재도전 — QA 가이드",
        desc: "나가기 팝업(Quit Level?)의 Retry 버튼 QA 순서. v3.0에서 정산 시점이 Play → Retry 직후로 당겨지고, 프리게임 팝업을 닫으면 판으로 복귀하지 않고 로비로 나간다 — 이전 문서와 기대값이 반대인 구간이 있다. 케이스 26개.",
        url: "docs/ingame-retry-qa-flow.html",
        status: "완료",
        version: "v3.0",
        updated: "2026-08-13 17:13",
        pinned: false,
        tags: ["재도전", "QA", "나가기팝업", "프리게임팝업", "정산", "로비이탈", "회귀", "알려진이슈"],
      },
      {
        title: "나가기 종료 처리 순서 변경 — QA 가이드",
        desc: "판 중간에 나가기를 확정할 때 서버 종료 알림을 전면광고보다 먼저 보내도록 바꾼 수정의 QA 순서. 광고가 떠 있는 동안 앱을 껐다 켜도 그 판으로 돌아오지 않는지가 핵심이고, 취소한 판은 예전처럼 복귀하는지도 짝으로 확인한다.",
        url: "docs/quit-gameend-order-qa.html",
        status: "완료",
        version: "v1.0",
        updated: "2026-08-13 17:13",
        pinned: false,
        tags: ["나가기", "QA", "전면광고", "세션복귀", "로그순서", "회귀"],
      },
      {
        title: "SPEC-038 토너 초대 토글 — QA 가이드",
        desc: "토너 판을 깰 때 공유와 초대가 번갈아 뜨도록 바꾼 기능의 QA 순서. 무엇을 하면 무엇이 떠야 하는지, 안 뜨는 게 정상인 경우는 언제인지 정리했다. 3460/3470/3480 로그와 초대 수신 측 유입(entrypoint) 확인 절차, 기획서와 의도적으로 다른 2가지도 함께 표시했다.",
        url: "docs/spec-038-qa-flow.html",
        status: "완료",
        version: "v1.7",
        updated: "2026-08-13 17:13",
        pinned: false,
        tags: ["SPEC-038", "QA", "토너먼트", "초대", "로그검증", "회귀"],
      },
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
        desc: "커밋 문구로 훑고 필요한 것만 눌러서 펼치는 목록. 행마다 작성자 → 커밋 문구 → 해시가 한 줄로 서고, 펼치면 언제·어디서·무엇을·왜·어떻게가 나온다. 영역 태그(이벤트·광고·로그·전환·컨텍스트·인프라·로딩·인게임·소셜·UI·데이터·프로토콜·빌드)를 누르면 그 영역만 남고, 같은 날 같은 주제 커밋은 묶음 12개(83건)로 접혀 있어 8/3처럼 하루 16건이 몰린 날도 한 줄로 훑힌다. 키워드 필터는 커밋 문구·해시·파일명·사유 전체를 검색하고 본문에만 걸린 행은 자동으로 펼친다. 2026-07-13~08-14 Max 커밋 136건(머지 제외) diff 전량 실측, 주 단위 5섹션. 8/14 5건 추가 — 전면광고 지면 4종(럭키휠·방치골드·앨범·도시) 독립 카운터 분리, 쿨타임 시트값 단독 적용, 토너먼트 joinAsync 전환 + 참여 가능 목록 필터, Quick Next Loop 조인 전환 누락, 냥이 발동 연출 전 로비 버튼 선행 노출 수정.",
        url: "docs/commit-history-solitaire.html",
        status: "진행중",
        version: "v6.1",
        updated: "2026-08-14 17:05",
        pinned: false,
        tags: ["커밋", "작업기록", "솔리테어", "육하원칙", "태그필터", "묶음", "diff실측"],
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

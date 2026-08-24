/* ==========================================================================
   data.js — 이 파일만 고치면 사이트 내용이 바뀝니다.
   카드 추가: 원하는 섹션의 cards 배열에 객체 하나 추가.
   --------------------------------------------------------------------------
   card = {
     title:   "카드 제목",            // 필수
     desc:    "한 줄 설명",           // 선택 · 한 문장 90자 이내 (아래 ★★)
     url:     "https://... 또는 docs/xxx.html",  // 필수 (없으면 "#")
     status:  "Live" | "진행중" | "완료" | "초안",
     version: "v1.0",
     updated: "2026-08-07 10:48",     // 날짜 + 시각(HH:MM)
     pinned:  true,                  // 상단 강조
     tags:    ["태그", "태그"],        // 최대 3개
   }
   --------------------------------------------------------------------------
   ★★ 허브는 "무슨 문서가 있나"를 훑는 인덱스다. desc 는 문서를 열 이유 하나만
     한 문장으로 적는다. 수치 나열 · 버전 변경이력("v5.3 정정", "08-19 갱신 —")은
     허브가 아니라 문서 본문에 쓴다. 카드 desc 에는 CSS 2줄 클램프가 걸려 있어
     길게 써도 잘려 보이기만 한다. 태그는 최대 3개 — 지금 태그는 필터가 아니라
     라벨이므로 많아질수록 스캔만 방해한다.
   --------------------------------------------------------------------------
   ★ 카드를 추가·수정했으면 아래 SITE.updated 와 index.html 의
     <script src="data.js?v=YYYYMMDDHHMM"> 를 **같은 시각으로** 함께 고칠 것.
     이걸 빼먹으면 브라우저 캐시 때문에 새 카드가 최대 10분간 안 보입니다.
   ========================================================================== */

const SITE = {
  title: "Supergene 기획 허브",
  subtitle: "팀이 함께 보는 기획 · 수치 · 검증 문서 인덱스",
  updated: "2026-08-21 18:05",
};

const SECTIONS = [
  {
    id: "analysis",
    label: "분석",
    accent: "analysis",
    desc: "라이브 데이터 · 코드베이스 실측 분석",
    cards: [
      {
        title: "광고 유입 NRU 첫터치 — 원인 규명",
        desc: "업데이트·빌드·클라 결함 전부 배제. 같은 조건 대조군이 45.9%·70.7%인데 광고만 7.3%. 남은 원인은 유입 의도.",
        url: "docs/ua-ad-nru-first-touch.html",
        status: "완료",
        version: "v1.0",
        updated: "2026-08-20 18:52",
        pinned: false,
        tags: ["UA", "NRU", "BigQuery", "크로스프로젝트"],
      },
      {
        title: "주간 KPI 3축 — 분석 입구",
        desc: "광고 노출 · 플레이 횟수 · 공유 3축을 전주 대비 숫자로만 본다. 매주 갱신되는 분석 입구.",
        url: "docs/weekly-kpi.html",
        status: "Live",
        version: "v2.0",
        updated: "2026-08-24 09:28",
        pinned: true,
        tags: ["3축", "상시", "BigQuery"],
      },
      {
        title: "공유 · 메시지 — 왜 실패하나",
        desc: "피드공유 실패의 81%가 유저 취소가 아니라 호출 충돌. 겹치는 호출 후보는 4개까지 좁혀졌다.",
        url: "docs/viral-surface-cross-project.html",
        status: "진행중",
        version: "v5.2",
        updated: "2026-08-19 08:55",
        pinned: false,
        tags: ["축3", "공유", "퍼널"],
      },
      {
        title: "토너먼트 — 생성 · 수락률",
        desc: "공유 격차의 100%가 수락률이고 발사는 1.22배 더 많다. 생성은 모바일만 붕괴.",
        url: "docs/tournament-share-rate.html",
        status: "진행중",
        version: "v9.0",
        updated: "2026-08-18 18:20",
        pinned: false,
        tags: ["축3", "토너먼트", "수락률"],
      },
      {
        title: "토너 초대 — 시도는 2배, 유입률은 절반",
        desc: "시도/DAU는 퍼블마의 2배인데 시도당 유입은 절반. 남은 가설은 친구 그래프 성숙도 하나.",
        url: "docs/invite-inflow-channel-maturity.html",
        status: "진행중",
        version: "v1.0",
        updated: "2026-08-19 09:54",
        pinned: false,
        tags: ["축3", "초대", "유입률"],
      },
      {
        title: "NRU 0~10분 — 6개 프로젝트 온보딩 비교",
        desc: "같은 정의로 재는 지표 4개에서 3승 1패. 값이 갈리는 이유는 가설 7건으로 분해했다.",
        url: "docs/nru-first-10min-compare.html",
        status: "진행중",
        version: "v4.2",
        updated: "2026-08-18 18:10",
        pinned: false,
        tags: ["축2", "NRU", "온보딩"],
      },
      {
        title: "5프로젝트 소셜 코드 대조표",
        desc: "공유 호출 · 지면 게이트 · 로그를 5개 프로젝트 코드로 나란히 놓은 28행 대조표.",
        url: "docs/social-code-matrix.html",
        status: "완료",
        version: "v1.1",
        updated: "2026-08-19 08:55",
        pinned: false,
        tags: ["축3", "코드대조", "5프로젝트"],
      },
      {
        title: "로딩 속도 — 3개 프로젝트 비교",
        desc: "부팅 지연 전량이 LOAD_FB→LOAD_INTRO 한 구간에 몰린다(코지의 3.3배).",
        url: "docs/loading-speed-compare.html",
        status: "완료",
        version: "v2.3",
        updated: "2026-08-18 18:10",
        pinned: false,
        tags: ["축2", "로딩", "정본"],
      },
      {
        title: "전면광고 지면 — 4개 프로젝트 플로우 비교",
        desc: "솔리테어 · 퍼블마 · 코지 · 마종의 전면광고를 유저 플로우 13개 노드에 올려 비교.",
        url: "docs/ad-placements.html",
        status: "완료",
        version: "v1.9",
        updated: "2026-08-14 09:57",
        pinned: false,
        tags: ["축1", "광고", "4프로젝트"],
      },
      {
        title: "전체 지면 플로우 맵 — UI + 로직 + 컨텍스트",
        desc: "카드 17장 + 칩 32개 오픈맵을 16:9 로 눕혔습니다(가로 사용률 30%→100%). 지면을 열면 프리팹 실측 화면 요소 1,575개로 그린 와이어프레임과 버튼별 흐름 · 컨텍스트 상태 기계 · FB 지면 15종이 나옵니다.",
        url: "docs/solitaire-flow-map.html",
        status: "완료",
        version: "v10.1",
        updated: "2026-08-21 18:05",
        pinned: false,
        tags: ["레퍼런스", "플로우", "UI", "컨텍스트", "인터랙티브"],
      },
    ],
  },
  {
    id: "validate",
    label: "검증",
    accent: "validate",
    desc: "수정 전/후 결과 대조",
    cards: [
      {
        title: "토너먼트 공유 실패 — 수정 전/후",
        desc: "거절 두 원인의 전후 비교. 점수 없음은 8.3%→0.4%, 광고 충돌은 5.1%→4.0%.",
        url: "docs/tournament-share-fail-result.html",
        status: "완료",
        version: "v3.6",
        updated: "2026-08-20 10:47",
        pinned: false,
        tags: ["토너먼트", "공유", "전후비교"],
      },
      {
        title: "토너먼트 생성 실패 복구 — 수정 전/후",
        desc: "문구 변형까지 되살리게 고친 결과. 못 살린 생성은 전후 모두 0, iOS 마침표 변형만 잡혔다.",
        url: "docs/tournament-create-recovery-result.html",
        status: "완료",
        version: "v2.1",
        updated: "2026-08-20 09:19",
        pinned: false,
        tags: ["토너먼트", "생성", "전후비교"],
      },
    ],
  },
  {
    id: "qa",
    label: "QA",
    accent: "plan",
    desc: "테스트 순서 · 케이스 · 이슈 트래커",
    cards: [
      {
        title: "QA 이슈 트래커",
        desc: "솔리테어 QA 채널 이슈 상시 목록. 줄을 펼치면 어떤 커밋으로 어떻게 고쳤는지 나온다.",
        url: "docs/qa-issue-code-audit.html",
        status: "Live",
        version: "v9.0",
        updated: "2026-08-19 10:07",
        pinned: true,
        tags: ["QA", "트래커", "상시"],
      },
      {
        title: "토너먼트 참가 · 전환 다이얼로그 1회",
        desc: "전환 다이얼로그를 Play 1회로 줄이고 참가 불가 토너를 목록에서 뺀 수정의 QA 순서.",
        url: "docs/tournament-join-context-qa.html",
        status: "완료",
        version: "v1.0",
        updated: "2026-08-13 18:40",
        pinned: false,
        tags: ["QA", "토너먼트", "참가"],
      },
      {
        title: "토너먼트 만들기 복구 · 솔로 전환 대기",
        desc: "끊긴 채 만들어진 토너를 성공 처리하고 솔로 대기를 30초→2초로 줄인 수정의 QA 순서.",
        url: "docs/tournament-create-recovery-qa.html",
        status: "완료",
        version: "v1.0",
        updated: "2026-08-13 17:13",
        pinned: false,
        tags: ["QA", "토너먼트", "네트워크오류"],
      },
      {
        title: "인게임 재도전",
        desc: "나가기 팝업 Retry 버튼 QA 순서 26케이스. v3.0에서 정산 시점과 복귀 지점이 바뀌었다.",
        url: "docs/ingame-retry-qa-flow.html",
        status: "완료",
        version: "v3.0",
        updated: "2026-08-13 17:13",
        pinned: false,
        tags: ["QA", "재도전", "정산"],
      },
      {
        title: "나가기 종료 처리 순서 변경",
        desc: "종료 알림을 전면광고보다 먼저 보내도록 바꾼 수정의 QA 순서. 광고 중 앱 종료가 핵심.",
        url: "docs/quit-gameend-order-qa.html",
        status: "완료",
        version: "v1.0",
        updated: "2026-08-13 17:13",
        pinned: false,
        tags: ["QA", "나가기", "전면광고"],
      },
      {
        title: "SPEC-038 토너 초대 토글",
        desc: "토너 판을 깰 때 공유와 초대가 번갈아 뜨는 기능의 QA 순서. 안 뜨는 게 정상인 경우 포함.",
        url: "docs/spec-038-qa-flow.html",
        status: "완료",
        version: "v1.7",
        updated: "2026-08-13 17:13",
        pinned: false,
        tags: ["QA", "SPEC-038", "초대"],
      },
    ],
  },
  {
    id: "deploy",
    label: "도구 · 배포",
    accent: "deploy",
    desc: "작업 기록 · 이식 가이드 · 사내 툴",
    cards: [
      {
        title: "머지 웹 프로젝트 — 아트 인계 · 이미지 관리",
        desc: "신규 머지 프로젝트 웹 착수 전 정리. 미션·데코·아트 스타일별 웹 비용 · 세로 720×1280 · 배경 720×1559 · 병목은 CPU 디코드 40% · 급소는 조망 화면.",
        url: "docs/art-resource-handoff.html",
        status: "진행중",
        version: "v3.1",
        updated: "2026-08-24 09:56",
        pinned: false,
        tags: ["아트", "리소스", "인계규격", "머지"],
      },
      {
        title: "솔리테어 커밋 히스토리 — 왜 이렇게 고쳤나",
        desc: "커밋 문구로 훑고 필요한 것만 펼치는 목록. 07-13~08-18 Max 커밋 141건 diff 전량 실측.",
        url: "docs/commit-history-solitaire.html",
        status: "진행중",
        version: "v9.0",
        updated: "2026-08-19 12:32",
        pinned: false,
        tags: ["커밋", "작업기록", "diff실측"],
      },
      {
        title: "토너먼트 생성 복구 판정 정규화 — 다른 프로젝트 이식",
        desc: "이식할 것은 에러 문구 끝 마침표를 떼는 것 하나. 4개 프로젝트 11곳의 현재 상태 · 조치.",
        url: "docs/tournament-recovery-message-port.html",
        status: "완료",
        version: "v1.0",
        updated: "2026-08-20 10:05",
        pinned: false,
        tags: ["이식", "토너먼트", "4프로젝트"],
      },
    ],
  },
];

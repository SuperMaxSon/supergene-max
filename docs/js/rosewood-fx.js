/* ==========================================================================
   Rosewood 코어루프 시뮬레이터 — 연출 레이어
   --------------------------------------------------------------------------
   실제 클라 대응: 뷰가 부르는 연출 유틸. Cocos 로 옮기면 cc.tween 시퀀스가 된다.
   이 파일은 **상태를 바꾸지 않는다** — 보드/모델을 읽기만 하고 화면에만 그린다.
   허브 「머지 피드백 애니메이션」 문서의 값을 그대로 옮겼다.
   이징은 Cocos cc.easing 과 같은 수식이라 문서에서 본 곡선과 같다.

   의존: rosewood-order-engine.js ($ · S · specOf · spriteOf · hueOf · labelOf)
   ========================================================================== */
"use strict";

function toast(m) {
  const t = $("#rwToast");
  t.textContent = m; t.classList.add("on");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("on"), 1600);
}

/* ======================================================================
   1b. 연출 엔진
   허브 「머지 피드백 애니메이션」 문서의 값을 그대로 옮겼다.
   이징은 Cocos cc.easing 과 같은 수식이라 문서에서 본 곡선과 같다.
   ====================================================================== */
const REDUCED = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const EASE = {
  linear: (t) => t,
  quadIn: (t) => t * t,
  quadOut: (t) => t * (2 - t),
  quadInOut: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  sineInOut: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  backOut: (t) => { const s = 1.70158, u = t - 1; return u * u * ((s + 1) * u + s) + 1; },
};

/* ── 연출 파라미터 ──────────────────────────────────────────────
   값의 출처는 허브 「머지 피드백 애니메이션」 문서다. 화면(연출 값 섹션)에서
   고치고 [적용]을 누르면 여기 들어와 바로 다음 연출부터 먹는다. */
const FX_META = [
  { g: "A1 클릭", note: "통통 튀는 감각은 누를 때가 아니라 뗄 때의 오버슛에서 나온다", rows: [
    { k: "PRESS", n: "누름", u: "초", d: 0.12, c: "MERGE_BOARD_PRESS_DURATION_SEC" },
    { k: "PRESS_SX", n: "누름 가로", u: "배", d: 1.06 }, { k: "PRESS_SY", n: "누름 세로", u: "배", d: 0.94 },
    { k: "RELEASE_A", n: "뗌 오버슛", u: "초", d: 0.08, c: "MERGE_OVERSHOOT_IN_SEC" },
    { k: "REL_SX", n: "오버슛 가로", u: "배", d: 0.95 }, { k: "REL_SY", n: "오버슛 세로", u: "배", d: 1.07 },
    { k: "POP_IN", n: "복귀", u: "초", d: 0.18, c: "POP_IN_SEC" },
    { k: "E_PRESS", n: "누름 이징", u: "", d: "quadOut", e: 1 },
    { k: "E_POP", n: "복귀 이징", u: "", d: "backOut", e: 1 },
  ]},
  { g: "A2 생산 비행", note: "생산자와 결과물 사이의 인과를 화면에 붙인다 — 3차 베지어", rows: [
    { k: "FLIGHT_S0", n: "출발 배율", u: "배", d: 0.5, c: "MERGE_SPAWN_START_SCALE" },
    { k: "FLIGHT_SCALE_UP", n: "정점까지", u: "초", d: 0.15, c: "MERGE_SPAWN_POP_SEC" },
    { k: "FLIGHT_PEAK", n: "정점 배율", u: "배", d: 1.14, c: "MERGE_SPAWN_POP_SCALE" },
    { k: "FLIGHT_SCALE_DOWN", n: "정점 이후", u: "초", d: 0.27, c: "MERGE_SPAWN_SHRINK_SEC" },
    { k: "FLIGHT", n: "비행", u: "초", d: 0.42, c: "MERGE_FLIGHT_DURATION_SEC" },
    { k: "LIFT_RATIO", n: "거리 대비 치솟음", u: "배", d: 0.38, c: "MERGE_FLIGHT_LIFT_RATIO" },
    { k: "LIFT_MIN", n: "최소 치솟음", u: "px", d: 70, c: "MERGE_FLIGHT_MIN_LIFT" },
    { k: "SQUASH_IN", n: "착지 눌림", u: "초", d: 0.06, c: "MERGE_SQUASH_IN_SEC" },
    { k: "SQUASH_SX", n: "착지 가로", u: "배", d: 1.18 }, { k: "SQUASH_SY", n: "착지 세로", u: "배", d: 0.84 },
    { k: "SQUASH_OUT", n: "착지 복귀", u: "초", d: 0.16, c: "MERGE_SQUASH_OUT_SEC" },
    { k: "E_FLIGHT", n: "경로 이징", u: "", d: "quadInOut", e: 1 },
    { k: "E_FLIGHT_UP", n: "정점 이징", u: "", d: "backOut", e: 1 },
    { k: "E_FLIGHT_DOWN", n: "하강 이징", u: "", d: "quadIn", e: 1 },
  ]},
  { g: "A3 드래그", note: "손가락에 정확히 붙으면 무게가 사라진다 — 지연 추종 + 그림자 + 고스트, 셋이 같이 있어야 「들어 올렸다」가 된다", rows: [
    { k: "PICK_SEC", n: "픽업 시간", u: "초", d: 0.1, c: "MERGE_PICKUP_DURATION_SEC" },
    { k: "PICK_SCALE", n: "픽업 크기", u: "배", d: 1.08, c: "MERGE_PICKUP_SCALE" },
    { k: "PICK_LIFT", n: "들림 높이", u: "px", d: 6, c: "MERGE_PICKUP_LIFT" },
    { k: "DRAG_SHADOW_S", n: "그림자 배율", u: "배", d: 1.3, c: "MERGE_DRAG_SHADOW_SCALE" },
    { k: "DRAG_SHADOW_A", n: "그림자 투명도", u: "", d: 0.32, c: "MERGE_DRAG_SHADOW_ALPHA" },
    { k: "DRAG_GHOST_A", n: "고스트 투명도", u: "", d: 0.55, c: "MERGE_DRAG_GHOST_ALPHA" },
    { k: "DRAG_FOLLOW", n: "지연 추종 계수", u: "", d: 0.4, c: "MERGE_DRAG_FOLLOW_RATIO" },
    { k: "DRAG_TILT", n: "기울기 계수", u: "", d: 0.16, c: "MERGE_DRAG_TILT_RATIO" },
    { k: "DRAG_MOVE_PX", n: "탭 허용 이동", u: "px", d: 5, c: "MERGE_TAP_MOVE_LIMIT" },
    { k: "DRAG_SNAP", n: "셀 스냅", u: "초", d: 0.14, c: "MERGE_DRAG_SNAP_SEC" },
    { k: "DRAG_BACK", n: "원위치 복귀", u: "초", d: 0.26, c: "MERGE_SNAP_BACK_SEC" },
    { k: "DRAG_LAND_IN", n: "착지 눌림", u: "초", d: 0.06, c: "MERGE_SQUASH_IN_SEC" },
    { k: "DRAG_LAND_X", n: "착지 가로", u: "배", d: 1.14, c: "MERGE_DRAG_LAND_X" },
    { k: "DRAG_LAND_Y", n: "착지 세로", u: "배", d: 0.88, c: "MERGE_DRAG_LAND_Y" },
    { k: "DRAG_LAND_OUT", n: "착지 복귀", u: "초", d: 0.16, c: "MERGE_SQUASH_OUT_SEC" },
    { k: "E_PICK", n: "픽업 이징", u: "", d: "backOut", e: 1 },
    { k: "E_SNAP", n: "스냅 이징", u: "", d: "quadOut", e: 1 },
    { k: "E_BACK", n: "복귀 이징", u: "", d: "backOut", e: 1 },
  ]},
  { g: "A4 병합", note: "흡수 → 임팩트 → 팝. 세 박자로 끊어야 합쳐진 게 보인다", rows: [
    { k: "ABSORB", n: "흡수", u: "초", d: 0.14, c: "MERGE_ABSORB_SEC" },
    { k: "ABSORB_S", n: "흡수 배율", u: "배", d: 0.55, c: "MERGE_ABSORB_END_SCALE" },
    { k: "RING_SEC", n: "링", u: "초", d: 0.3, c: "MERGE_RING_SEC" },
    { k: "RING_SCALE", n: "링 최대", u: "배", d: 1.9, c: "MERGE_RING_MAX_SCALE" },
    { k: "SPARKS", n: "스파크 수", u: "개", d: 7, c: "MERGE_SPARK_COUNT" },
    { k: "SPARK_SEC", n: "스파크", u: "초", d: 0.34, c: "MERGE_SPARK_SEC" },
    { k: "SPARK_R", n: "스파크 반경", u: "px", d: 40, c: "MERGE_SPARK_RADIUS" },
    { k: "MERGE_START_S", n: "결과 시작 배율", u: "배", d: 0.78 },
    { k: "IMPACT", n: "임팩트", u: "초", d: 0.07, c: "MERGE_RESULT_HIT_SEC" },
    { k: "IMPACT_SX", n: "임팩트 가로", u: "배", d: 1.24 }, { k: "IMPACT_SY", n: "임팩트 세로", u: "배", d: 0.82 },
    { k: "MERGE_POP", n: "팝", u: "초", d: 0.2, c: "MERGE_POP_DURATION_SEC" },
    { k: "E_ABSORB", n: "흡수 이징", u: "", d: "quadIn", e: 1 },
    { k: "E_MERGE_POP", n: "팝 이징", u: "", d: "backOut", e: 1 },
  ]},
  { g: "A6 재화 획득", note: "코인이 흩어졌다 HUD 로 빨려 들어가고 카운터가 굴러간다", rows: [
    { k: "COIN_N", n: "코인 수", u: "개", d: 6, c: "COIN_SPRITE_LIMIT" },
    { k: "COIN_STAGGER", n: "간격", u: "초", d: 0.04, c: "MERGE_STAGGER_SEC" },
    { k: "SPREAD_SEC", n: "산개", u: "초", d: 0.26, c: "MERGE_COIN_SPREAD_SEC" },
    { k: "SPREAD_R", n: "산개 반경", u: "px", d: 52, c: "MERGE_COIN_SPREAD_RADIUS" },
    { k: "SPREAD_RISE", n: "산개 상승", u: "px", d: 48, c: "MERGE_COIN_SPREAD_RISE" },
    { k: "SPREAD_S", n: "산개 배율", u: "배", d: 1.25 },
    { k: "TRACE_SEC", n: "추적", u: "초", d: 0.34, c: "MERGE_COIN_TRACE_SEC" },
    { k: "ROLL_SEC", n: "카운터 굴림", u: "초", d: 0.5, c: "COIN_ROLL_DURATION_SEC" },
    { k: "HUD_PUNCH", n: "HUD 펀치", u: "배", d: 1.09, c: "MERGE_HUD_PUNCH_SCALE" },
    { k: "HUD_PUNCH_SEC", n: "펀치", u: "초", d: 0.12, c: "MERGE_HUD_PUNCH_SEC" },
  ]},
  { g: "C1 거부", note: "감쇠 흔들림이어야 거부로 읽힌다. 등폭 왕복은 진동이다", rows: [
    { k: "SNAP_BACK", n: "복귀", u: "초", d: 0.26, c: "MERGE_SNAP_BACK_SEC" },
    { k: "SHAKE", n: "흔들기", u: "초", d: 0.24, c: "MERGE_REJECT_SHAKE_SEC" },
    { k: "SHAKE_PX", n: "진폭", u: "px", d: 5, c: "MERGE_REJECT_SHAKE_AMPLITUDE" },
  ]},
  { g: "C2 대상 하이라이트", note: "합쳐질 짝에만 링. 같은 체인이라도 단계가 다르면 안 켠다", rows: [
    { k: "RING_IN", n: "링 등장", u: "초", d: 0.14, c: "MERGE_RING_IN_SEC" },
    { k: "RING_IN_S", n: "링 등장 배율", u: "배", d: 1.02 },
    { k: "PULSE_SEC", n: "맥동 반주기", u: "초", d: 0.45, c: "MERGE_RING_PULSE_SEC" },
    { k: "PULSE_MAX", n: "맥동 최대", u: "배", d: 1.14 }, { k: "PULSE_MIN", n: "맥동 최소", u: "배", d: 0.98 },
    { k: "PULSE_ALPHA", n: "맥동 투명", u: "0~1", d: 0.45 },
    { k: "RING_OUT", n: "링 퇴장", u: "초", d: 0.16, c: "MERGE_RING_OUT_SEC" },
    { k: "E_PULSE", n: "맥동 이징", u: "", d: "sineInOut", e: 1 },
  ]},
  { g: "C3 충전 완료", note: "유저를 다시 부르는 건 충전중이 아니라 완료되는 순간이다", rows: [
    { k: "CHARGE_IN", n: "눌림", u: "초", d: 0.08, c: "MERGE_READY_POP_IN_SEC" },
    { k: "CHARGE_SX", n: "눌림 가로", u: "배", d: 1.18 }, { k: "CHARGE_SY", n: "눌림 세로", u: "배", d: 0.84 },
    { k: "CHARGE_OUT", n: "복귀", u: "초", d: 0.22, c: "MERGE_READY_POP_OUT_SEC" },
    { k: "READY_SPARKS", n: "스파크 수", u: "개", d: 8, c: "MERGE_READY_SPARK_COUNT" },
    { k: "BADGE_SEC", n: "뱃지 등장", u: "초", d: 0.2, c: "MERGE_READY_BADGE_SEC" },
    { k: "BADGE_BOB", n: "뱃지 까딱", u: "초", d: 0.42, c: "MERGE_READY_BADGE_BOB_SEC" },
    { k: "BADGE_BOB_PX", n: "뱃지 진폭", u: "px", d: 6, c: "MERGE_READY_BADGE_BOB_PX" },
  ]},
  { g: "C4 납품", note: "목적지가 보드 밖이다. 코인(0.04)보다 무거워서 조금 느리다", rows: [
    { k: "DELIVERY_STAGGER", n: "간격", u: "초", d: 0.06, c: "DELIVERY_STAGGER_SEC" },
    { k: "DELIVERY_UP", n: "솟음", u: "초", d: 0.14, c: "MERGE_DELIVERY_RAISE_SEC" },
    { k: "DELIVERY_PEAK", n: "솟음 배율", u: "배", d: 1.12 },
    { k: "DELIVERY_AWAY", n: "축소", u: "초", d: 0.3, c: "MERGE_DELIVERY_SHRINK_SEC" },
    { k: "DELIVERY_END", n: "도착 배율", u: "배", d: 0.72 },
    { k: "DELIVERY_FLIGHT", n: "비행", u: "초", d: 0.44, c: "MERGE_DELIVERY_FLIGHT_SEC" },
    { k: "DELIVERY_LIFT_RATIO", n: "치솟음 비", u: "배", d: 0.3 },
    { k: "DELIVERY_LIFT_MIN", n: "최소 치솟음", u: "px", d: 60 },
    { k: "SLOT_HIT_IN", n: "슬롯 임팩트", u: "초", d: 0.06 },
    { k: "SLOT_HIT_S", n: "슬롯 배율", u: "배", d: 1.14 },
    { k: "SLOT_HIT_OUT", n: "슬롯 복귀", u: "초", d: 0.16 },
  ]},
  { g: "C5 최대 단계", note: "부정이 아니라 상태 고지 — 거부(5px)보다 약하게 흔든다", rows: [
    { k: "MAX_HIT_IN", n: "임팩트", u: "초", d: 0.06 },
    { k: "MAX_HIT_X", n: "임팩트 가로", u: "배", d: 1.1 }, { k: "MAX_HIT_Y", n: "임팩트 세로", u: "배", d: 0.9 },
    { k: "MAX_HIT_OUT", n: "복귀", u: "초", d: 0.18 },
    { k: "MAX_SHAKE", n: "흔들기", u: "초", d: 0.22, c: "MERGE_MAX_SHAKE_SEC" },
    { k: "MAX_SHAKE_PX", n: "진폭", u: "px", d: 4, c: "MERGE_MAX_SHAKE_AMPLITUDE" },
  ]},
  { g: "떠오르는 문구 · F3 punch", note: "보드 꽉참 · 최대 단계 — 임팩트 스탬프", rows: [
    { k: "F3_GAP", n: "칩 위 간격", u: "px", d: 38 },
    { k: "F3_S0", n: "시작 배율", u: "배", d: 1.9 },
    { k: "F3_IN", n: "등장", u: "초", d: 0.12 },
    { k: "F3_RISE", n: "상승", u: "px", d: 10 },
    { k: "F3_DIP", n: "가라앉음", u: "배", d: 0.92 },
    { k: "F3_SETTLE", n: "안정", u: "초", d: 0.14 },
    { k: "F3_HOLD", n: "유지", u: "초", d: 0.6 },
    { k: "F3_OUT", n: "퇴장", u: "초", d: 0.24 },
    { k: "F3_DRIFT", n: "퇴장 상승", u: "px", d: 26 },
  ]},
  { g: "떠오르는 문구 · F4 slide", note: "충전중 — back 계열 이징을 쓰지 않는다", rows: [
    { k: "F4_GAP", n: "칩 위 간격", u: "px", d: 34 },
    { k: "F4_FROM", n: "시작 오프셋", u: "px", d: 20 },
    { k: "F4_IN", n: "등장", u: "초", d: 0.24 },
    { k: "F4_HOLD", n: "유지", u: "초", d: 0.7 },
    { k: "F4_OUT", n: "퇴장", u: "초", d: 0.36 },
    { k: "F4_DRIFT", n: "퇴장 상승", u: "px", d: 14 },
  ]},
  { g: "떠오르는 문구 · F5 wave", note: "해금 안내 · 납품 완료 — 글자 웨이브", rows: [
    { k: "F5_GAP", n: "칩 위 간격", u: "px", d: 34 },
    { k: "F5_STAGGER", n: "글자 간격", u: "초", d: 0.045 },
    { k: "F5_UP", n: "글자 상승", u: "초", d: 0.16 },
    { k: "F5_RISE", n: "상승 폭", u: "px", d: 14 },
    { k: "F5_BACK", n: "복귀", u: "초", d: 0.18 },
    { k: "F5_HOLD", n: "유지", u: "초", d: 0.5 },
    { k: "F5_OUT", n: "퇴장", u: "초", d: 0.4 },
    { k: "F5_DRIFT", n: "퇴장 상승", u: "px", d: 30 },
  ]},
  { g: "생성기 idle", note: "현재 코드 실측값 — playGeneratorIdle()", rows: [
    { k: "IDLE_BOB", n: "주기", u: "초", d: 0.8 },
    { k: "IDLE_PX", n: "진폭", u: "px", d: 3 },
    { k: "IDLE_SCALE", n: "배율", u: "배", d: 1.05 },
    { k: "E_IDLE", n: "이징", u: "", d: "sineInOut", e: 1 },
  ]},
];
const FX_DEFAULTS = () => { const o = {}; FX_META.forEach((g) => g.rows.forEach((r) => (o[r.k] = r.d))); return o; };
let FX = FX_DEFAULTS();

/* ── 트윈 엔진 ── */
const TW = { list: [], raf: 0 };
function rafLoop(now) {
  TW.raf = 0;
  for (let i = TW.list.length - 1; i >= 0; i--) {
    const a = TW.list[i];
    const k = a.dur <= 0 ? 1 : Math.min(1, (now - a.t0) / a.dur);
    const e = a.ease(k);
    for (const key in a.to) a.state[key] = a.from[key] + (a.to[key] - a.from[key]) * e;
    a.onUpdate(a.state);
    if (k >= 1) { TW.list.splice(i, 1); a.res(); }
  }
  if (TW.list.length) TW.raf = requestAnimationFrame(rafLoop);
}
function kick() { if (!TW.raf) TW.raf = requestAnimationFrame(rafLoop); }
function tw(state, to, durSec, ease, onUpdate) {
  if (REDUCED || durSec <= 0) { Object.assign(state, to); onUpdate(state); return Promise.resolve(); }
  const from = {};
  for (const k in to) from[k] = state[k];
  return new Promise((res) => {
    TW.list.push({ state, from, to, dur: durSec * 1000, ease: EASE[ease] || EASE.linear, t0: performance.now(), onUpdate, res });
    kick();
  });
}
const wait = (sec) => (REDUCED ? Promise.resolve() : new Promise((r) => setTimeout(r, sec * 1000)));

/* ── 생성기 아이들 bob ── */
/* 생성기 까딱임 값을 CSS 변수로 흘린다 — 연출 값을 적용할 때마다 한 번만 쓴다 */
function applyBobVars() {
  const r = document.documentElement.style;
  r.setProperty("--bob-sec", `${Math.max(0.05, FX.IDLE_BOB) * 2}s`);
  r.setProperty("--bob-px", `${FX.IDLE_PX}px`);
  r.setProperty("--bob-s", String(FX.IDLE_SCALE));
}

/* ── 무대 — 보드와 미리보기가 같은 원시 함수를 쓴다 ── */
let FXROOT = { stage: null, fx: null };
function useHost(stageId, fxId) { FXROOT = { stage: $(stageId), fx: $(fxId) }; }
function boxOf(el) {
  const r = el.getBoundingClientRect(), s = FXROOT.stage.getBoundingClientRect();
  return { x: r.left - s.left + r.width / 2, y: r.top - s.top + r.height / 2, w: r.width, h: r.height };
}
function cellBox(i) { useHost("#rwStage", "#rwFx"); return boxOf($("#rwBoard").children[i]); }
function chipAt(i) { const c = $("#rwBoard").children[i]; return c && c.querySelector(".rw-chip"); }

/* 날아가는 칩도 보드에서 보던 그림 그대로여야 한다 — 실루엣, 그리고 생성기라면
   구석 배지(시계·번개)와 배속 색까지 같이 들고 난다. */
function makeFly(code, box, cell) {
  const sp = specOf(code) || {};
  const gen = !!sp.is_generator;
  const mult = S && S.boost ? S.boost : 1;
  const d = document.createElement("div");
  d.className = `rw-fly ${shapeOf(code)}${lenOf(code)}${gen ? " gen m" + mult : ""}`;
  d.style.cssText =
    `--h:${hueOf(code)}deg;width:${box.w}px;height:${box.h}px;left:0;top:0;` +
    `color:hsl(var(--h) 58% 26%)`;
  const spr = spriteOf(code);
  if (spr) {
    const im = document.createElement("img");
    im.className = "a"; im.src = spr; im.alt = labelOf(code); im.decoding = "async";
    d.appendChild(im);
  } else {
    const ft = document.createElement("span");
    ft.className = "t"; ft.textContent = labelOf(code); d.appendChild(ft);
  }
  /* 구석 배지도 그대로 태운다 — 보드에서 보던 배치 그대로다.
     A 우상단 시계(은=충전중 / 금=수확 대기) · B 우하단 번개 또는 오더 체크 · C 좌하단 왕관.
     문서 규칙대로 번개와 체크는 절대 같이 뜨지 않는다. */
  const badge = (cls, txt) => {
    const b = document.createElement("span");
    b.className = cls; b.textContent = txt; d.appendChild(b);
  };
  if (gen) {
    if (cell) {
      if (cell.stock <= 0) badge("rw-bg a", "◷");
      else if (cell.stock >= sp.spread_item_max) badge("rw-bg a gold", "◷");
    }
    badge("rw-bg b", "⚡");
  } else {
    const m = MARKS_CACHE && MARKS_CACHE.get(code);
    if (m) badge("rw-bg b check", "✓");
    if (!sp.merged_item_code) badge("rw-bg c", "♛");
  }
  FXROOT.fx.appendChild(d);
  return d;
}
const place = (el, s) =>
  (el.style.transform = `translate(${s.x - parseFloat(el.style.width) / 2}px, ${s.y - parseFloat(el.style.height) / 2}px) scale(${s.sx ?? s.s ?? 1}, ${s.sy ?? s.s ?? 1})`);

function bezier3(p0, c1, c2, p3, k) {
  const u = 1 - k, a = u * u * u, b = 3 * u * u * k, c = 3 * u * k * k, d = k * k * k;
  return { x: a * p0.x + b * c1.x + c * c2.x + d * p3.x, y: a * p0.y + b * c1.y + c * c2.y + d * p3.y };
}

/* A2 · C4 — 베지어 비행 */
async function flyBezier(code, from, to, opt = {}) {
  const el = makeFly(code, from);
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const lift = Math.max(opt.liftMin ?? FX.LIFT_MIN, dist * (opt.liftRatio ?? FX.LIFT_RATIO));
  const c1 = { x: from.x, y: from.y - lift };
  const c2 = { x: to.x, y: to.y - lift * 0.6 };
  const st = { k: 0, s: opt.s0 ?? FX.FLIGHT_S0, x: from.x, y: from.y };
  const draw = () => { const p = bezier3(from, c1, c2, to, st.k); st.x = p.x; st.y = p.y; place(el, st); };
  draw();
  (async () => {
    await tw(st, { s: opt.sPeak ?? FX.FLIGHT_PEAK }, opt.upSec ?? FX.FLIGHT_SCALE_UP, FX.E_FLIGHT_UP, draw);
    await tw(st, { s: opt.s1 ?? 1 }, opt.downSec ?? FX.FLIGHT_SCALE_DOWN, FX.E_FLIGHT_DOWN, draw);
  })();
  await tw(st, { k: 1 }, opt.dur ?? FX.FLIGHT, FX.E_FLIGHT, draw);
  el.remove();
}

/* ──────────────────────────────────────────────────────────────────────
   연출 노드 풀 — 실제 클라의 `PoolManager` / `PooledObject` 에 대응한다.
   링·스파크·코인·하이라이트는 한 번의 병합/납품에 열 개씩 나고 곧 사라진다.
   매번 createElement 하면 그만큼 GC 가 돌고, 실제 빌드에서는 그게 곧 드로우콜과
   노드 생성 비용이다. 클래스별로 놀고 있는 노드를 들고 있다가 다시 쓴다.

   계약은 PoolManager 와 같다 — `get(종류)` 로 꺼내고 `put(노드)` 로 돌려준다.
   돌려줄 때 인라인 스타일·자식을 비워서 「막 만든 것과 같은 상태」로 되돌린다
   (PooledObject.reset 자리). 통은 종류마다 64개까지만 들고 나머지는 버린다 —
   연출이 한꺼번에 수백 개 날 일이 없어서 그 위는 캐시가 아니라 누수다. */
const FxPool = (() => {
  const bins = new Map();
  const CAP = 64;
  let made = 0, reused = 0, seq = 0;
  function get(cls) {
    const bin = bins.get(cls);
    let el = bin && bin.pop();
    if (el) { reused++; } else { el = document.createElement("div"); made++; }
    el.className = cls;
    el.style.cssText = "";
    /* 세대 번호 — 이게 없으면 재사용이 조용한 버그가 된다.
       하이라이트 맥박처럼 「노드가 붙어 있는 동안」 도는 루프는 노드가 떨어진 걸로
       끝을 안다. 그런데 풀에서 같은 노드가 곧바로 다시 나가면 isConnected 가 다시
       참이 되어 **죽었어야 할 옛 루프가 새 주인의 노드를 계속 굴린다.**
       꺼낼 때마다 번호를 올리고, 루프는 자기 번호가 아니면 그만둔다. */
    el.dataset.gen = String(++seq);
    return el;
  }
  function put(el) {
    if (!el) return;
    el.remove();
    if (el.firstChild) el.replaceChildren();
    const cls = el.className;
    let bin = bins.get(cls);
    if (!bin) bins.set(cls, (bin = []));
    if (bin.length < CAP) bin.push(el);
  }
  const stats = () => ({ made, reused, idle: [...bins].map(([k, v]) => `${k}:${v.length}`).join(" ") });
  return { get, put, stats };
})();

/* 임팩트 링 + 스파크 */
function burst(box, code) {
  const h = hueOf(code);
  const ring = FxPool.get("rw-ring");
  ring.style.cssText = `--h:${h}deg;left:${box.x}px;top:${box.y}px;width:${box.w * 0.7}px;height:${box.w * 0.7}px`;
  FXROOT.fx.appendChild(ring);
  const rs = { s: 0.6, o: 0.9 };
  tw(rs, { s: FX.RING_SCALE, o: 0 }, FX.RING_SEC, "quadOut", () => {
    ring.style.transform = `translate(-50%,-50%) scale(${rs.s})`;
    ring.style.opacity = rs.o;
  }).then(() => FxPool.put(ring));
  const n = Math.max(0, Math.round(FX.SPARKS));
  for (let i = 0; i < n; i++) {
    const sp = FxPool.get("rw-spark");
    sp.style.cssText = `--h:${h}deg;left:${box.x}px;top:${box.y}px`;
    FXROOT.fx.appendChild(sp);
    const ang = (Math.PI * 2 * i) / n + 0.4, dist = FX.SPARK_R;
    const ss = { p: 0, o: 1 };
    tw(ss, { p: 1, o: 0 }, FX.SPARK_SEC, "quadOut", () => {
      sp.style.transform = `translate(calc(-50% + ${Math.cos(ang) * dist * ss.p}px), calc(-50% + ${Math.sin(ang) * dist * ss.p}px)) scale(${1 - ss.p * 0.4})`;
      sp.style.opacity = ss.o;
    }).then(() => FxPool.put(sp));
  }
}

/* A1 — 누름 / 뗌 오버슛 */
async function pressPop(el) {
  if (!el) return;
  el.dataset.busy = "1";
  const s = { sx: 1, sy: 1 };
  const dr = () => (el.style.transform = `scale(${s.sx},${s.sy})`);
  await tw(s, { sx: FX.PRESS_SX, sy: FX.PRESS_SY }, FX.PRESS, FX.E_PRESS, dr);
  await tw(s, { sx: FX.REL_SX, sy: FX.REL_SY }, FX.RELEASE_A, FX.E_PRESS, dr);
  await tw(s, { sx: 1, sy: 1 }, FX.POP_IN, FX.E_POP, dr);
  delete el.dataset.busy;
  el.style.transform = "";
}

/* 착지 스쿼시 / 충전 완료 팝 */
async function squash(el, inX, inY, inSec, outSec) {
  if (!el) return;
  el.dataset.busy = "1";
  const s = { sx: 1, sy: 1 };
  const dr = () => (el.style.transform = `scale(${s.sx},${s.sy})`);
  if (inSec > 0) await tw(s, { sx: inX, sy: inY }, inSec, "quadOut", dr);
  else { s.sx = inX; s.sy = inY; dr(); }
  await tw(s, { sx: 1, sy: 1 }, outSec, FX.E_POP, dr);
  delete el.dataset.busy;
  el.style.transform = "";
}

/* C1 · C5 — 감쇠 흔들림. 등폭 왕복은 진동이지 거부가 아니다.
   문서 봉투: [1, -0.7, 0.45, -0.25, 0] · 앞 네 구간 dur/6 · 마지막 dur/3 */
const SHAKE_ENV = [1, -0.7, 0.45, -0.25, 0];
async function shake(el, amp, dur) {
  if (!el) return;
  amp = amp ?? FX.SHAKE_PX; dur = dur ?? FX.SHAKE;
  el.dataset.busy = "1";
  const s = { x: 0 };
  const dr = () => (el.style.transform = `translateX(${s.x}px)`);
  for (let i = 0; i < SHAKE_ENV.length; i++) {
    const last = i === SHAKE_ENV.length - 1;
    await tw(s, { x: SHAKE_ENV[i] * amp }, last ? dur / 3 : dur / 6, last ? "backOut" : "quadOut", dr);
  }
  delete el.dataset.busy;
  el.style.transform = "";
}

/* 떠오르는 문구 — 패널이 아니라 누른 칩 위로 뜬다. F3 punch / F4 slide / F5 wave */
async function floatText(box, text, style, tone) {
  if (REDUCED) { toast(text); return; }
  const el = document.createElement("div");
  el.className = "rw-float" + (tone ? " " + tone : "");
  FXROOT.fx.appendChild(el);
  const gap = style === "punch" ? FX.F3_GAP : style === "slide" ? FX.F4_GAP : FX.F5_GAP;
  const baseY = box.y - box.h / 2 - gap;
  const st = { y: baseY, s: 1, o: 1 };
  const dr = () => { el.style.left = box.x + "px"; el.style.top = st.y + "px";
                     el.style.transform = `translate(-50%,-50%) scale(${st.s})`; el.style.opacity = st.o; };
  if (style === "punch") {
    el.textContent = text;
    st.s = FX.F3_S0; st.o = 0; dr();
    await tw(st, { s: 1, o: 1, y: baseY - FX.F3_RISE }, FX.F3_IN, "quadOut", dr);
    await tw(st, { s: FX.F3_DIP }, FX.F3_SETTLE / 2, "quadOut", dr);
    await tw(st, { s: 1 }, FX.F3_SETTLE / 2, "backOut", dr);
    await wait(FX.F3_HOLD);
    await tw(st, { o: 0, y: st.y - FX.F3_DRIFT, s: 1.18 }, FX.F3_OUT, "quadIn", dr);
  } else if (style === "slide") {
    el.textContent = text;
    st.y = baseY + FX.F4_FROM; st.o = 0; dr();
    await tw(st, { y: baseY, o: 1 }, FX.F4_IN, "quadOut", dr);
    await wait(FX.F4_HOLD);
    await tw(st, { o: 0, y: baseY - FX.F4_DRIFT }, FX.F4_OUT, "quadOut", dr);
  } else {
    [...text].forEach((ch) => { const i = document.createElement("i"); i.textContent = ch === " " ? "\u00a0" : ch; el.appendChild(i); });
    st.o = 1; dr();
    const gl = [...el.children];
    await Promise.all(gl.map(async (g, i) => {
      await wait(i * FX.F5_STAGGER);
      const gs = { y: 0 };
      const gd = () => (g.style.transform = `translateY(${gs.y}px)`);
      await tw(gs, { y: -FX.F5_RISE }, FX.F5_UP, "quadOut", gd);
      await tw(gs, { y: 0 }, FX.F5_BACK, "backOut", gd);
    }));
    await wait(FX.F5_HOLD);
    await tw(st, { o: 0, y: baseY - FX.F5_DRIFT }, FX.F5_OUT, "quadOut", dr);
  }
  el.remove();
}

/* C2 — 합쳐질 짝에만 링을 켠다. 대상이 바뀔 때만 갱신 */
let HL = [];
function clearHighlights() { HL.forEach((h) => FxPool.put(h)); HL = []; }
function highlightMergeTargets(idx) {
  clearHighlights();
  const from = idx != null ? idx : S.sel;
  if (REDUCED || from == null || !S.cells[from]) return;
  const code = S.cells[from].code;
  if (specOf(code).is_generator) return;
  useHost("#rwStage", "#rwFx");
  S.cells.forEach((c, i) => {
    if (i === from || !c || c.code !== code) return;
    const b = boxOf($("#rwBoard").children[i]);
    const el = FxPool.get("rw-hl");
    el.style.cssText = `left:${b.x}px;top:${b.y}px;width:${b.w - 4}px;height:${b.h - 4}px`;
    FXROOT.fx.appendChild(el); HL.push(el);
    const st = { s: 0.9, o: 0 };
    const dr = () => { el.style.transform = `translate(-50%,-50%) scale(${st.s})`; el.style.opacity = st.o; };
    dr();
    const gen = el.dataset.gen;                       // 이 노드의 이번 생
    const mine = () => el.isConnected && el.dataset.gen === gen;
    tw(st, { s: FX.RING_IN_S, o: 1 }, FX.RING_IN, "backOut", dr).then(async () => {
      while (mine()) {
        await tw(st, { s: FX.PULSE_MAX, o: FX.PULSE_ALPHA }, FX.PULSE_SEC, FX.E_PULSE, dr);
        if (!mine()) break;
        await tw(st, { s: FX.PULSE_MIN, o: 1 }, FX.PULSE_SEC, FX.E_PULSE, dr);
      }
    });
  });
}

/* A6 — 코인이 흩어졌다 HUD 로 빨려 들어가고 카운터가 굴러간다 */
async function coinGather(from) {
  if (REDUCED) return;
  useHost("#rwFrame", "#rwFrameFx");
  const pill = document.querySelector(".rw-pill.coin");
  const to = boxOf(pill);
  const n = Math.max(1, Math.round(FX.COIN_N));
  await Promise.all(Array.from({ length: n }, async (_, i) => {
    await wait(i * FX.COIN_STAGGER);
    const el = FxPool.get("rw-coin");
    FXROOT.fx.appendChild(el);
    const ang = -Math.PI / 2 + (i - (n - 1) / 2) * 0.42;
    const mid = { x: from.x + Math.cos(ang) * FX.SPREAD_R, y: from.y + Math.sin(ang) * FX.SPREAD_R - FX.SPREAD_RISE * 0.2 };
    const st = { x: from.x, y: from.y, s: 1, o: 1 };
    const dr = () => { el.style.left = st.x + "px"; el.style.top = st.y + "px";
                       el.style.transform = `translate(-50%,-50%) scale(${st.s})`; el.style.opacity = st.o; };
    dr();
    await tw(st, { x: mid.x, y: mid.y, s: FX.SPREAD_S }, FX.SPREAD_SEC, "quadOut", dr);
    await tw(st, { x: to.x, y: to.y, s: 0.8 }, FX.TRACE_SEC, "quadIn", dr);
    FxPool.put(el);
  }));
  const ps = { s: 1 };
  const pd = () => (pill.style.transform = `scale(${ps.s})`);
  await tw(ps, { s: FX.HUD_PUNCH }, 0.05, "quadOut", pd);
  await tw(ps, { s: 1 }, FX.HUD_PUNCH_SEC, "backOut", pd);
  pill.style.transform = "";
}

/* C3 — 수확 가능 뱃지. 까딱임이 B2 의 조용한 숨쉬기와 상태를 가른다 */
function readyBadge(i) {
  if (REDUCED) return;
  useHost("#rwStage", "#rwFx");
  const b = boxOf($("#rwBoard").children[i]);
  const el = document.createElement("div");
  el.className = "rw-badge"; el.textContent = "!";
  el.style.cssText = `left:${b.x + b.w * 0.34}px;top:${b.y - b.h * 0.34}px`;
  FXROOT.fx.appendChild(el);
  const st = { s: 0, y: 0 };
  const dr = () => (el.style.transform = `translate(-50%,-50%) translateY(${st.y}px) scale(${st.s})`);
  dr();
  tw(st, { s: 1 }, FX.BADGE_SEC, "backOut", dr).then(async () => {
    const t0 = performance.now();
    while (el.isConnected && performance.now() - t0 < 6000) {
      await tw(st, { y: -FX.BADGE_BOB_PX }, FX.BADGE_BOB, "sineInOut", dr);
      await tw(st, { y: 0 }, FX.BADGE_BOB, "sineInOut", dr);
    }
    el.remove();
  });
}

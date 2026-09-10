/* ==========================================================================
   Rosewood 코어루프 시뮬레이터 — 보드 규칙 (순수)
   --------------------------------------------------------------------------
   실제 클라 대응: `game/ingame/` 의 MVVM 「로직」. 그대로 TypeScript 로 옮기면
   Cocos 쪽 규칙 모듈이 된다.

   이 파일이 지키는 계약 — **뷰도 모델도 모른다**
     · DOM 을 한 줄도 만지지 않는다 (document · $ · 연출 함수 금지)
     · 전역 상태 S 를 직접 읽지 않는다 — 필요한 것은 전부 인자로 받는다
     · 아무것도 변형하지 않는다 — 「무엇을 할지」를 계산해 돌려줄 뿐이다
     · 문구를 만들지 않는다 — 거절 사유는 `reason` 코드로 돌려준다.
       실제 클라에서 이 자리가 Localization.getString(key) 가 된다.

   그래서 이 파일은 브라우저 없이도 검증된다 — 입력 → 출력이 전부다.
   ========================================================================== */
"use strict";

const Rules = {
  /* ── 보드 기하 ────────────────────────────────────────────────────────
     나선 = 「탭한 칸에서 가장 가까운 빈 칸」. 링을 넓혀 가며 처음 만난 빈 칸.        */
  spiralEmpty(cells, from, cols, rows) {
    const r0 = Math.floor(from / cols), c0 = from % cols;
    for (let ring = 0; ring <= Math.max(rows, cols); ring++)
      for (let dr = -ring; dr <= ring; dr++)
        for (let dc = -ring; dc <= ring; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
          const r = r0 + dr, c = c0 + dc;
          if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
          if (!cells[r * cols + c]) return r * cols + c;
        }
    return -1;
  },

  /* 보드 중앙에서 뻗는 고정 나선 — 창고에서 꺼낼 때처럼 「어느 칸에서」가 없는 경우 */
  spiralOrder(cols, rows) {
    const cx = Math.floor(cols / 2), cy = Math.floor(rows / 2), out = [];
    let x = cx, y = cy, dx = 1, dy = 0, len = 1;
    const push = () => { if (x >= 0 && x < cols && y >= 0 && y < rows) out.push(y * cols + x); };
    push();
    while (out.length < cols * rows) {
      for (let s = 0; s < 2; s++) {
        for (let k = 0; k < len; k++) { x += dx; y += dy; push(); }
        [dx, dy] = [-dy, dx];
      }
      len++;
    }
    return out.slice(0, cols * rows);
  },

  /* ── 생산 (생성기 탭) ──────────────────────────────────────────────────
     재고 → 빈칸 → 에너지 → 주머니 순으로 본다. 하나라도 막히면 **아무것도 차감하지
     않고** 사유만 돌려준다. 부스터 배수만큼 재고·에너지를 쓰고 그만큼 위 단계를 뽑는다
     (x2 = 1단계짜리 둘을 합친 것과 같은 결과).                                   */
  produceCheck(ctx) {
    const { cells, cell, spec, energy, boost, now, cols, rows, from } = ctx;
    const mult = boost || 1;
    if (cell.stock <= 0) {
      const wait = Math.max(0, spec.spread_item_recovery_sec - (now - (cell.lastAt || 0)));
      return { ok: false, reason: "recharging", wait };
    }
    if (cell.stock < mult) return { ok: false, reason: "stock_short", need: mult };
    const dest = Rules.spiralEmpty(cells, from, cols, rows);
    if (dest < 0) return { ok: false, reason: "board_full" };
    const cost = spec.spread_cost_energy * mult;
    if (energy < cost) return { ok: false, reason: "energy_short", need: cost };
    const bag = (spec.produce || []).filter((b) => b[0] && b[1] > 0);   // 실물은 20칸까지 · 다른 체인이 나온다
    if (!bag.length) return { ok: false, reason: "bag_empty" };
    return { ok: true, dest, cost, mult, bumps: Math.round(Math.log2(mult)), bag };
  },

  /* 산출 추첨 — 가중치는 상대값이다(정규화 금지, 시트 셀 메모). 부스터 단계만큼 위로 올린다. */
  produceRoll(bag, bumps, specOf, pick) {
    let code = bag[pick(bag.map((b) => b[1]))][0];
    for (let n = 0; n < bumps; n++) {          // 체인 상한에서 멈춘다
      const nx = specOf(code)?.merged_item_code;
      if (!nx) break;
      code = nx;
    }
    return code;
  },

  /* ── 병합 ────────────────────────────────────────────────────────────
     같은 코드 둘 → 다음 단계 하나. 생성기는 안 합쳐지고, 체인 끝은 「최고 단계」 고지.  */
  mergeCheck(A, B, specOf) {
    if (!A) return { ok: false, reason: "no_source" };
    if (!B) return { ok: true, kind: "move" };
    const sp = specOf(A.code);
    if (B.code !== A.code || sp.is_generator) return { ok: false, reason: "mismatch" };
    if (!sp.merged_item_code) return { ok: false, reason: "max_level" };
    return { ok: true, kind: "merge", code: sp.merged_item_code };
  },

  /* ── 판매 / 치우기 ────────────────────────────────────────────────────
     selling_price > 0 → 판매(+코인) · ≤ 0 → 치우기(휴지통, 금액 숨김).
     확인창 여부는 시트 `show_sell_confirm` 이 정본. 그 칸이 통째로 비어 있는 구판
     데이터에서만 판매가 임계로 대신한다 — 값이 하나라도 차면 저절로 시트 기준으로 간다. */
  sellPlan(cell, spec, opt) {
    if (spec.is_generator) return { ok: false, reason: "generator" };
    const price = spec.selling_price || 0;
    return {
      ok: true,
      price,
      trash: price <= 0,                                     // 판매 불가 → 치우기
      confirm: opt.sheetHasConfirm ? !!spec.show_sell_confirm : price >= opt.highValueCoin,
    };
  },

  /* ── 납품 ────────────────────────────────────────────────────────────
     요구 수량을 채울 셀을 **먼저 정하고** 돌려준다. 생성기는 절대 소모하지 않는다.    */
  servePlan(cells, card, specOf, cellCount) {
    const need = new Map();
    card.reqs.forEach((q) => need.set(q.code, (need.get(q.code) || 0) + q.count));
    const counts = new Map();
    for (const c of cells) {
      if (!c) continue;
      if (specOf(c.code)?.is_generator) continue;
      counts.set(c.code, (counts.get(c.code) || 0) + 1);
    }
    const short = [...need].filter(([code, cnt]) => (counts.get(code) || 0) < cnt).map(([code]) => code);
    if (short.length) return { ok: false, reason: "short", short };
    const taken = [];
    for (const [code, cnt] of need) {
      let left = cnt;
      for (let i = 0; i < cellCount && left > 0; i++)
        if (cells[i] && cells[i].code === code && !specOf(code).is_generator) { taken.push({ i, code }); left--; }
    }
    return { ok: true, taken };
  },

  /* ── 레벨 ────────────────────────────────────────────────────────────
     한 번의 획득으로 여러 레벨이 오를 수 있다. 오른 레벨마다 보상 코인을 얹는다.     */
  levelGain(level, exp, gained, lvOf, maxLevel) {
    let lv = level, xp = exp + gained, coin = 0, ups = 0;
    while (lv < maxLevel) {
      const c = lvOf(lv)?.exp_cost ?? Infinity;
      if (xp < c) break;
      xp -= c; lv++; ups++;
      coin += lvOf(lv - 1)?.reward_coin || 0;
    }
    return { level: lv, exp: xp, coin, ups };
  },

  /* ── 오더 만료 ────────────────────────────────────────────────────────
     카드가 발급 시각 + expire_sec 를 넘기면 만료. 만료 초가 0/미지정이면 안 죽는다.  */
  expiredSlots(slots, now) {
    const out = [];
    for (const [n, card] of Object.entries(slots)) {
      if (!card || !card.expireAt) continue;
      if (now >= card.expireAt) out.push(Number(n));
    }
    return out;
  },
};

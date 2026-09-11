/* ==========================================================================
   Rosewood 오더 생성 엔진 — 개발 기획서 1.2.1 의 구현 정본
   ==========================================================================
   두 페이지가 이 파일 하나를 읽는다.

     docs/rosewood-order-bench.html   시뮬레이터 — 사람이 눌러 본다
     docs/rosewood-order-draw.html    테스트    — 연산이 맞는지 본다

   사본을 두지 않는 이유: 테스트 페이지가 자기 사본을 돌리면 시뮬레이터가 쓰는
   코드와 다른 코드를 검증하게 되어, 검증 자체가 성립하지 않는다.

   v2 — 벤치 v4.2(밸런스 시트 실물 이식 · 3자리 · requirement_3)에서 재추출.
   여기 있는 것 — DOM 을 만지지 않고 localStorage 에 쓰지 않는 것만.
     상수·유틸 · 난수(xorshift32) · 실물 데이터 · 세이브 읽기 ·
     유저 상태 · 오더 생성 8단계
   여기 없는 것 — 벤치에 남는다.
     연출 엔진 · 보드 조작 · 렌더 · 아웃게임 · toast · 세이브 쓰기(saveNow/save)

   벤치 v4.2 원본과 다른 곳 — 각 자리에 [GAP] 주석.
     GAP-2  eventScore 가 score_base(coin)·event_id 를 읽는다 (칸 없으면 종전대로 난이도)

   v4.5 — 시트 <b>셀 메모</b>를 뒤늦게 읽고 refill_max 오독을 고쳤다.
     refill_max   「비축 천장」이지 발급 차단이 아니다. 0 을 「발급 경로 없음」으로 읽어
                  주기형 타입이 영구히 안 나오던 것을 고쳤다

   v6.0 — <b>2026-09-11 신판 시트 이행.</b> 데이터가 바뀐 게 아니라 스키마가 바뀌었다.
   「무조건 시트가 답이다」가 기준선이고, 시트에 없는 것은 코드에서도 지운다.
     오더 타입     4종 → 5종. avatar→high · 구 special→random_3 · event→random_4 로
                  <b>개명</b>됐다(밴드 값이 바이트 단위로 동일). 이름이 빈 자리에 새
                  special 이 들어왔는데 이건 다른 물건이다 — refresh_sec 0 · 밴드 0행 ·
                  order_special.trigger_task 로 뜨는 <b>대본형</b>이다. 추첨 경로 밖.
     슬롯          5칸 → 6칸. 1·2 normal / 3 high / 4 random_3 / 5 random_4 / 6 special.
                  const.rail_visible_max = 6 과 일치한다.
     자리          3자리 → <b>2자리</b>. order_slot_band 에서 third_min/third_max 가
                  삭제됐고 order_rule.item_slot_max 는 5행 전부 2 다. 그래서
                  SPEC_ITEM_SLOT_MAX 하드코딩과 opts.itemSlotMax 스위치를 걷었다.
     둘째 자리     second_min 열 자체가 없다 — <b>하한이 없다</b>(0 을 채운 게 아니다).
                  이 열을 그대로 읽으면 seat 2 비교가 undefined 라 조용히 false 가 되고
                  <b>모든 오더가 1종으로 쪼그라든다</b>. seatRange() 한 곳에서 흡수한다.
     누적 난이도    diff_sum_min/max 열 · order_daily_diff_* 상수 셋이 동시에 삭제됐다.
                  축을 통째로 걷었다(dailyDiff 입력 제거).
     반복 감쇠     const.order_repeat_reset_count = 3 이 <b>신설</b>됐다(key_number 10052).
                  v4.5 에서 구판 셀 메모를 근거로 걷어낸 카운터를 되살린다.
     가중치        order_item.weight / weight_multiple 은 클라 계약(A5)에 없는 열이다.
                  신판 export 는 weight_multiple 이 30행 0 이라 곱하면 후보가 통째로
                  죽는다. 가중식은 상황 배수 × ÷제수 만 쓴다 — 이 불일치는 추첨 분석
                  페이지 T13 이 검사로 드러낸다(코드가 조용히 정하지 않는다).

   로드 순서: 이 파일이 페이지 스크립트보다 먼저 와야 한다(DATA · S 를 여기서 선언).
   ========================================================================== */

const COLS = 7, ROWS = 9, CELLS = COLS * ROWS;

/* [삭제됨] SPEC_ITEM_SLOT_MAX — 2026-09-11 신판에서 order_rule.item_slot_max 가
   5행 전부 2 가 되면서 코드가 정본을 들고 있을 이유가 사라졌다. 옛 주석이 적어 둔
   탈출 조건(「시트가 바뀌면 이 상수를 지우고 rule.item_slot_max 하나만 보면 된다」)이
   그대로 충족됐다. 호출자 스위치 opts.itemSlotMax 도 같이 걷었다 —
   시트가 답이면 덮어쓸 자리가 있으면 안 된다. */

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const codeOf = (chain, step) => chain * 100 + step;
const chainOf = (code) => Math.floor(code / 100);
const stepOf = (code) => code % 100;
/* 색은 클러스터가, 무늬는 클러스터 안 순번이 정한다.
   체인이 30개라 체인마다 색을 주면 인접색이 안 갈린다 — 같은 공방 것끼리 같은 색으로
   묶고 그 안에서 테두리 처리로 가른다. 한 클러스터의 체인은 최대 5개라 무늬 12종이 남는다. */
const CLUSTER_HUE = [22, 168, 34, 96, 200, 45, 322, 268, 178, 216];
const hueOfChain = (id) => CLUSTER_HUE[(CHAIN_BY_ID.get(id)?.cluster ?? 0) % CLUSTER_HUE.length];
const hueOf = (code) => hueOfChain(chainOf(code));
const labelOf = (code) => specOf(code)?.name || `#${code}`;
/* 기획서 표기 규칙 「이름 (Lvl N)」 — 칸이 좁아 이름만 그리고 나머지는 title 로 뺀다 */
const titleOf = (code) => {
  const sp = specOf(code); if (!sp) return `#${code}`;
  return `${sp.name} (${chainInfo(code).name} Lv${stepOf(code)})${sp.is_generator ? " · 생성기" : ""}`;
};
/* 생성기 체인(main·sub·quest)은 겹링 — 산출 체인(res)과 한눈에 갈린다 */
const shapeOf = (code) => `rw-shape sh${chainInfo(code).seq % 12}${chainInfo(code).line === "res" ? "" : " gline"}`;
/* 이름이 1~9자로 들쭉날쭉하다. 길수록 글자를 줄인다 */
/* 아이템 아트 — 파일명이 곧 item_code (docs/img/items/<code>.png). 문서 기준 상대경로라
   docs/ 안의 두 페이지(벤치·추첨 분석)에서 똑같이 풀린다.
   폴더 실측 232장(scripts/items2web.py 가 이 목록을 쓴다).
   없는 코드는 지금까지처럼 이름 글자로 그린다.
   ⚠ **아트와 이름이 체인 단위로 어긋난다 — 2026-09-11 신판 시트로도 안 풀렸다.**
      101 은 이름이 「녹슨 못」(Rusty Nail)인데 그림은 커피 원두, 901「산딸기」는 감자,
      1601「꽃가루」는 고무 오리다. 재화·상자(2501~3101)만 정확히 맞는다.
      2026-09-10 커밋 af6a114 로 채워진 8장(211~214 · 813~815 · 1312)도 같은 축이다 —
      211 은 이름이 「정밀 공구 세트」인데 그림은 아이스크림 선디다.
      단순한 번호 밀림이 아니다. string_code 1032행 어디에도 원두·감자·오리·선디가 없다 —
      아트가 **다른 아이템 세트**를 그리고 있다는 뜻이고, 이름 표를 늦게 받아서가 아니다.
      → 칸은 다 찼지만 **그림 내용은 미해결**이다. 아트 쪽 확인이 필요하다
        (실루엣·단계 수·체인 길이는 맞아서 분포 검증에는 지장이 없다). */
const SPRITE_CODES = new Set([101,102,103,104,105,106,107,108,109,110,111,201,202,203,204,205,206,207,208,209,210,211,212,213,214,301,302,303,304,305,306,307,401,402,403,404,405,406,407,408,409,410,411,501,502,503,504,505,506,507,508,509,510,601,602,603,604,605,701,702,703,704,705,706,707,708,709,710,711,801,802,803,804,805,806,807,808,809,810,811,812,813,814,815,901,902,903,904,905,906,907,1001,1002,1003,1004,1005,1006,1007,1008,1009,1010,1101,1102,1103,1104,1105,1106,1107,1201,1202,1203,1204,1205,1206,1207,1208,1209,1210,1211,1301,1302,1303,1304,1305,1306,1307,1308,1309,1310,1311,1312,1501,1502,1503,1504,1505,1506,1507,1508,1509,1510,1511,1601,1602,1603,1604,1605,1606,1607,1608,1609,1610,1611,1701,1702,1703,1704,1705,1706,1707,1801,1802,1803,1804,1805,1806,1807,1901,1902,1903,1904,1905,1906,1907,1908,1909,1910,2001,2002,2003,2004,2005,2006,2101,2102,2103,2104,2105,2106,2107,2108,2109,2110,2201,2301,2302,2303,2304,2305,2306,2307,2308,2309,2310,2401,2402,2403,2404,2405,2406,2501,2502,2601,2602,2701,2702,2703,2704,2705,2801,2802,2803,2804,2901,2902,2903,2904,2905,3001,3101,3102,3103]);
const spriteOf = (code) => (SPRITE_CODES.has(code) ? `img/items/${code}.png` : "");

const lenOf = (code) => { const n = labelOf(code).length; return n <= 3 ? "" : n <= 5 ? " l5" : n <= 7 ? " l7" : " l9"; };
/* 요구·보관 칩 마크업 — 레일·정보바·인벤토리·분포에 같은 조각이 네 번 나온다. 한 군데서 만든다 */
function chipTag(code, cls = "", extra = "") {
  return `<span class="rw-req ${shapeOf(code)}${lenOf(code)}${cls ? " " + cls : ""}" style="--h:${hueOf(code)}deg"`
       + ` title="${titleOf(code)}">${spriteOf(code)
            ? `<img class="a" src="${spriteOf(code)}" alt="${labelOf(code)}" loading="lazy" decoding="async">`
            : `<span class="t">${labelOf(code)}</span>`}${extra}</span>`;
}

/* ======================================================================
   1. 난수 — xorshift32. 상태를 문자열로 직렬화해 카드와 함께 저장한다.
   ====================================================================== */
const RNG = {
  s: 20260910 >>> 0,
  next() { let x = this.s; x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; this.s = x || 1; return this.s; },
  int(n) { if (n <= 1) return 0; const lim = Math.floor(4294967296 / n) * n; let r; do { r = this.next(); } while (r >= lim); return r % n; },
  pick(weights) {
    const sum = weights.reduce((a, b) => a + b, 0);
    if (!(sum > 0)) return 0;
    const r = (this.next() / 4294967296) * sum;
    let acc = 0;
    for (let i = 0; i < weights.length; i++) { acc += weights[i]; if (r < acc) return i; }
    return weights.length - 1;
  },
  save() { return String(this.s); },
  load(v) { this.s = Number(v) >>> 0 || 1; },
};

/* ======================================================================
   2. 데이터 — 확인값 + 시드값(근거 섹션 참조)
   ====================================================================== */
/* ── 실물 시트 데이터 ─────────────────────────────────────────
   출처  [PMM] 밸런스시트.xlsx · 구판 2026-09-08
   생성  _ignore/tools/extract-items.py — 시트가 바뀌면 다시 돌려 통째로 교체한다
   주의  name 은 시트의 에디터 전용 사이드카 칸이다. 실물 런타임은
         item_display.name_key → string_code 를 거친다. 벤치는 문구
         테이블을 안 쓰므로 이름을 직접 박는다.
   ──────────────────────────────────────────────────────────── */
const CLUSTERS = ["C1 공방","C2 티하우스","C3 부엌","C4 정원","C5 리넨","C6 양봉","Q1 클로버","Q2 자수","Q3 웰니스","C0 재화"];
/* [chain_id, chain_key, 이름, 클러스터 index, 클러스터 내 순번, line_type] */
const CHAIN_DB = [
  [1,"M_TOOL","공구함",0,0,"main"],
  [2,"R_TOOL","공구",0,1,"res"],
  [3,"R_PAINT","페인트",0,2,"res"],
  [4,"M_TEA","찻주전자",1,0,"main"],
  [5,"R_TEA","차",1,1,"res"],
  [6,"R_CUP","찻잔",1,2,"res"],
  [7,"M_OVEN","오븐",2,0,"main"],
  [8,"R_BAKE","빵·디저트",2,1,"res"],
  [9,"R_JAM","잼",2,2,"res"],
  [10,"S_SEED","씨앗 상자",3,0,"sub"],
  [11,"R_FLOWER","꽃",3,1,"res"],
  [12,"M_LINEN","리넨 바구니",4,0,"main"],
  [13,"R_LINEN","수건·천",4,1,"res"],
  [15,"M_HIVE","벌통",5,0,"main"],
  [16,"R_HONEY","꿀",5,1,"res"],
  [17,"R_WAX","밀랍",5,2,"res"],
  [18,"Q_CAT","고양이 바구니",6,0,"quest"],
  [19,"R_CAT","고양이",6,1,"res"],
  [20,"Q_SEW","재봉 바구니",7,0,"quest"],
  [21,"R_EMB","자수 소품",7,1,"res"],
  [22,"Q_WAX","밀랍 냄비",8,0,"quest"],
  [23,"R_CANDLE","향초",8,1,"res"],
  [24,"R_SOAP","비누",8,2,"res"],
  [25,"X_BOXR","붉은 상자",0,3,"res"],
  [26,"X_BOXG","초록 상자",0,4,"res"],
  [27,"V_COIN","동전",9,0,"res"],
  [28,"V_GEM","유리알",9,1,"res"],
  [29,"V_SPARK","불씨",9,2,"res"],
  [30,"X_BOXE","불씨 상자",9,3,"res"],
  [31,"X_BOXEV","이벤트 상자",9,4,"res"],
  [32,"X_CH32","Simple Pack",9,5,"res"],
];
/* [코드, 다음, 판매가, show_sell_confirm, 생성기, 이름, name_en, chain_key,
    재고상한, 에너지, 회복초, [[산출코드, 가중치], …]] */
const ITEM_DB = [
  [101,102,0,1,0,"녹슨 못","Rusty Nail","M_TOOL",0,0,0,[]],
  [102,103,0,1,0,"못 상자","Box of Nails","M_TOOL",0,0,0,[]],
  [103,104,1,1,0,"연장 주머니","Tool Pouch","M_TOOL",0,0,0,[]],
  [104,105,2,1,1,"공구함","Toolbox","M_TOOL",80,1,6,[[201,100]]],
  [105,106,3,1,1,"작업대","Workbench","M_TOOL",80,1,180,[[201,37],[301,5]]],
  [106,107,4,1,1,"이동 작업대","Rolling Bench","M_TOOL",80,1,180,[[201,34],[202,2],[203,1],[301,5]]],
  [107,108,5,1,1,"공구 벽","Tool Wall","M_TOOL",80,1,180,[[201,33],[202,3],[203,1],[301,5]]],
  [108,109,6,1,1,"전동 공구대","Power Bench","M_TOOL",80,1,180,[[201,32],[202,4],[203,1],[301,5]]],
  [109,110,7,1,1,"수리 작업장","Repair Bay","M_TOOL",80,1,180,[[201,31],[202,5],[203,1],[301,5]]],
  [110,111,8,1,1,"복원 공방","Restoration Shop","M_TOOL",80,1,180,[[201,31],[202,4],[203,2],[301,5]]],
  [111,0,9,1,1,"마스터 공방","Master Workshop","M_TOOL",80,1,180,[[201,31],[202,4],[203,2],[301,4],[302,1]]],
  [201,202,0,0,0,"나사","Screw","R_TOOL",0,0,0,[]],
  [202,203,0,0,0,"못","Nail","R_TOOL",0,0,0,[]],
  [203,204,0,0,0,"망치","Hammer","R_TOOL",0,0,0,[]],
  [204,205,0,0,0,"드라이버","Screwdriver","R_TOOL",0,0,0,[]],
  [205,206,1,0,0,"펜치","Pliers","R_TOOL",0,0,0,[]],
  [206,207,2,0,0,"렌치","Wrench","R_TOOL",0,0,0,[]],
  [207,208,3,0,0,"톱","Saw","R_TOOL",0,0,0,[]],
  [208,209,4,0,0,"줄자","Tape Measure","R_TOOL",0,0,0,[]],
  [209,210,5,0,0,"전동 드릴","Power Drill","R_TOOL",0,0,0,[]],
  [210,211,6,1,0,"공구 세트","Tool Set","R_TOOL",0,0,0,[]],
  [211,212,7,1,0,"Precision Tool Set","Precision Tool Set","R_TOOL",0,0,0,[]],
  [212,213,8,1,0,"Expert Tool Cabinet","Expert Tool Cabinet","R_TOOL",0,0,0,[]],
  [213,214,9,1,0,"Restoration Cart","Restoration Cart","R_TOOL",0,0,0,[]],
  [214,0,10,1,0,"Master Tool Collection","Master Tool Collection","R_TOOL",0,0,0,[]],
  [301,302,0,0,0,"페인트 붓","Paintbrush","R_PAINT",0,0,0,[]],
  [302,303,0,0,0,"붓 세트","Brush Set","R_PAINT",0,0,0,[]],
  [303,304,1,0,0,"롤러","Paint Roller","R_PAINT",0,0,0,[]],
  [304,305,2,0,0,"페인트 통","Paint Can","R_PAINT",0,0,0,[]],
  [305,306,3,0,0,"색 팔레트","Paint Palette","R_PAINT",0,0,0,[]],
  [306,307,4,0,0,"페인트 세트","Paint Kit","R_PAINT",0,0,0,[]],
  [307,0,5,0,0,"도색 장비","Painting Rig","R_PAINT",0,0,0,[]],
  [401,402,0,1,0,"마른 찻잎","Dried Tea Leaf","M_TEA",0,0,0,[]],
  [402,403,0,1,0,"찻잎 봉지","Tea Pouch","M_TEA",0,0,0,[]],
  [403,404,1,1,0,"찻잎 단지","Tea Caddy","M_TEA",0,0,0,[]],
  [404,405,2,1,0,"찻주전자","Teapot","M_TEA",0,0,0,[]],
  [405,406,3,1,1,"2인 티팟","Two-Cup Pot","M_TEA",26,1,180,[[601,100]]],
  [406,407,4,1,1,"티 카트","Tea Cart","M_TEA",26,1,180,[[601,90],[602,10]]],
  [407,408,5,1,1,"티 트롤리","Tea Trolley","M_TEA",26,1,180,[[601,85],[602,15]]],
  [408,409,6,1,1,"티 스탠드","Tea Stand","M_TEA",26,1,180,[[601,85],[602,10],[603,5]]],
  [409,410,7,1,1,"은주전자","Silver Urn","M_TEA",26,1,180,[[601,82],[602,13],[603,5]]],
  [410,411,8,1,1,"티 바","Tea Bar","M_TEA",26,1,180,[[601,80],[602,15],[603,5]]],
  [411,0,9,1,1,"티 살롱","Tea Salon","M_TEA",26,1,180,[[601,80],[602,15],[603,5],[501,20]]],
  [501,502,0,0,0,"따뜻한 물","Hot Water","R_TEA",0,0,0,[]],
  [502,503,0,0,0,"찻물","Steeped Tea","R_TEA",0,0,0,[]],
  [503,504,1,0,0,"홍차","Black Tea","R_TEA",0,0,0,[]],
  [504,505,2,0,0,"밀크티","Milk Tea","R_TEA",0,0,0,[]],
  [505,506,3,0,0,"레몬티","Lemon Tea","R_TEA",0,0,0,[]],
  [506,507,4,0,0,"허브티","Herbal Tea","R_TEA",0,0,0,[]],
  [507,508,5,1,0,"로즈티","Rose Tea","R_TEA",0,0,0,[]],
  [508,509,6,1,0,"아이스티","Iced Tea","R_TEA",0,0,0,[]],
  [509,510,7,1,0,"버블티","Bubble Tea","R_TEA",0,0,0,[]],
  [510,0,8,1,0,"티포트","Pot of Tea","R_TEA",0,0,0,[]],
  [601,602,0,0,0,"머그","Mug","R_CUP",0,0,0,[]],
  [602,603,0,0,0,"찻잔","Teacup","R_CUP",0,0,0,[]],
  [603,604,1,0,0,"받침 찻잔","Cup and Saucer","R_CUP",0,0,0,[]],
  [604,605,2,0,0,"꽃무늬 찻잔","Floral Teacup","R_CUP",0,0,0,[]],
  [605,0,3,0,1,"설탕 그릇","Dinner Service","R_CUP",12,1,0,[[501,95],[502,5]]],
  [701,702,0,1,0,"장작","Firewood","M_OVEN",0,0,0,[]],
  [702,703,0,1,0,"장작더미","Wood Stack","M_OVEN",0,0,0,[]],
  [703,704,1,1,0,"무쇠 팬","Cast Iron Pan","M_OVEN",0,0,0,[]],
  [704,705,2,1,1,"반죽 그릇","Mixing Bowl","M_OVEN",80,1,2,[[801,100]]],
  [705,706,3,1,1,"화덕","Hearth Oven","M_OVEN",80,1,30,[[801,35],[802,2],[901,5]]],
  [706,707,4,1,1,"벽돌 오븐","Brick Oven","M_OVEN",80,1,180,[[801,34],[802,2],[803,1],[901,5]]],
  [707,708,5,1,1,"제빵 오븐","Baker's Oven","M_OVEN",80,1,180,[[801,33],[802,3],[803,1],[901,5]]],
  [708,709,6,1,1,"2단 오븐","Double Oven","M_OVEN",80,1,180,[[801,32],[802,4],[803,1],[901,5]]],
  [709,710,7,1,1,"제과 오븐","Pastry Oven","M_OVEN",80,1,180,[[801,31],[802,5],[803,1],[901,5]]],
  [710,711,8,1,1,"마을 빵집","Village Bakery","M_OVEN",80,1,180,[[801,31],[802,4],[803,2],[901,5]]],
  [711,0,9,1,1,"베이커리","Bakery Counter","M_OVEN",80,1,180,[[801,31],[802,4],[803,2],[901,4],[902,1]]],
  [801,802,0,0,0,"밀알","Grain","R_BAKE",0,0,0,[]],
  [802,803,0,0,0,"밀가루","Flour","R_BAKE",0,0,0,[]],
  [803,804,0,0,0,"반죽","Dough","R_BAKE",0,0,0,[]],
  [804,805,0,0,0,"롤빵","Bread Roll","R_BAKE",0,0,0,[]],
  [805,806,1,0,0,"스콘","Scone","R_BAKE",0,0,0,[]],
  [806,807,2,0,0,"머핀","Muffin","R_BAKE",0,0,0,[]],
  [807,808,3,0,0,"크루아상","Croissant","R_BAKE",0,0,0,[]],
  [808,809,4,0,0,"도넛","Doughnut","R_BAKE",0,0,0,[]],
  [809,810,5,0,0,"과일 타르트","Fruit Tart","R_BAKE",0,0,0,[]],
  [810,811,6,1,0,"레몬 파이","Lemon Pie","R_BAKE",0,0,0,[]],
  [811,812,7,1,0,"쇼트케이크","Shortcake","R_BAKE",0,0,0,[]],
  [812,813,8,1,0,"3단 케이크","Tiered Cake","R_BAKE",0,0,0,[]],
  [813,814,9,1,0,"Celebration Cake","Celebration Cake","R_BAKE",0,0,0,[]],
  [814,815,10,1,0,"Dessert Cart","Dessert Cart","R_BAKE",0,0,0,[]],
  [815,0,11,1,0,"Dessert Banquet","Dessert Banquet","R_BAKE",0,0,0,[]],
  [901,902,0,0,0,"산딸기","Berry","R_JAM",0,0,0,[]],
  [902,903,0,0,0,"설탕 단지","Sugar Jar","R_JAM",0,0,0,[]],
  [903,904,1,0,0,"딸기잼","Strawberry Jam","R_JAM",0,0,0,[]],
  [904,905,2,0,0,"마멀레이드","Marmalade","R_JAM",0,0,0,[]],
  [905,906,3,0,0,"잼 선물함","Jam Gift Box","R_JAM",0,0,0,[]],
  [906,907,4,0,0,"잼 진열대","Jam Display","R_JAM",0,0,0,[]],
  [907,0,5,0,0,"잼 수레","Jam Cart","R_JAM",0,0,0,[]],
  [1001,1002,0,1,0,"마른 씨앗","Dried Seed","S_SEED",0,0,0,[]],
  [1002,1003,0,1,0,"씨앗 봉지","Seed Packet","S_SEED",0,0,0,[]],
  [1003,1004,1,1,0,"모종판","Seed Tray","S_SEED",0,0,0,[]],
  [1004,1005,2,1,0,"작은 화분","Small Pot","S_SEED",0,0,0,[]],
  [1005,1006,3,1,0,"화분 선반","Pot Shelf","S_SEED",0,0,0,[]],
  [1006,1007,4,1,1,"화단","Flower Bed","S_SEED",6,0,3600,[[1101,10]]],
  [1007,1008,5,1,1,"온상","Cold Frame","S_SEED",8,0,4800,[[1101,90],[1102,10]]],
  [1008,1009,6,1,1,"유리 온실","Glasshouse","S_SEED",10,0,6600,[[1101,80],[1102,20]]],
  [1009,1010,7,1,1,"장미 아치","Rose Arch","S_SEED",12,0,9600,[[1101,75],[1102,25]]],
  [1010,0,8,1,1,"정원 온실","Conservatory","S_SEED",12,0,9600,[[1101,80],[1102,15],[1103,5]]],
  [1101,1102,0,0,0,"새싹","Sprout","R_FLOWER",0,0,0,[]],
  [1102,1103,0,0,0,"모종","Seedling","R_FLOWER",0,0,0,[]],
  [1103,1104,1,0,0,"들꽃","Wildflower","R_FLOWER",0,0,0,[]],
  [1104,1105,2,0,0,"데이지","Daisy","R_FLOWER",0,0,0,[]],
  [1105,1106,3,0,0,"튤립","Tulip","R_FLOWER",0,0,0,[]],
  [1106,1107,4,0,0,"수국","Hydrangea","R_FLOWER",0,0,0,[]],
  [1107,0,5,1,0,"장미","Rose","R_FLOWER",0,0,0,[]],
  [1201,1202,0,1,0,"실 한 타래","Thread Skein","M_LINEN",0,0,0,[]],
  [1202,1203,0,1,0,"천 조각","Fabric Scrap","M_LINEN",0,0,0,[]],
  [1203,1204,1,1,0,"마른 수건","Dry Towel","M_LINEN",0,0,0,[]],
  [1204,1205,2,1,0,"빨래 바구니","Laundry Basket","M_LINEN",0,0,0,[]],
  [1205,1206,3,1,1,"리넨 바구니","Linen Basket","M_LINEN",42,1,180,[[1301,100]]],
  [1206,1207,4,1,1,"리넨 선반","Linen Shelf","M_LINEN",42,1,180,[[1301,95],[1302,5]]],
  [1207,1208,5,1,1,"리넨 장","Linen Cabinet","M_LINEN",42,1,180,[[1301,90],[1302,10]]],
  [1208,1209,6,1,1,"세탁 카트","Laundry Cart","M_LINEN",42,1,180,[[1301,90],[1302,8],[1303,2]]],
  [1209,1210,7,1,1,"다림질대","Ironing Station","M_LINEN",42,1,180,[[1301,89],[1302,8],[1303,3]]],
  [1210,1211,8,1,1,"리넨 창고","Linen Store","M_LINEN",42,1,180,[[1301,88],[1302,9],[1303,3]]],
  [1211,0,9,1,1,"공방 리넨실","Linen Room","M_LINEN",42,1,180,[[1301,87],[1302,9],[1303,4]]],
  [1301,1302,0,0,0,"행주","Dishcloth","R_LINEN",0,0,0,[]],
  [1302,1303,0,0,0,"손수건","Handkerchief","R_LINEN",0,0,0,[]],
  [1303,1304,1,0,0,"냅킨","Napkin","R_LINEN",0,0,0,[]],
  [1304,1305,2,0,0,"수건","Towel","R_LINEN",0,0,0,[]],
  [1305,1306,3,0,0,"자수 냅킨","Embroidered Napkin","R_LINEN",0,0,0,[]],
  [1306,1307,4,0,0,"테이블보","Tablecloth","R_LINEN",0,0,0,[]],
  [1307,1308,5,0,0,"레이스 테이블보","Lace Tablecloth","R_LINEN",0,0,0,[]],
  [1308,1309,6,1,0,"침구 세트","Bedding Set","R_LINEN",0,0,0,[]],
  [1309,1310,7,1,0,"커튼","Curtain","R_LINEN",0,0,0,[]],
  [1310,1311,8,1,0,"자수 커튼","Embroidered Curtain","R_LINEN",0,0,0,[]],
  [1311,1312,9,1,0,"창가 커튼 세트","Window Set","R_LINEN",0,0,0,[]],
  [1312,0,10,1,0,"Rosewood Linen Collection","Rosewood Linen Collection","R_LINEN",0,0,0,[]],
  [1501,1502,0,1,0,"마른 풀","Dry Grass","M_HIVE",0,0,0,[]],
  [1502,1503,0,1,0,"나뭇조각","Wood Chip","M_HIVE",0,0,0,[]],
  [1503,1504,1,1,0,"벌집 조각","Comb Piece","M_HIVE",0,0,0,[]],
  [1504,1505,2,1,0,"작은 벌집","Small Comb","M_HIVE",0,0,0,[]],
  [1505,1506,3,1,1,"벌통","Beehive","M_HIVE",36,1,180,[[1601,100]]],
  [1506,1507,4,1,1,"이단 벌통","Two-Tier Hive","M_HIVE",36,1,180,[[1601,34],[1701,3]]],
  [1507,1508,5,1,1,"삼단 벌통","Three-Tier Hive","M_HIVE",36,1,180,[[1601,33],[1602,1],[1701,5]]],
  [1508,1509,6,1,1,"양봉장","Apiary","M_HIVE",36,1,180,[[1601,34],[1602,1],[1603,1],[1701,6]]],
  [1509,1510,7,1,1,"대형 양봉장","Grand Apiary","M_HIVE",36,1,180,[[1601,33],[1602,2],[1603,1],[1701,6]]],
  [1510,1511,8,1,1,"유리 벌통","Glass Hive","M_HIVE",36,1,180,[[1601,32],[1602,3],[1603,1],[1701,6]]],
  [1511,0,8,1,1,"마을 양봉원","Village Apiary","M_HIVE",36,1,180,[[1601,32],[1602,3],[1603,1],[1701,5],[1702,1]]],
  [1601,1602,0,0,0,"꽃가루","Pollen","R_HONEY",0,0,0,[]],
  [1602,1603,0,0,0,"꿀방울","Honey Drop","R_HONEY",0,0,0,[]],
  [1603,1604,1,0,0,"벌집 꿀","Comb Honey","R_HONEY",0,0,0,[]],
  [1604,1605,2,0,0,"꿀단지","Honey Jar","R_HONEY",0,0,0,[]],
  [1605,1606,3,0,0,"아카시아 꿀","Acacia Honey","R_HONEY",0,0,0,[]],
  [1606,1607,4,0,0,"야생화 꿀","Wildflower Honey","R_HONEY",0,0,0,[]],
  [1607,1608,5,1,0,"밤꿀","Chestnut Honey","R_HONEY",0,0,0,[]],
  [1608,1609,6,1,0,"벌집채 꿀","Honeycomb Jar","R_HONEY",0,0,0,[]],
  [1609,1610,7,1,0,"허니 디퍼","Honey Dipper","R_HONEY",0,0,0,[]],
  [1610,1611,8,1,0,"꿀 선물함","Honey Gift Box","R_HONEY",0,0,0,[]],
  [1611,0,9,1,0,"꿀 진열대","Honey Display","R_HONEY",0,0,0,[]],
  [1701,1702,0,0,0,"밀랍 부스러기","Wax Crumb","R_WAX",0,0,0,[]],
  [1702,1703,0,0,0,"밀랍 조각","Wax Chip","R_WAX",0,0,0,[]],
  [1703,1704,1,0,0,"밀랍 덩이","Wax Block","R_WAX",0,0,0,[]],
  [1704,1705,2,0,0,"정제 밀랍","Refined Wax","R_WAX",0,0,0,[]],
  [1705,1706,3,1,0,"밀랍 시트","Wax Sheet","R_WAX",0,0,0,[]],
  [1706,1707,4,1,0,"밀랍 블록","Wax Bar","R_WAX",0,0,0,[]],
  [1707,0,5,1,0,"밀랍 상자","Wax Box","R_WAX",0,0,0,[]],
  [1801,1802,0,0,0,"방석","Cushion","Q_CAT",0,0,0,[]],
  [1802,1803,0,0,0,"담요","Blanket","Q_CAT",0,0,0,[]],
  [1803,1804,1,0,0,"바구니","Basket","Q_CAT",0,0,0,[]],
  [1804,1805,2,0,1,"고양이 바구니","Cat Basket","Q_CAT",6,1,9000,[[1901,100]]],
  [1805,1806,3,0,1,"캣 하우스","Cat House","Q_CAT",8,1,14400,[[1901,90],[1902,10]]],
  [1806,1807,4,0,1,"캣 타워","Cat Tower","Q_CAT",10,1,19800,[[1901,80],[1902,15],[1903,5]]],
  [1807,0,5,0,1,"대형 캣 타워","Grand Cat Tower","Q_CAT",12,1,21600,[[1901,70],[1902,20],[1903,10]]],
  [1901,1902,0,0,0,"아기 고양이","Kitten","R_CAT",0,0,0,[]],
  [1902,1903,0,0,0,"턱시도","Tuxedo","R_CAT",0,0,0,[]],
  [1903,1904,0,0,0,"치즈태비","Ginger Tabby","R_CAT",0,0,0,[]],
  [1904,1905,1,0,0,"삼색이","Calico","R_CAT",0,0,0,[]],
  [1905,1906,2,0,0,"러시안 블루","Russian Blue","R_CAT",0,0,0,[]],
  [1906,1907,3,0,0,"브리티시 숏헤어","British Shorthair","R_CAT",0,0,0,[]],
  [1907,1908,4,0,0,"페르시안","Persian","R_CAT",0,0,0,[]],
  [1908,1909,5,0,0,"메인쿤","Maine Coon","R_CAT",0,0,0,[]],
  [1909,1910,6,0,0,"노르웨이숲","Norwegian Forest","R_CAT",0,0,0,[]],
  [1910,0,7,0,0,"스핑크스","Sphynx","R_CAT",0,0,0,[]],
  [2001,2002,0,0,0,"실 감개","Bobbin","Q_SEW",0,0,0,[]],
  [2002,2003,0,0,0,"바늘쌈","Needle Book","Q_SEW",0,0,0,[]],
  [2003,2004,1,0,1,"재봉 바구니","Sewing Basket","Q_SEW",4,1,3600,[[2101,10]]],
  [2004,2005,2,0,1,"반짇고리","Sewing Box","Q_SEW",6,1,7200,[[2101,90],[2102,10]]],
  [2005,2006,3,0,1,"재봉 상자","Sewing Chest","Q_SEW",8,1,10800,[[2101,80],[2102,15],[2103,5]]],
  [2006,0,4,0,1,"재봉 장","Sewing Cabinet","Q_SEW",10,1,14400,[[2101,75],[2102,15],[2103,10]]],
  [2101,2102,0,0,0,"단추","Button","R_EMB",0,0,0,[]],
  [2102,2103,0,0,0,"리본","Ribbon","R_EMB",0,0,0,[]],
  [2103,2104,0,0,0,"레이스","Lace","R_EMB",0,0,0,[]],
  [2104,2105,1,0,0,"자수 천","Embroidery Cloth","R_EMB",0,0,0,[]],
  [2105,2106,2,0,0,"자수 손수건","Embroidered Hanky","R_EMB",0,0,0,[]],
  [2106,2107,3,0,0,"자수 쿠션","Embroidered Cushion","R_EMB",0,0,0,[]],
  [2107,2108,4,0,0,"자수 액자","Embroidery Frame","R_EMB",0,0,0,[]],
  [2108,2109,5,0,0,"자수 벽걸이","Wall Hanging","R_EMB",0,0,0,[]],
  [2109,2110,6,0,0,"자수 커버","Embroidered Cover","R_EMB",0,0,0,[]],
  [2110,0,7,0,0,"자수 액자 세트","Frame Set","R_EMB",0,0,0,[]],
  [2201,0,-1,0,1,"밀랍 냄비","Wax Pot","Q_WAX",6,1,7200,[[2301,12],[2401,1]]],
  [2301,2302,0,0,0,"초 토막","Candle Stub","R_CANDLE",0,0,0,[]],
  [2302,2303,0,0,0,"양초","Candle","R_CANDLE",0,0,0,[]],
  [2303,2304,0,0,0,"유리 캔들","Glass Candle","R_CANDLE",0,0,0,[]],
  [2304,2305,1,0,0,"향초","Scented Candle","R_CANDLE",0,0,0,[]],
  [2305,2306,2,0,0,"라벤더 캔들","Lavender Candle","R_CANDLE",0,0,0,[]],
  [2306,2307,3,0,0,"3심 캔들","Three-Wick Candle","R_CANDLE",0,0,0,[]],
  [2307,2308,4,0,0,"캔들 홀더","Candle Holder","R_CANDLE",0,0,0,[]],
  [2308,2309,5,0,0,"랜턴","Lantern","R_CANDLE",0,0,0,[]],
  [2309,2310,6,0,0,"캔들 세트","Candle Set","R_CANDLE",0,0,0,[]],
  [2310,0,7,0,0,"캔들 선물함","Candle Gift Box","R_CANDLE",0,0,0,[]],
  [2401,2402,0,0,0,"비누 조각","Soap Sliver","R_SOAP",0,0,0,[]],
  [2402,2403,0,0,0,"비누","Soap Bar","R_SOAP",0,0,0,[]],
  [2403,2404,1,0,0,"꽃비누","Flower Soap","R_SOAP",0,0,0,[]],
  [2404,2405,2,0,0,"허브 비누","Herbal Soap","R_SOAP",0,0,0,[]],
  [2405,2406,3,0,0,"배스밤","Bath Bomb","R_SOAP",0,0,0,[]],
  [2406,0,4,0,0,"비누 선물함","Soap Gift Box","R_SOAP",0,0,0,[]],
  [2501,2502,-1,0,0,"붉은 상자","Red Chest","X_BOXR",8,0,0,[[701,2],[101,1],[401,1],[2701,2],[2801,2]]],
  [2502,0,-1,0,0,"붉은 장식 상자","Fancy Red Chest","X_BOXR",12,0,0,[[702,2],[102,1],[402,1],[2701,1],[2801,1],[2702,3],[2802,3]]],
  [2601,2602,-1,0,0,"초록 상자","Green Chest","X_BOXG",8,0,0,[[1501,2],[1001,1],[1201,1],[2701,2],[2801,2]]],
  [2602,0,-1,0,0,"초록 장식 상자","Fancy Green Chest","X_BOXG",12,0,0,[[1502,2],[1002,1],[1202,1],[2701,1],[2801,1],[2702,3],[2802,3]]],
  [2701,2702,-1,0,0,"동전 한 닢","A Coin","V_COIN",0,0,0,[]],
  [2702,2703,-1,0,0,"동전 두 닢","A Couple of Coins","V_COIN",0,0,0,[]],
  [2703,2704,-1,0,0,"잔돈","Spare Coins","V_COIN",0,0,0,[]],
  [2704,2705,-1,0,0,"동전 더미","Stack of Coins","V_COIN",0,0,0,[]],
  [2705,0,-1,0,0,"돈주머니","Coin Purse","V_COIN",0,0,0,[]],
  [2801,2802,-1,0,0,"유리알 하나","A Single Gem","V_GEM",0,0,0,[]],
  [2802,2803,-1,0,0,"유리알 둘","Couple of Gems","V_GEM",0,0,0,[]],
  [2803,2804,-1,0,0,"유리알 몇 개","A Few Gems","V_GEM",0,0,0,[]],
  [2804,0,-1,0,0,"유리알 한 줌","Handful of Gems","V_GEM",0,0,0,[]],
  [2901,2902,-1,0,0,"불씨","Zap of Energy","V_SPARK",0,0,0,[]],
  [2902,2903,-1,0,0,"잉걸불","Blast of Energy","V_SPARK",0,0,0,[]],
  [2903,2904,-1,0,0,"화로 불꽃","Punch of Energy","V_SPARK",0,0,0,[]],
  [2904,2905,-1,0,0,"타오르는 화로","Shock of Energy","V_SPARK",0,0,0,[]],
  [2905,0,-1,0,0,"큰 화덕불","Big Bolt of Energy","V_SPARK",0,0,0,[]],
  [3001,0,-1,0,0,"불씨 상자","Energy Chest","X_BOXE",5,0,0,[[2901,40],[2902,30],[2903,20],[2904,10]]],
  [3101,3102,-1,0,0,"작은 이벤트 상자","Small Event Chest","X_BOXEV",6,0,0,[[805,4],[806,1],[903,2],[2803,1]]],
  [3102,3103,-1,0,0,"이벤트 상자","Event Chest","X_BOXEV",8,0,0,[[806,3],[807,2],[903,1],[904,2],[2803,1],[2804,1]]],
  [3103,0,-1,0,0,"큰 이벤트 상자","Grand Event Chest","X_BOXEV",10,0,0,[[806,2],[807,2],[904,4],[2804,1]]],
  [3201,3202,-1,0,0,"Simple Pack","Simple Pack","X_CH32",5,0,0,[[2701,4],[2901,6]]],
  [3202,0,-1,0,0,"Fancy Pack","Fancy Pack","X_CH32",11,0,0,[[2701,8],[2702,2],[2901,10],[2902,2]]],
];
/* [item_code, unlock_level, order_price, diff_score, repeat_weight_decrease]
   A5 계약 컬럼 그대로. weight·weight_multiple 은 계약에 없어 싣지 않는다 */
const ORDER_DB = [
  [203,3,2,3,0],
  [204,3,4,5,0],
  [205,3,8,10,0],
  [206,3,14,21,0],
  [207,3,24,42,0],
  [208,3,36,84,0],
  [209,3,56,154,10],
  [210,3,88,307,50],
  [303,4,8,14,0],
  [304,4,14,27,0],
  [305,6,24,55,10],
  [306,15,41,110,50],
  [307,20,62,220,100],
  [503,6,8,7,0],
  [504,6,14,15,0],
  [505,7,24,30,0],
  [506,10,36,60,0],
  [507,15,56,120,0],
  [508,21,88,239,10],
  [509,26,132,479,50],
  [510,31,202,957,100],
  [603,7,2,2,0],
  [604,7,4,5,0],
  [803,1,2,2,0],
  [804,1,4,5,0],
  [805,1,8,10,0],
  [806,1,12,19,0],
  [807,1,20,39,0],
  [808,1,32,78,0],
  [809,1,50,146,10],
  [810,1,78,293,50],
  [811,1,118,585,100],
  [812,1,178,1170,0],
  [903,2,8,11,0],
  [904,2,14,23,0],
  [905,5,24,46,10],
  [906,15,38,92,50],
  [907,20,58,184,100],
  [1103,9,8,9,0],
  [1104,9,14,18,0],
  [1105,9,24,35,10],
  [1106,9,36,70,50],
  [1107,25,54,140,100],
  [1303,10,8,3,0],
  [1304,10,14,7,0],
  [1305,10,24,13,0],
  [1306,10,36,27,0],
  [1307,21,56,58,0],
  [1308,26,88,91,0],
  [1309,31,132,183,10],
  [1310,36,202,366,50],
  [1311,41,304,731,100],
  [1603,9,8,3,0],
  [1604,9,14,6,0],
  [1605,9,24,13,0],
  [1606,9,36,26,0],
  [1607,18,56,52,0],
  [1608,21,88,88,0],
  [1609,26,132,176,10],
  [1610,31,202,352,50],
  [1611,31,318,704,100],
  [1703,9,12,12,0],
  [1704,15,22,24,0],
  [1705,21,34,48,10],
  [1706,31,54,97,50],
  [1707,41,86,194,100],
  [1903,4,2,2,0],
  [1904,4,4,5,0],
  [1905,4,8,10,0],
  [1906,4,12,19,0],
  [1907,4,20,39,0],
  [1908,4,32,78,10],
  [1909,4,50,146,50],
  [1910,4,78,293,100],
  [2103,10,2,2,0],
  [2104,10,4,5,0],
  [2105,10,8,10,0],
  [2106,10,12,19,0],
  [2107,10,20,39,0],
  [2108,10,32,78,10],
  [2109,10,50,146,50],
  [2110,10,78,293,100],
  [2303,24,2,2,0],
  [2304,24,4,5,0],
  [2305,24,8,10,0],
  [2306,24,12,19,0],
  [2307,24,20,39,0],
  [2308,24,32,78,10],
  [2309,24,50,146,50],
  [2310,24,78,293,100],
  [2403,24,2,2,0],
  [2404,24,4,5,10],
  [2405,24,8,10,50],
  [2406,24,12,19,100],
  [211,3,132,617,100],
  [212,3,202,1229,0],
  [213,3,304,2000,0],
  [214,3,458,2500,0],
  [813,1,270,2000,0],
  [814,1,406,2500,0],
  [815,1,612,3000,0],
  [1312,41,458,1463,0],
];
/* [order_type, slot_count, item_slot_max, refresh_sec, unlock_level, refill_max] */
const RULE_DB = [
  ["normal",2,2,3600,3,5],
  ["special",1,2,0,4,0],
  ["high",1,2,1800,3,1],
  ["random_3",1,2,900,4,1],
  ["random_4",1,2,300,5,1],
];
/* [order_type, band_seq, level_min, level_max, first_min, first_max, second_max]
   둘째 자리는 하한이 없다. diff_sum_*·third_* 는 신판에서 삭제된 열이다 */
const BAND_DB = [
  ["normal",1,0,15,0,6,4],
  ["normal",2,16,30,0,6,5],
  ["high",1,0,15,7,7,5],
  ["high",2,16,30,7,7,6],
  ["random_3",1,0,7,6,7,4],
  ["random_3",2,8,15,7,8,4],
  ["random_3",3,16,29,7,9,6],
  ["random_3",4,30,30,7,10,6],
  ["random_4",1,0,7,7,8,4],
  ["random_4",2,8,15,7,9,5],
  ["random_4",3,16,29,7,10,6],
  ["random_4",4,30,30,8,11,7],
];
/* [level, item_count, count_weight] — 종수는 1·2 뿐이다 */
const COUNT_DB = [
  [1,1,7500],
  [1,2,2500],
  [4,1,5714],
  [4,2,4286],
  [8,1,5000],
  [8,2,5000],
  [11,1,5000],
  [11,2,5000],
];
/* [fixed_seq, unlock_level, slot_1, slot_2, requirement_1, requirement_2]
   slot_3 · requirement_3 은 신판에서 삭제됐다 */
const FIXED_DB = [
  [1,1,1,0,803,0],
  [2,1,1,0,808,0],
  [3,1,1,0,804,0],
  [4,1,1,0,806,0],
  [5,2,1,2,904,0],
  [6,2,1,2,903,0],
  [7,2,1,2,903,806],
  [8,2,1,2,905,0],
  [9,2,1,2,808,0],
  [10,2,1,2,805,903],
  [11,3,1,2,204,204],
  [12,3,1,2,805,205],
  [13,3,1,2,205,203],
  [14,4,1,2,303,0],
  [15,4,3,0,207,804],
  [16,4,1,2,806,304],
];
/* [avatar_key, open_day] — unlock_level 은 에디터 전용 열이 됐다.
   신판에서 order_avatar 는 오더 타입이 아니라 「손님 초상 테이블」이다 */
const AVATAR_DB = [
  ["Poppy",999],
  ["Hazel",999],
  ["Tess",999],
  ["Ada",1],
  ["Milo",1],
  ["June",1],
  ["Otis",1],
  ["Pip",1],
  ["Loren",1],
  ["Izzy",2],
  ["Barnett",3],
  ["Della",16],
  ["Nora",19],
];
/* [level, exp_cost] */
/* [event_id, band_seq, score_base, score_min, score_max, token_pct, token_fix]
   실물 시트다. 예전엔 「자리를 채우는 임시값」 5행을 손으로 박아 뒀는데, 그 바람에
   벤치와 「오더 추첨 분석」의 이벤트 점수가 갈렸다(Lv30 에서 94 대 24). 이제 같은 표를 본다. */
const EVENT_DB = [
  [120002,1,"coin",0,9999,2500,0],
  [120004,1,"coin",0,9999,0,0],
  [120003,1,"coin",0,9999,2500,0],
  [120008,1,"coin",0,9999,2500,0],
  [120009,1,"coin",0,9999,0,0],
];
/* [special_no, chain_key, start_item_code, avatar_key, trigger_task, duration_sec, in_use]
   특별주문 대본. 추첨이 아니라 chore 완료(trigger_task)로 열린다 — 슬롯 6 의 발급 경로다. */
const SPECIAL_DB = [
  [1,"Q_CAT",1804,"Poppy","T_TASK_2_7",0,1],
  [2,"Q_WAX",2201,"Hazel","T_TASK_8_9",0,1],
  [3,"Q_SEW",2003,"Tess","none",0,0],
];
const LEVEL_DB = [
  [1,15],
  [2,30],
  [3,45],
  [4,60],
  [5,60],
  [6,75],
  [7,75],
  [8,75],
  [9,75],
  [10,75],
  [11,90],
  [12,90],
  [13,90],
  [14,105],
  [15,105],
  [16,105],
  [17,120],
  [18,120],
  [19,120],
  [20,120],
  [21,120],
  [22,120],
  [23,120],
  [24,120],
  [25,135],
  [26,135],
  [27,135],
  [28,135],
  [29,150],
  [30,150],
];
/* [slot_index, cost_type, unlock_cost] */
const INV_DB = [
  [6,"gem",50],
  [7,"gem",55],
  [8,"gem",65],
  [9,"gem",80],
  [10,"gem",100],
  [11,"gem",130],
  [12,"gem",165],
  [13,"gem",225],
  [14,"gem",305],
  [15,"gem",420],
  [16,"gem",580],
  [17,"gem",805],
  [18,"gem",1125],
  [19,"gem",1580],
  [20,"gem",2215],
  [21,"gem",3125],
  [22,"gem",4400],
  [23,"gem",6210],
  [24,"gem",8770],
  [25,"gem",12390],
  [26,"gem",17510],
  [27,"gem",24750],
  [28,"gem",34990],
  [29,"gem",49470],
  [30,"gem",69950],
  [31,"gem",69950],
  [32,"gem",69950],
];
/* const 탭 전 행 */
const CONST_DB = {
  "default_max_energy": 100,
  "default_recovery_duration_sec": 120,
  "board_row": 9,
  "board_column": 7,
  "order_weight_mult_required_enough": 100,
  "order_weight_mult_not_required": 1000,
  "order_weight_mult_higher_level": 10000,
  "nru_start_coin": 100,
  "nru_start_gem": 0,
  "nru_start_energy": 100,
  "coin_max_limit": 999999999,
  "gem_max_limit": 999999999,
  "inventory_slot_default": 5,
  "inventory_slot_max": 32,
  "item_sell_refund_rate": 10000,
  "daily_reset_utc_sec": 0,
  "weekly_reset_cycle_day": 7,
  "weekly_reset_weekday": 1,
  "event_ranking_display_max": 10,
  "auto_save_max_sec": 259200,
  "chore_extra_trigger_limit": 100,
  "chore_extra_cold_day": 2,
  "chore_extra_duration_hour": 24,
  "chore_extra_reward_energy": 30,
  "score_race_group_size": 50,
  "score_race_merge_score_rate": 10000,
  "shop_refresh_cycle_sec": 28800,
  "shop_special_stock_per_slot": 1,
  "shop_hot_sale_stock_per_slot": 5,
  "shop_gem_only_max_level": 2,
  "offer_popup_min_interval_sec": 120,
  "starter_offer_popup_cooldown_sec": 14400,
  "rail_visible_max": 6,
  "daily_ad_total_cap": 15,
  "energy_gem_reset_utc_sec": 0,
  "rv_fail_toast_sec": 3,
  "net_retry_max": 2,
  "net_retry_backoff_sec": 2,
  "net_timeout_sec": 8,
  "iap_wait_threshold_sec": 5,
  "undo_valid_sec": 5,
  "rv_coin_rescue_pct": 50,
  "rv_token_boost_orders": 3,
  "rv_inventory_temp_slot_sec": 86400,
  "toast_show_sec": 1.5,
  "order_repeat_reset_count": 3,
  "round_race_group_size": 5
};

/* 체인 사전 — 색(클러스터)·무늬(클러스터 안 순번)·이름을 전부 여기서 판다 */
const CHAINS = CHAIN_DB.map(([id, key, name, cluster, seq, line]) => ({ id, key, name, cluster, seq, line }));
const CHAIN_BY_ID = new Map(CHAINS.map((c) => [c.id, c]));
const NO_CHAIN = { id: 0, key: "?", name: "?", cluster: 0, seq: 0, line: "res" };
const chainInfo = (code) => CHAIN_BY_ID.get(chainOf(code)) || NO_CHAIN;
const chainName = (id) => CHAIN_BY_ID.get(id)?.name || `#${id}`;

/* item_spec — 시트 행을 그대로 편다. 파생식을 쓰지 않는다.
   생성기는 체인의 1단계가 아니라 중간~끝 여러 단계에 있고(M_TOOL 은 11단계 중 s4~s11),
   자기 체인이 아니라 다른 체인을 낳는다(공구함 → 공구·페인트). 그래서 produce 는
   「어느 코드를 얼마의 가중치로」 짝지은 배열이지, 자기 체인 s2~s4 가 아니다. */
function buildItemSpec() {
  return ITEM_DB.map(([item_code, merged_item_code, selling_price, show_sell_confirm, is_generator,
                       name, name_en, chain_key, spread_item_max, spread_cost_energy,
                       spread_item_recovery_sec, produce]) => ({
    item_code, merged_item_code, selling_price, show_sell_confirm, is_generator, name, name_en, chain_key,
    spread_item_max, spread_cost_energy, spread_item_recovery_sec, produce,
  }));
}
/* order_item — 주문 후보 102종. 생성기·상자·재화는 애초에 이 표에 없다.
   unlock_level 은 단계가 아니라 체인 단위다 — Lv3 이 되면 망치부터 공구 세트까지
   여러 종이 한꺼번에 후보가 된다.
   weight / weight_multiple 은 <b>싣지 않는다</b> — 클라 계약(A5)에 없는 에디터 열이고,
   신판 export 는 weight_multiple 이 30행 0 이라 곱하면 그 30종이 영구히 안 나온다.
   열이 시트에 살아 있는 것과 계약에 있는 것은 다른 문제라, 판정은 코드가 아니라
   추첨 분석 페이지 T13 이 한다. */
function buildOrderItem() {
  return ORDER_DB.map(([item_code, unlock_level, order_price, diff_score,
                        repeat_weight_decrease]) => ({
    item_code, unlock_level, order_price, diff_score,
    repeat_weight_decrease, in_use: 1,
  }));
}

const DEFAULTS = () => ({
  /* const 47행 통째로 실물이다. 신판에서 order_daily_diff_band_1/2 ·
     order_daily_diff_reset_utc_sec 이 삭제되고 order_repeat_reset_count(3) ·
     round_race_group_size(5) 가 신설됐다. 안 쓰는 칸은 그대로 둔다 —
     무엇을 아직 안 만졌는지가 여기서 드러난다. */
  const: { ...CONST_DB },
  /* 인벤토리 확장 27행 (6칸 → 32칸) — 실물 시트값. 등비 √2 곡선이라 코드로 다시 만들지 않는다 */
  inventory_unlock: INV_DB.map(([slot_index, cost_type, unlock_cost]) =>
    ({ slot_index, cost_type, unlock_cost, in_use: 1 })),
  order_rule: RULE_DB.map(([order_type, slot_count, item_slot_max, refresh_sec, unlock_level, refill_max]) =>
    ({ order_type, slot_count, item_slot_max, refresh_sec, unlock_level, refill_max, in_use: 1 })),
  /* 신판 밴드는 first_min · first_max · second_max 셋뿐이다.
     second_min 을 0 으로 채워 넣지 않는다 — 「하한이 없다」와 「하한이 0 이다」는
     다른 말이고, 자리 수를 세는 쪽(seatRange)이 열의 유무로 판본을 가린다. */
  order_slot_band: BAND_DB.map(([order_type, band_seq, level_min, level_max,
                                 first_min, first_max, second_max]) =>
    ({ order_type, band_seq, level_min, level_max,
       first_min, first_max, second_max, in_use: 1 })),
  /* 이벤트 점수 — 규칙은 기획서 1.2.1 [5], 값은 실물 시트다.
     score_base 칸이 「coin」이라 기준값은 난이도가 아니라 코인이다. */
  event_order_score: EVENT_DB.map(([event_id, band_seq, score_base, score_min, score_max, token_pct, token_fix]) =>
    ({ event_id, band_seq, score_base, score_min, score_max, token_pct, token_fix, in_use: 1 })),
  /* 특별주문 대본 — 슬롯 6 은 추첨이 아니라 이 표의 trigger_task 로 열린다 */
  order_special: SPECIAL_DB.map(([special_no, chain_key, start_item_code, avatar_key, trigger_task, duration_sec, in_use]) =>
    ({ special_no, chain_key, start_item_code, avatar_key, trigger_task, duration_sec, in_use })),
  order_item_count: COUNT_DB.map(([level, item_count, count_weight]) =>
    ({ level, item_count, count_weight, in_use: 1 })),
  /* requirement_3 은 신판에서 삭제됐다. slot_3 열은 남아 있지만 16행 전부 0 이라
     3슬롯 신호로 읽으면 안 된다 — 튜플에서 빼고 fixedSlots() 가 흡수한다. */
  order_fixed: FIXED_DB.map(([fixed_seq, unlock_level, slot_1, slot_2,
                              requirement_1, requirement_2]) =>
    ({ fixed_seq, unlock_level, slot_1, slot_2,
       requirement_1, requirement_2, in_use: 1 })),
  /* 손님 13명 — 신판 order_avatar 는 오더 <b>타입</b>이 아니라 초상 테이블이다.
     걸리는 칸은 open_day 하나뿐(unlock_level 은 에디터 전용 열이 됐다). */
  order_avatar: AVATAR_DB.map(([avatar_key, open_day]) =>
    ({ avatar_key, open_day, in_use: 1 })),
  /* 레벨 30단계 실물 exp_cost. reward_coin 은 시트에 없다 —
     실물은 reward_item_key_1~3(아이템 지급)이고 코인 보상 칸이 아니다.
     벤치는 레벨업 체감만 필요해 임시 코인을 얹는다. 확인 필요. */
  level_curve: LEVEL_DB.map(([level, exp_cost]) => ({ level, exp_cost, reward_coin: 40 + (level - 1) * 12 })),
  item_spec: buildItemSpec(),
  order_item: buildOrderItem(),
});

let DATA = DEFAULTS();
/* 조회는 인덱스로 — 보드 한 번 그릴 때 specOf 가 수백 번 불린다.
   DATA 를 통째로 갈아끼울 때만 인덱스를 버린다(reindex). */
let IDX = null;
function reindex() {
  IDX = {
    spec: new Map(DATA.item_spec.map((r) => [r.item_code, r])),
    oi: new Map(DATA.order_item.map((o) => [o.item_code, o])),
    rule: new Map(DATA.order_rule.filter((r) => r.in_use).map((r) => [r.order_type, r])),
    lv: new Map(DATA.level_curve.map((l) => [l.level, l])),
  };
  return IDX;
}
const idx = () => IDX || reindex();
const specOf = (code) => idx().spec.get(code);
const oiOf = (code) => idx().oi.get(code);
const lvOf = (level) => idx().lv.get(level);

/* ======================================================================
   2b. 저장 — 읽기만. 쓰기(saveNow/save)는 벤치에 남는다.
   ====================================================================== */
const BUILD = "v6.1 · 2026-09-11";   // RepeatDecay 로 반복 감쇠 일원화 · slotMap 메모이즈
const SAVE_KEY = "rw.orderBench";
/* 4 → 5: 슬롯이 5칸에서 6칸이 되고 타입 이름이 바뀌었다. 옛 세이브의 slots 는
   키(슬롯 번호)가 다른 타입을 가리키게 되므로 이관하지 않고 버린다. */
const SAVE_VER = 5;

function loadSaved() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || o.v !== SAVE_VER || !o.state) return null;              // data 는 null 이 정상이다
    if (!Array.isArray(o.state.cells) || o.state.cells.length !== CELLS) return null;
    if (o.data && (!Array.isArray(o.data.order_rule) || !Array.isArray(o.data.item_spec))) return null;
    o.state.log = (o.state.log || []).map((e) => ({ ...e, t: new Date(e.t) }));
    return o;
  } catch (e) { return null; }
}
function clearSaved() { try { localStorage.removeItem(SAVE_KEY); } catch (e) {} }

/* ======================================================================
   3. 유저 상태
   ====================================================================== */
let S;
function freshState() {
  const cells = new Array(CELLS).fill(null);
  /* 생성기는 체인의 1단계가 아니다. 생성기 체인(main·sub)마다 「가장 낮은 생성기」를
     찾아 앉힌다 — 공구함 104 · 2인 티팟 405 · 반죽 그릇 704 · 화단 1006 …
     quest 체인은 퀘스트로 열리는 것이라 초기 보드에서 뺀다. */
  const seed = [[1,1],[1,5],[3,3],[5,1],[5,5],[7,3]];
  DATA.item_spec
    .filter((r) => r.is_generator && chainInfo(r.item_code).line !== "quest")
    .filter((r, i, all) => all.findIndex((x) => chainOf(x.item_code) === chainOf(r.item_code)) === i)
    .slice(0, seed.length)
    .forEach((r, i) => {
      const [row, col] = seed[i];
      cells[row * COLS + col] = { code: r.item_code, stock: 30, lastAt: Date.now() / 1000 };
    });
  return {
    cells, level: 1, exp: 0, coin: DATA.const.nru_start_coin, gem: 0, debug: false,
    inv: { store: [], box: [], bought: 0, tab: "store" },
    energy: DATA.const.default_max_energy, energyLastAt: Date.now() / 1000, serveCount: 0, boost: 1,
    day: 1, choreSeq: 0, sel: null, busy: false, orderFree: false, out: null,
    /* chain_repeat — 체인별 남은 제한 횟수. 신판 const.order_repeat_reset_count(3) 이
       되살아나면서 다시 필요해졌다. 모든 랜덤 슬롯이 이 표 <b>하나</b>를 공유한다. */
    orderGen: { rng_state: RNG.save(), fixed_next_seq: 1, chain_repeat: {}, type_timers: {} },
    slots: {}, prevOfSlot: {}, log: [],
  };
}

/* 신판 실물 5타입. avatar·event 는 없어진 이름이라 표에서도 걷었다.
   high / random_3 / random_4 는 시트·string_code 어디에도 한글 라벨이 없다 —
   아래는 <b>임시 표기</b>이고 기획 확정 전까지 이 파일이 유일한 출처다. */
const TYPE_KO = {
  normal: "일반", high: "고급", random_3: "무작위3", random_4: "무작위4",
  special: "특별(대본)", fixed: "고정",
};

/* 슬롯 ↔ 타입 — order_rule 행 순서대로 slot_count 만큼 펼친다.
   normal 2 + high 1 + random_3 1 + random_4 1 + special 1 = <b>6칸</b>이고
   const.rail_visible_max = 6 과 맞는다. 슬롯 번호는 시트 열이 아니라 이 배치의 결과다 —
   order_fixed.slot_1/slot_2 가 가리키는 번호도 이 배치를 전제한다. */
const SLOT_ORDER = ["normal", "high", "random_3", "random_4", "special"];
/* 인덱스에 얹는다 — slotType 이 발급마다 불리는데 매번 order_rule 을 5번 훑을 이유가 없다.
   DATA 를 갈아끼우면 reindex 가 IDX 를 통째로 버리므로 캐시가 따라 죽는다. */
function slotMap() {
  const I = idx();
  if (I.slots) return I.slots;
  const out = [];
  for (const t of SLOT_ORDER) {
    const r = I.rule.get(t);
    for (let i = 0; i < (r ? r.slot_count : 0); i++) out.push(t);
  }
  I.slots = out.length ? out : ["normal", "normal"];
  return I.slots;
}
const slotType = (n) => slotMap()[n - 1] || "normal";
const slotCount = () => slotMap().length;
const ruleOf = (type) => idx().rule.get(type);

/* 추첨으로 뜨는 타입인가 — order_slot_band 에 행이 있어야 자리 범위가 나온다.
   신판 special 은 밴드 0행 · refresh_sec 0 · order_special.trigger_task 를 갖는
   <b>대본형</b>이다. 밴드가 없다고 「데이터 오류」로 찍으면 안 된다. */
function isDrawType(type) {
  return DATA.order_slot_band.some((b) => b.in_use && b.order_type === type);
}

/* 자리 범위 — 판본 차이를 여기 한 곳에서만 흡수한다.
   구판: first_min~first_max / second_min~second_max / third_min~third_max (3자리)
   신판: first_min~first_max / (하한 없음)~second_max                      (2자리)
   `open: true` 는 하한이 0 인 게 아니라 <b>하한 열이 없다</b>는 뜻이다. */
function seatRange(band, seat) {
  if (seat === 1) return { lo: band.first_min, hi: band.first_max, open: false };
  if (seat === 2) {
    if (band.second_max == null) return null;
    return { lo: band.second_min ?? 0, hi: band.second_max, open: band.second_min == null };
  }
  if (band.third_max == null) return null;
  return { lo: band.third_min ?? 0, hi: band.third_max, open: band.third_min == null };
}
const bandSeats = (band) => (band.third_max != null ? 3 : band.second_max != null ? 2 : 1);
const rangeText = (r) => (r.open ? `~${r.hi}` : `${r.lo}~${r.hi}`);

/* 칸이 언제 열리나 — 고정 오더는 order_fixed.unlock_level 로만 걸리고 order_rule 을 안 본다.
   그래서 고정 오더가 들어오는 칸(실물 1·2·3)은 그 최저 레벨부터 열어 두고,
   랜덤 발급 차단은 generateOrder [1] 이 따로 맡는다. 나머지 칸은 타입의 unlock_level 그대로. */
/* 고정 오더가 노리는 슬롯 — 신판은 slot_1·slot_2 뿐이고 slot_3 은 전부 0 이다.
   0 은 「칸 없음」이라 걸러야 한다(슬롯 번호는 1부터다). */
const fixedSlots = (f) => [f.slot_1, f.slot_2, f.slot_3].filter((v) => v > 0);

function slotNeed(n) {
  const r = ruleOf(slotType(n));
  const ruleLv = r ? r.unlock_level : 1;
  const fx = DATA.order_fixed.filter((f) => f.in_use && fixedSlots(f).includes(n));
  return fx.length ? Math.min(ruleLv, ...fx.map((f) => f.unlock_level)) : ruleLv;
}
function allSlots() {
  return Array.from({ length: slotCount() }, (_, i) => i + 1).map((n) => {
    const need = slotNeed(n);
    return { n, type: slotType(n), need, open: S.level >= need };
  });
}

function openSlots() {
  return allSlots().filter((s) => s.open).map((s) => s.n);
}

/* ======================================================================
   4. 오더 생성 — 개발 기획서 1.2.1 의 8단계
   ====================================================================== */
function boardCounts() {
  const m = new Map();
  for (const c of S.cells) {
    if (!c) continue;
    const sp = specOf(c.code);
    if (sp && sp.is_generator) continue;
    m.set(c.code, (m.get(c.code) || 0) + 1);
  }
  return m;
}
/* [5] 이벤트 점수 — score_min 오름차순으로 「기준값 >= score_min 인 마지막 행」.
   score_max 는 검사용이라 런타임 선택에 쓰지 않는다. 행이 없거나 기준값 0 이면 0. */
/* [GAP-2] 실물 시트는 event_id 별 행에 score_base("coin") 칸을 갖는다 — 칸이 있으면 그
   기준값(코인)을 쓰고, event_id 는 주어진 것(없으면 데이터의 첫 event_id)만 본다. 어느
   이벤트가 활성인지는 편성의 몫이라 입력으로 받는다. 옛 데이터(칸 없음)는 종전과 같다. */
function eventScore(basis, eventId) {
  const bs = typeof basis === "number" ? { diff: basis } : basis || {};
  let rows = (DATA.event_order_score || []).filter((r) => r.in_use);
  const ids = [...new Set(rows.map((r) => r.event_id).filter((v) => v != null))];
  if (ids.length) rows = rows.filter((r) => r.event_id === (eventId ?? ids[0]));
  rows.sort((x, y) => x.score_min - y.score_min);
  let hit = null, base = 0;
  for (const r of rows) {
    const v = r.score_base === "coin" ? bs.coin || 0 : bs.diff || 0;
    if (v > 0 && v >= r.score_min) { hit = r; base = v; }
  }
  if (!hit) return 0;
  if (hit.token_pct > 0) return Math.floor((base * hit.token_pct) / 10000);
  return hit.token_fix || 0;
}

function requiredElsewhere(slotNo) {
  const set = new Set();
  for (const [n, card] of Object.entries(S.slots)) {
    if (Number(n) === slotNo || !card) continue;
    card.reqs.forEach((q) => set.add(q.code));
  }
  return set;
}

// [4] 보드 상황 배수 — 하나만 적용, 중복 곱 금지
/* 기획서 [2] 는 「다른 오더가 **이 체인을** 요구」라고 체인 단위로 쓴다.
   후보 제외(banned)만 명시적으로 코드 단위다 — 둘을 섞지 않는다.
   납품 가능 여부는 그 코드가 보드에 있어야 하므로 코드 단위 그대로. */
function situationMult(code, othersReq, counts, C, othersChains) {
  const chains = othersChains || new Set([...othersReq].map(chainOf));
  const wanted = chains.has(chainOf(code));
  const canServe = (counts.get(code) || 0) > 0;
  if (wanted && canServe) return { v: C.order_weight_mult_required_enough, why: "타오더 요구+납품가능" };
  if (!wanted) {
    const ch = chainOf(code), st = stepOf(code);
    for (const [c, n] of counts)
      if (n > 0 && chainOf(c) === ch && stepOf(c) <= st)
        return { v: C.order_weight_mult_higher_level, why: "미요구+보드에 동급·하급 有" };
    return { v: C.order_weight_mult_not_required, why: "미요구" };
  }
  return { v: 1, why: "타오더 요구+납품불가(기본)" };
}

/* ── 반복 감쇠 ────────────────────────────────────────────────────────────
   <b>여기가 「시트에 답이 없어 우리가 고른」 자리다.</b> 기획 답이 오면 이 객체만 바꾼다 —
   흩어 두면 다음 사람이 세 군데 중 하나를 놓친다.

   시트가 주는 것 : const.order_repeat_reset_count = 3
                    order_item.repeat_weight_decrease (0 · 10 · 50 · 100)
   시트가 안 주는 것 : <b>무엇을 세는 3인가.</b> 「발급 3회」로 읽었다. 「납품 3회」면
                    commit 을 부르는 자리가 달라진다(생성이 아니라 납품 시점).
                    신판에는 셀 메모가 없어 대조할 근거가 없다 — 기획 확인 대기.

   절차(개발 기획서 정본):
     ① 제한 횟수 = const.order_repeat_reset_count
     ② 오더가 나가면 그 카드의 요구 체인마다 남은 횟수 = 제한 횟수
     ③ 남은 횟수 > 0 이고 repeat_weight_decrease > 0 인 후보는 가중치를 그 값으로 나눈다
     ④ 갱신 대상 = 이번에 제한이 걸린 체인 ∪ 이번에 나간 체인 — 나갔으면 리셋, 아니면 −1
     ⑤ 0 이 되면 표에서 지운다. 고정 오더 발급은 카운터를 건드리지 않는다.

   ④ 의 <b>합집합</b>이 요점이다. 「제한 걸린 체인」만 보면 표가 빈 최초 상태에서 아무것도
   안 들어가 카운터가 영원히 안 켜지고, 「나간 체인」만 보면 안 뽑힌 체인이 안 줄어
   한 번 눌린 체인이 영영 눌린 채 남는다. 둘 다 있어야 돈다.

   모든 랜덤 슬롯이 체인별 표 <b>하나</b>를 공유한다(슬롯별이 아니다).
   직전 요구 코드를 통째로 빼는 banned 와는 다른 축이다 — 그건 코드 단위, 이건 체인 단위. */
const RepeatDecay = {
  resetOf: (C) => Number(C.order_repeat_reset_count) || 0,

  /* 이 후보에 걸리는 제수. 0 이면 안 나눈다. */
  divisorOf(oi, CR) {
    const rem = CR[chainOf(oi.item_code)] || 0;
    return rem > 0 && oi.repeat_weight_decrease > 0 ? Number(oi.repeat_weight_decrease) : 0;
  },

  /* 카드가 나간 뒤 표를 갱신한다. 돌려주는 건 로그용 변경 내역이다.
     issued  = 실제로 나간 요구의 체인 (버린 후보는 안 들어간다 — 나간 오더가 아니다)
     divided = 이번 추첨에서 실제로 제수를 적용한 체인 */
  commit(CR, issued, divided, reset) {
    if (reset <= 0) return [];
    const upd = [];
    new Set([...divided, ...issued]).forEach((ch) => {
      if (issued.has(ch)) { CR[ch] = reset; upd.push(`${chainName(ch)}\u2192${reset}`); }
      else {
        CR[ch] = Math.max(0, (CR[ch] || 0) - 1);
        if (!CR[ch]) delete CR[ch];
        upd.push(`${chainName(ch)}\u22121`);
      }
    });
    return upd;
  },
};

/* 밴드 선택 — 레벨 구간 하나뿐이다. 하루 누적 난이도 축(diff_sum_min/max)은
   신판에서 열 셋과 상수 셋이 동시에 삭제돼 통째로 걷었다. */
const pickBand = (type, level) =>
  DATA.order_slot_band.filter((b) => b.order_type === type && b.in_use)
    .sort((a, b) => a.band_seq - b.band_seq)
    .find((b) => level >= b.level_min && level <= b.level_max) || null;

function pickAvatar() {
  const pool = DATA.order_avatar.filter((a) => a.in_use && a.open_day <= S.day);
  const used = new Set(Object.values(S.slots).filter(Boolean).map((c) => c.avatar));
  const free = pool.filter((a) => !used.has(a.avatar_key));
  if (free.length) return free[RNG.int(free.length)].avatar_key;
  if (pool.length) return pool[RNG.int(pool.length)].avatar_key;
  const fb = DATA.order_avatar.filter((a) => a.open_day < 999);
  return fb.length ? fb[0].avatar_key : "—";
}

function generateOrder(slotNo, opts = {}) {
  const dry = !!opts.dry;
  const level = opts.level ?? S.level;
  const type = opts.type ?? slotType(slotNo);
  const C = DATA.const;
  const L = [];
  const push = (t) => L.push(t);

  // ---- [0] 고정 오더 먼저 (랜덤 예산·대기 미변경)
  if (!opts.skipFixed) {
    const fx = DATA.order_fixed.find((f) => f.in_use && f.fixed_seq === S.orderGen.fixed_next_seq);
    if (fx) {
      const fxSlots = fixedSlots(fx);
      const slotOk = fxSlots.includes(slotNo);
      const lvOk = level >= fx.unlock_level;
      if (slotOk && lvOk) {
        /* 신판 order_fixed 는 requirement_1·2 두 칸뿐이다 — 셋째 칸이 삭제되면서
           자르기가 필요 없어졌다. 구판 번들을 드롭했을 때만 requirement_3 이
           딸려 오므로, 있으면 그때만 상한으로 자른다. */
        const capFix = ruleOf(slotType(slotNo))?.item_slot_max ?? 2;
        const rawFix = [fx.requirement_1, fx.requirement_2, fx.requirement_3].filter(Boolean);
        const reqs = rawFix.slice(0, capFix).map((code) => ({ code, count: 1 }));
        if (rawFix.length > reqs.length)
          push(`    <span class="w">요구 ${rawFix.length}종 → ${reqs.length}종으로 자름</span> (order_rule.item_slot_max ${capFix} · 이 행은 ${rawFix.length}칸)`);
        const coin = reqs.reduce((a, q) => a + (oiOf(q.code)?.order_price || 0), 0);
        const diff = reqs.reduce((a, q) => a + (oiOf(q.code)?.diff_score || 0), 0);
        push(`<span class="k">[0] 고정 오더 채택</span> fixed_seq=${fx.fixed_seq} (unlock_level ${fx.unlock_level} ≤ Lv${level} · 슬롯 ${fxSlots.join("/")} 에 ${slotNo} 포함)`);
        push(`    요구 ${reqs.map((q) => labelOf(q.code)).join(" + ")} · 랜덤 예산·대기 변경 없음 · <span class="k">반복 카운터 안 건드림</span>`);
        if (!dry) S.orderGen.fixed_next_seq++;
        return { card: { slot: slotNo, type: "fixed", reqs, avatar: pickAvatar(), coin, diff, evt: eventScore({ coin, diff }, opts.eventId), band: null }, log: L };
      }
      push(`[0] 고정 오더 fixed_seq=${fx.fixed_seq} 미적용 (${!lvOk ? `unlock_level ${fx.unlock_level} > Lv${level}` : `슬롯 ${fxSlots.join("/")} 에 ${slotNo} 없음`}) → 순번 유지, 랜덤 검사로`);
    }
  }

  // ---- [1] 예산·대기
  const rule = ruleOf(type);
  if (!rule) { push(`<span class="w">order_rule 에 ${type} 활성 행 없음</span>`); return { card: null, log: L }; }
  /* 대본형 — order_slot_band 에 행이 없는 타입은 추첨으로 뜨지 않는다.
     신판 special 이 그렇다(refresh_sec 0 · refill_max 0 · order_special.trigger_task).
     「밴드 없음 = 데이터 오류」로 찍던 자리를 여기서 먼저 가로챈다. */
  if (!isDrawType(type)) {
    const sp = (DATA.order_special || []).filter((r) => r.in_use);
    push(`<span class="k">[1] ${TYPE_KO[type] || type} 은 추첨 대상이 아니다</span> — order_slot_band 에 ${type} 행 0개 · refresh_sec ${rule.refresh_sec}`);
    push(`    발급 경로는 order_special.trigger_task 다 (${sp.length ? sp.map((r) => `${r.chain_key}←${r.trigger_task}`).join(" / ") : "활성 행 없음"}) → <span class="k">대본형</span>`);
    return { card: null, log: L, scripted: true };
  }
  /* 해금 검사는 상태를 바꾸지 않는 순수 판정이라 dry 에서도 돈다.
     예산·대기만 dry 에서 건너뛴다 — 이걸 한 블록에 묶어 두면 분포 시뮬이
     미해금 타입도 발급해 버려서, 실제로는 한 장도 안 나올 오더가 통계에 섞인다. */
  if (level < rule.unlock_level) {
    push(`<span class="w">[1] ${type} 미해금</span> (unlock_level ${rule.unlock_level} > Lv${level}) → 랜덤 발급 없음. 고정 오더만 이 슬롯을 채운다`);
    return { card: null, log: L, locked: true };
  }
  /* [1] 즉시 채움 권한 — 시트 order_rule.refill_max 셀 메모 그대로다.
       「슬롯이 빈 채로 refresh_sec 가 한 번 지날 때마다 그 슬롯에 권한이 한 장 쌓이고
        이 값을 넘겨 쌓이지 않는다 — A8-2 order_slot_timer.refill_left 의 천장이다.
        0 = 쌓이지 않는다(주기가 지나면 그 한 장으로 채우고 끝).」  근거: 원작 확인
     즉 refill_max 는 「비축 천장」이고 발급 자체를 막지 않는다. 전에는 0 을 「발급 경로
     없음」으로 읽어 avatar·special·event 가 영구히 안 나왔다 — 그게 오독이었다. */
  if (!dry) {
    const t = (S.orderGen.type_timers[type] ||= { refill_left: rule.refill_max, next_refill_at: 0 });
    if (t.remaining_count !== undefined) {                  // 구 세이브 이관
      t.refill_left = t.remaining_count; delete t.remaining_count;
    }
    const now = Date.now() / 1000;
    if (t.refill_left > 0) {
      t.refill_left--;
      push(`[1] 즉시 채움 권한 −1 → ${t.refill_left}/${rule.refill_max} (${type}${type === "normal" ? " · 슬롯 1·2 공유" : ""})`);
    } else if (t.next_refill_at > 0 && now >= t.next_refill_at) {
      t.next_refill_at = 0;                                 // 주기 도달 — 그 한 장으로 바로 채운다
      push(`[1] 갱신 주기 도달 → <span class="k">이번 한 장</span>으로 채움 (비축 천장 ${rule.refill_max})`);
    } else {
      if (t.next_refill_at <= 0) {
        t.next_refill_at = now + rule.refresh_sec;
        push(`<span class="w">[1] 권한 0 → 대기 시작</span> now+${rule.refresh_sec}s · 카드 만들지 않음`);
      } else {
        push(`<span class="w">[1] 권한 0 · 대기 중</span> 남은 ${Math.ceil(t.next_refill_at - now)}s · 종료 시각 안 미룸`);
      }
      return { card: null, log: L };
    }
  }

  // ---- [2] 자리별 단계 범위
  const band = pickBand(type, level);
  if (!band) { push(`<span class="w">[2] order_slot_band 에 ${type} Lv${level} 구간 없음 → 데이터 오류</span>`); return { card: null, log: L }; }
  const seats = bandSeats(band);
  const seatTxt = Array.from({ length: seats }, (_, i) => {
    const r = seatRange(band, i + 1);
    return `${["첫째", "둘째", "셋째"][i]} ${rangeText(r)}`;
  }).join(" · ");
  push(`<span class="k">[2] 밴드</span> band_seq=${band.band_seq} (Lv ${band.level_min}~${band.level_max}) · ${seatTxt} 단계 <span style="opacity:.65">(밴드가 자리 ${seats}개를 준다${seats === 2 ? " · 둘째는 하한 열이 없다" : ""})</span>`);

  // ---- [3] 후보 집합
  const counts = opts.counts ?? boardCounts();
  const othersReq = opts.othersReq ?? requiredElsewhere(slotNo);
  const prev = opts.prev !== undefined ? opts.prev : S.prevOfSlot[slotNo];
  /* 반복 감쇠 — 규칙은 RepeatDecay 한 곳에 모아 뒀다(위 정의 주석 참조).
     사본을 넘기면 게임 상태를 안 더럽힌다 — 분포 시뮬이 그렇게 쓴다. */
  const CR = opts.repeat || S.orderGen.chain_repeat;
  const RESET = RepeatDecay.resetOf(C);
  const othersChains = new Set([...othersReq].map(chainOf));
  const banned = new Set([...othersReq]);
  if (prev) prev.forEach((c) => banned.add(c));
  push(`[3] 제외 item_code: ${banned.size ? [...banned].map(labelOf).join(", ") : "없음"} <span style="opacity:.65">(체인 전체 아님)</span>`);

  const pool = DATA.order_item.filter((o) => o.in_use && o.unlock_level <= level);
  /* 요구 종수 상한 — 시트 order_rule.item_slot_max 하나만 본다. 호출자 스위치는 걷었다.
     밴드가 주는 자리 수보다 클 수 없다(신판은 둘 다 2 라 같은 값이다). */
  const slotMax = Math.min(rule.item_slot_max, seats);
  if (rule.item_slot_max > seats)
    push(`<span class="w">[4] item_slot_max ${rule.item_slot_max} > 밴드 자리 ${seats}</span> → ${slotMax}자리로 제한 (order_slot_band 에 그만큼의 열이 없다)`);
  const picked = [];
  const chosen = new Set();
  // 가중치를 실제로 나눈 체인 — 카운터 갱신 대상은 「뽑힌 것」이 아니라 「제한이 걸린 것」이 기준이다
  const divided = new Set();

  for (let seat = 1; seat <= slotMax; seat++) {
    const rg = seatRange(band, seat);
    if (!rg) break;
    const { lo, hi } = rg;
    const cand = pool.filter((o) => {
      const st = stepOf(o.item_code);
      return st >= lo && st <= hi && !banned.has(o.item_code) && !chosen.has(o.item_code);
    });
    if (!cand.length) {
      push(`<span class="w">[4] 자리${seat} 후보 0</span> (${rangeText(rg)}단계) → 이 자리 이후는 추첨하지 않는다`);
      break;
    }
    const rows = cand.map((o) => {
      const m = situationMult(o.item_code, othersReq, counts, C, othersChains);
      const rem = CR[chainOf(o.item_code)] || 0;
      const div = RepeatDecay.divisorOf(o, CR);
      if (div) divided.add(chainOf(o.item_code));
      /* 가중식 = 상황 배수 ÷ 반복 제수. order_item.weight / weight_multiple 은
         클라 계약에 없는 열이라 곱하지 않는다(엔진 머리말 v6.0 참조). */
      return { o, base: 1, mult: m.v, why: m.why, div, rem, w: m.v / (div || 1) };
    });
    const total = rows.reduce((a, r) => a + r.w, 0);
    const win = rows[RNG.pick(rows.map((r) => r.w))];
    picked.push(win.o); chosen.add(win.o.item_code);

    const byWhy = {};
    rows.forEach((r) => { byWhy[r.why] = (byWhy[r.why] || 0) + 1; });
    push(`<span class="k">[4] 자리${seat}</span> 범위 ${rangeText(rg)} · 후보 ${cand.length}종 [${Object.entries(byWhy).map(([k, v]) => `${k} ${v}`).join(" / ")}]`);
    push(`    → <span class="p">${labelOf(win.o.item_code)}</span> 배수 ${win.mult}${win.div ? ` ÷제수 ${win.div}(남은 ${win.rem}회)` : ""} = 가중 ${win.w.toFixed(1)} / 합 ${total.toFixed(1)} = <span class="p">${((win.w / total) * 100).toFixed(2)}%</span>`);
  }

  if (!picked.length) {
    push(`<span class="w">[4] 첫 자리부터 후보 없음 → 생성 실패.</span> 기회·카운터·난수 상태 전부 보존 (기회 소비 안 함)`);
    return { card: null, log: L, failed: true };
  }

  // ---- [5] 요구 종수 — 자리를 먼저 뽑고 그 수 안에서 정한다
  const grp = Math.max(...DATA.order_item_count.filter((r) => r.in_use && r.level <= level).map((r) => r.level));
  const rowsC = DATA.order_item_count.filter((r) => r.in_use && r.level === grp && r.item_count <= picked.length && r.item_count <= slotMax);
  let n = picked.length;
  if (rowsC.length) {
    const sum = rowsC.reduce((a, r) => a + r.count_weight, 0);
    n = rowsC[RNG.pick(rowsC.map((r) => r.count_weight))].item_count;
    push(`<span class="k">[5] 종수</span> level 묶음 ${grp} · 후보 자리 ${picked.length} · ${rowsC.map((r) => `${r.item_count}종 ${((r.count_weight / sum) * 100).toFixed(2)}%`).join(" / ")} → <span class="p">${n}종</span>`);
  }
  const finalReqs = picked.slice(0, n).map((o) => ({ code: o.item_code, count: 1 }));
  if (n < picked.length)
    push(`    버린 후보 ${picked.slice(n).map((o) => labelOf(o.item_code)).join(", ")} — <span class="k">카운터 갱신에서도 제외</span> (나간 오더가 아니다)`);

  if (divided.size)
    push(`    반복 감쇠 적용 ${[...divided].map((ch) => `${chainName(ch)}(남은 ${CR[ch]}회)`).join(", ")}`);

  // ---- 반복 카운터 갱신 (규칙은 RepeatDecay.commit — 합집합인 이유는 거기 적어 뒀다)
  if (!dry || opts.repeat) {
    const issued = new Set(finalReqs.map((q) => chainOf(q.code)));
    const upd = RepeatDecay.commit(CR, issued, divided, RESET);
    if (upd.length) push(`    <span class="k">반복 카운터</span> ${upd.join(", ")} <span style="opacity:.65">(제한 ${RESET}회 · 전 슬롯 공유)</span>`);
  }

  // ---- [6][7]
  const avatar = pickAvatar();
  const coin = finalReqs.reduce((a, q) => a + (oiOf(q.code)?.order_price || 0) * q.count, 0);
  const diff = finalReqs.reduce((a, q) => a + (oiOf(q.code)?.diff_score || 0) * q.count, 0);
  push(`<span class="k">[6] 손님</span> ${avatar} (day ${S.day} 해금 명단에서 균등)`);
  const evt = eventScore({ coin, diff }, opts.eventId);   // [GAP-2]
  push(`<span class="k">[7] 보상</span> 코인 ${coin} = ${finalReqs.map((q) => oiOf(q.code)?.order_price).join(" + ")} · 난이도 ${diff} · <span style="opacity:.65">경험치 0</span>`);
  push(`<span class="k">[5] 이벤트 점수</span> coin ${coin} · diff ${diff} → <span class="p">${evt}</span> <span style="opacity:.65">(event_order_score · score_base 칸이 있으면 그 기준, 없으면 난이도)</span>`);

  if (!dry) {
    push(`[8] 카드+난수 원자 저장 → 표시 → /order/refresh`);
    S.orderGen.rng_state = RNG.save();
  }
  return { card: { slot: slotNo, type, reqs: finalReqs, avatar, coin, diff, evt, band: band.band_seq }, log: L };
}

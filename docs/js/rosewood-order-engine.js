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
     GAP-1  [4] 가중치에 시트의 weight × weight_multiple 반영 (전 행 100·1 → 오늘은 동일)
     GAP-2  eventScore 가 score_base(coin)·event_id 를 읽는다 (칸 없으면 종전대로 난이도)
     GAP-3  pickBand 에 하루 누적 난이도 축 — 입력(dailyDiff)으로만 (기본 0 = 종전 동작)

   v4.5 — 시트 <b>셀 메모</b>(컬럼마다 규칙·근거가 달려 있다)를 뒤늦게 읽고 두 곳을
   정정했다. 둘 다 데이터가 아니라 우리 쪽 오독이었다.
     refill_max   「비축 천장」이지 발급 차단이 아니다. 0 을 「발급 경로 없음」으로 읽어
                  avatar·special·event 가 영구히 안 나오던 것을 고쳤다
     반복 감쇠     카운터가 아니라 「직전 오더의 체인」 한 장 기준. 시트에
                  order_repeat_reset_count 가 없는 게 정상이었다 — 규칙이 카운터를 안 쓴다

   로드 순서: 이 파일이 페이지 스크립트보다 먼저 와야 한다(DATA · S 를 여기서 선언).
   ========================================================================== */

const COLS = 7, ROWS = 9, CELLS = COLS * ROWS;

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
   236종 중 224장이 왔다 — 아직 없는 12: 511~514 · 606 · 607 · 1108~1112 · 1612.
   없는 코드는 지금까지처럼 이름 글자로 그린다.
   ⚠ **아트와 이름이 체인 단위로 어긋난다.** 101 은 이름이 「녹슨 못」인데 그림은 커피 원두,
      901「산딸기」는 감자, 1601「꽃가루」는 고무 오리다. 재화·상자(2501~3101)만 정확히 맞는다.
      단순한 번호 밀림이 아니다 — 이름 표에 원두·감자·오리가 **아예 없다**. 아트가 반영한
      item_spec 신판에는 여기 없는 체인이 들어 있다는 뜻이다.
      → 이름은 로컬 구판(2026-09-08) 기준이라 신판 시트를 받아야 맞춰진다. 아트는 그대로 쓴다
        (실루엣·단계 수는 맞고, 이름만 늦다). */
const SPRITE_CODES = new Set([101,102,103,104,105,106,107,108,109,110,111,201,202,203,204,205,206,207,208,209,210,301,302,303,304,305,306,307,401,402,403,404,405,406,407,408,409,410,411,501,502,503,504,505,506,507,508,509,510,601,602,603,604,605,701,702,703,704,705,706,707,708,709,710,711,801,802,803,804,805,806,807,808,809,810,811,812,901,902,903,904,905,906,907,1001,1002,1003,1004,1005,1006,1007,1008,1009,1010,1101,1102,1103,1104,1105,1106,1107,1201,1202,1203,1204,1205,1206,1207,1208,1209,1210,1211,1301,1302,1303,1304,1305,1306,1307,1308,1309,1310,1311,1501,1502,1503,1504,1505,1506,1507,1508,1509,1510,1511,1601,1602,1603,1604,1605,1606,1607,1608,1609,1610,1611,1701,1702,1703,1704,1705,1706,1707,1801,1802,1803,1804,1805,1806,1807,1901,1902,1903,1904,1905,1906,1907,1908,1909,1910,2001,2002,2003,2004,2005,2006,2101,2102,2103,2104,2105,2106,2107,2108,2109,2110,2201,2301,2302,2303,2304,2305,2306,2307,2308,2309,2310,2401,2402,2403,2404,2405,2406,2501,2502,2601,2602,2701,2702,2703,2704,2705,2801,2802,2803,2804,2901,2902,2903,2904,2905,3001,3101,3102,3103]);
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
];
/* [코드, 다음, 판매가, show_sell_confirm, 생성기, 이름, name_en, chain_key,
    재고상한, 에너지, 회복초, [[산출코드, 가중치], …]] */
const ITEM_DB = [
  [101,102,0,0,0,"녹슨 못","Rusty Nail","M_TOOL",0,0,0,[]],
  [102,103,0,0,0,"못 상자","Box of Nails","M_TOOL",0,0,0,[]],
  [103,104,1,0,0,"연장 주머니","Tool Pouch","M_TOOL",0,0,0,[]],
  [104,105,2,0,1,"공구함","Toolbox","M_TOOL",80,1,6,[[203,100]]],
  [105,106,3,0,1,"작업대","Workbench","M_TOOL",80,1,180,[[203,37],[303,5]]],
  [106,107,4,0,1,"이동 작업대","Rolling Bench","M_TOOL",80,1,180,[[203,34],[204,2],[205,1],[303,5]]],
  [107,108,5,0,1,"공구 벽","Tool Wall","M_TOOL",80,1,180,[[203,33],[204,3],[205,1],[303,5]]],
  [108,109,6,0,1,"전동 공구대","Power Bench","M_TOOL",80,1,180,[[203,32],[204,4],[205,1],[303,5]]],
  [109,110,7,0,1,"수리 작업장","Repair Bay","M_TOOL",80,1,180,[[203,31],[204,5],[205,1],[303,5]]],
  [110,111,8,0,1,"복원 공방","Restoration Shop","M_TOOL",80,1,180,[[203,31],[204,4],[205,2],[303,5]]],
  [111,0,9,0,1,"마스터 공방","Master Workshop","M_TOOL",80,1,180,[[203,31],[204,4],[205,2],[303,4],[304,1]]],
  [201,202,0,0,0,"나사","Screw","R_TOOL",0,0,0,[]],
  [202,203,0,0,0,"못","Nail","R_TOOL",0,0,0,[]],
  [203,204,1,0,0,"망치","Hammer","R_TOOL",0,0,0,[]],
  [204,205,2,0,0,"드라이버","Screwdriver","R_TOOL",0,0,0,[]],
  [205,206,3,0,0,"펜치","Pliers","R_TOOL",0,0,0,[]],
  [206,207,4,0,0,"렌치","Wrench","R_TOOL",0,0,0,[]],
  [207,208,5,0,0,"톱","Saw","R_TOOL",0,0,0,[]],
  [208,209,6,0,0,"줄자","Tape Measure","R_TOOL",0,0,0,[]],
  [209,210,7,0,0,"전동 드릴","Power Drill","R_TOOL",0,0,0,[]],
  [210,0,8,0,0,"공구 세트","Tool Set","R_TOOL",0,0,0,[]],
  [301,302,0,0,0,"페인트 붓","Paintbrush","R_PAINT",0,0,0,[]],
  [302,303,0,0,0,"붓 세트","Brush Set","R_PAINT",0,0,0,[]],
  [303,304,1,0,0,"롤러","Paint Roller","R_PAINT",0,0,0,[]],
  [304,305,2,0,0,"페인트 통","Paint Can","R_PAINT",0,0,0,[]],
  [305,306,3,0,0,"색 팔레트","Paint Palette","R_PAINT",0,0,0,[]],
  [306,307,4,0,0,"페인트 세트","Paint Kit","R_PAINT",0,0,0,[]],
  [307,0,5,0,0,"도색 장비","Painting Rig","R_PAINT",0,0,0,[]],
  [401,402,0,0,0,"마른 찻잎","Dried Tea Leaf","M_TEA",0,0,0,[]],
  [402,403,0,0,0,"찻잎 봉지","Tea Pouch","M_TEA",0,0,0,[]],
  [403,404,1,0,0,"찻잎 단지","Tea Caddy","M_TEA",0,0,0,[]],
  [404,405,2,0,0,"찻주전자","Teapot","M_TEA",0,0,0,[]],
  [405,406,3,0,1,"2인 티팟","Two-Cup Pot","M_TEA",26,1,180,[[503,100]]],
  [406,407,4,0,1,"티 카트","Tea Cart","M_TEA",26,1,180,[[503,90],[504,10]]],
  [407,408,5,0,1,"티 트롤리","Tea Trolley","M_TEA",26,1,180,[[503,85],[504,15]]],
  [408,409,6,0,1,"티 스탠드","Tea Stand","M_TEA",26,1,180,[[503,85],[504,10],[505,5]]],
  [409,410,7,0,1,"은주전자","Silver Urn","M_TEA",26,1,180,[[503,82],[504,13],[505,5]]],
  [410,411,8,0,1,"티 바","Tea Bar","M_TEA",26,1,180,[[503,80],[504,15],[505,5]]],
  [411,0,9,0,1,"티 살롱","Tea Salon","M_TEA",26,1,180,[[503,80],[504,15],[505,5],[603,20]]],
  [501,502,0,0,0,"따뜻한 물","Hot Water","R_TEA",0,0,0,[]],
  [502,503,0,0,0,"찻물","Steeped Tea","R_TEA",0,0,0,[]],
  [503,504,1,0,0,"홍차","Black Tea","R_TEA",0,0,0,[]],
  [504,505,2,0,0,"밀크티","Milk Tea","R_TEA",0,0,0,[]],
  [505,506,3,0,0,"레몬티","Lemon Tea","R_TEA",0,0,0,[]],
  [506,507,4,0,0,"허브티","Herbal Tea","R_TEA",0,0,0,[]],
  [507,508,5,0,0,"로즈티","Rose Tea","R_TEA",0,0,0,[]],
  [508,509,6,0,0,"아이스티","Iced Tea","R_TEA",0,0,0,[]],
  [509,510,7,0,0,"버블티","Bubble Tea","R_TEA",0,0,0,[]],
  [510,511,8,0,0,"티포트","Pot of Tea","R_TEA",0,0,0,[]],
  [511,512,9,0,0,"2인 티세트","Tea for Two","R_TEA",0,0,0,[]],
  [512,513,10,0,0,"애프터눈 티","Afternoon Tea","R_TEA",0,0,0,[]],
  [513,514,11,0,0,"3단 티 스탠드","Tiered Tea Set","R_TEA",0,0,0,[]],
  [514,0,12,0,0,"티 파티","Tea Party","R_TEA",0,0,0,[]],
  [601,602,0,0,0,"머그","Mug","R_CUP",0,0,0,[]],
  [602,603,0,0,0,"찻잔","Teacup","R_CUP",0,0,0,[]],
  [603,604,1,0,0,"받침 찻잔","Cup and Saucer","R_CUP",0,0,0,[]],
  [604,605,2,0,0,"꽃무늬 찻잔","Floral Teacup","R_CUP",0,0,0,[]],
  [605,606,3,0,0,"설탕 그릇","Sugar Bowl","R_CUP",0,0,0,[]],
  [606,607,4,0,0,"찻잔 세트","Tea Set","R_CUP",0,0,0,[]],
  [607,0,5,0,0,"식기 세트","Dinner Service","R_CUP",0,0,0,[]],
  [701,702,0,0,0,"장작","Firewood","M_OVEN",0,0,0,[]],
  [702,703,0,0,0,"장작더미","Wood Stack","M_OVEN",0,0,0,[]],
  [703,704,1,0,0,"무쇠 팬","Cast Iron Pan","M_OVEN",0,0,0,[]],
  [704,705,2,0,1,"반죽 그릇","Mixing Bowl","M_OVEN",80,1,2,[[803,100]]],
  [705,706,3,0,1,"화덕","Hearth Oven","M_OVEN",80,1,30,[[803,35],[804,2],[903,5]]],
  [706,707,4,0,1,"벽돌 오븐","Brick Oven","M_OVEN",80,1,180,[[803,34],[804,2],[805,1],[903,5]]],
  [707,708,5,0,1,"제빵 오븐","Baker's Oven","M_OVEN",80,1,180,[[803,33],[804,3],[805,1],[903,5]]],
  [708,709,6,0,1,"2단 오븐","Double Oven","M_OVEN",80,1,180,[[803,32],[804,4],[805,1],[903,5]]],
  [709,710,7,0,1,"제과 오븐","Pastry Oven","M_OVEN",80,1,180,[[803,31],[804,5],[805,1],[903,5]]],
  [710,711,8,0,1,"마을 빵집","Village Bakery","M_OVEN",80,1,180,[[803,31],[804,4],[805,2],[903,5]]],
  [711,0,9,0,1,"베이커리","Bakery Counter","M_OVEN",80,1,180,[[803,31],[804,4],[805,2],[903,4],[904,1]]],
  [801,802,0,0,0,"밀알","Grain","R_BAKE",0,0,0,[]],
  [802,803,0,0,0,"밀가루","Flour","R_BAKE",0,0,0,[]],
  [803,804,1,0,0,"반죽","Dough","R_BAKE",0,0,0,[]],
  [804,805,2,0,0,"롤빵","Bread Roll","R_BAKE",0,0,0,[]],
  [805,806,3,0,0,"스콘","Scone","R_BAKE",0,0,0,[]],
  [806,807,4,0,0,"머핀","Muffin","R_BAKE",0,0,0,[]],
  [807,808,5,0,0,"크루아상","Croissant","R_BAKE",0,0,0,[]],
  [808,809,6,0,0,"도넛","Doughnut","R_BAKE",0,0,0,[]],
  [809,810,7,0,0,"과일 타르트","Fruit Tart","R_BAKE",0,0,0,[]],
  [810,811,8,0,0,"레몬 파이","Lemon Pie","R_BAKE",0,0,0,[]],
  [811,812,9,0,0,"쇼트케이크","Shortcake","R_BAKE",0,0,0,[]],
  [812,0,10,0,0,"3단 케이크","Tiered Cake","R_BAKE",0,0,0,[]],
  [901,902,0,0,0,"산딸기","Berry","R_JAM",0,0,0,[]],
  [902,903,0,0,0,"설탕 단지","Sugar Jar","R_JAM",0,0,0,[]],
  [903,904,1,0,0,"딸기잼","Strawberry Jam","R_JAM",0,0,0,[]],
  [904,905,2,0,0,"마멀레이드","Marmalade","R_JAM",0,0,0,[]],
  [905,906,3,0,0,"잼 선물함","Jam Gift Box","R_JAM",0,0,0,[]],
  [906,907,4,0,0,"잼 진열대","Jam Display","R_JAM",0,0,0,[]],
  [907,0,5,0,0,"잼 수레","Jam Cart","R_JAM",0,0,0,[]],
  [1001,1002,0,0,0,"마른 씨앗","Dried Seed","S_SEED",0,0,0,[]],
  [1002,1003,0,0,0,"씨앗 봉지","Seed Packet","S_SEED",0,0,0,[]],
  [1003,1004,1,0,0,"모종판","Seed Tray","S_SEED",0,0,0,[]],
  [1004,1005,2,0,0,"작은 화분","Small Pot","S_SEED",0,0,0,[]],
  [1005,1006,3,0,0,"화분 선반","Pot Shelf","S_SEED",0,0,0,[]],
  [1006,1007,4,0,1,"화단","Flower Bed","S_SEED",6,0,3600,[[1103,10]]],
  [1007,1008,5,0,1,"온상","Cold Frame","S_SEED",8,0,4800,[[1103,90],[1104,10]]],
  [1008,1009,6,0,1,"유리 온실","Glasshouse","S_SEED",10,0,6600,[[1103,80],[1104,20]]],
  [1009,1010,7,0,1,"장미 아치","Rose Arch","S_SEED",12,0,9600,[[1103,75],[1104,25]]],
  [1010,0,8,0,1,"정원 온실","Conservatory","S_SEED",12,0,9600,[[1103,80],[1104,15],[1105,5]]],
  [1101,1102,0,0,0,"새싹","Sprout","R_FLOWER",0,0,0,[]],
  [1102,1103,0,0,0,"모종","Seedling","R_FLOWER",0,0,0,[]],
  [1103,1104,1,0,0,"들꽃","Wildflower","R_FLOWER",0,0,0,[]],
  [1104,1105,2,0,0,"데이지","Daisy","R_FLOWER",0,0,0,[]],
  [1105,1106,3,0,0,"튤립","Tulip","R_FLOWER",0,0,0,[]],
  [1106,1107,4,0,0,"수국","Hydrangea","R_FLOWER",0,0,0,[]],
  [1107,1108,5,0,0,"장미","Rose","R_FLOWER",0,0,0,[]],
  [1108,1109,6,0,0,"꽃다발","Bouquet","R_FLOWER",0,0,0,[]],
  [1109,1110,7,0,0,"리본 꽃다발","Ribboned Bouquet","R_FLOWER",0,0,0,[]],
  [1110,1111,8,0,0,"꽃바구니","Flower Basket","R_FLOWER",0,0,0,[]],
  [1111,1112,9,0,0,"화환","Wreath","R_FLOWER",0,0,0,[]],
  [1112,0,10,0,0,"대형 화환","Grand Wreath","R_FLOWER",0,0,0,[]],
  [1201,1202,0,0,0,"실 한 타래","Thread Skein","M_LINEN",0,0,0,[]],
  [1202,1203,0,0,0,"천 조각","Fabric Scrap","M_LINEN",0,0,0,[]],
  [1203,1204,1,0,0,"마른 수건","Dry Towel","M_LINEN",0,0,0,[]],
  [1204,1205,2,0,0,"빨래 바구니","Laundry Basket","M_LINEN",0,0,0,[]],
  [1205,1206,3,0,1,"리넨 바구니","Linen Basket","M_LINEN",42,1,180,[[1303,100]]],
  [1206,1207,4,0,1,"리넨 선반","Linen Shelf","M_LINEN",42,1,180,[[1303,95],[1304,5]]],
  [1207,1208,5,0,1,"리넨 장","Linen Cabinet","M_LINEN",42,1,180,[[1303,90],[1304,10]]],
  [1208,1209,6,0,1,"세탁 카트","Laundry Cart","M_LINEN",42,1,180,[[1303,90],[1304,8],[1305,2]]],
  [1209,1210,7,0,1,"다림질대","Ironing Station","M_LINEN",42,1,180,[[1303,89],[1304,8],[1305,3]]],
  [1210,1211,8,0,1,"리넨 창고","Linen Store","M_LINEN",42,1,180,[[1303,88],[1304,9],[1305,3]]],
  [1211,0,9,0,1,"공방 리넨실","Linen Room","M_LINEN",42,1,180,[[1303,87],[1304,9],[1305,4]]],
  [1301,1302,0,0,0,"행주","Dishcloth","R_LINEN",0,0,0,[]],
  [1302,1303,0,0,0,"손수건","Handkerchief","R_LINEN",0,0,0,[]],
  [1303,1304,1,0,0,"냅킨","Napkin","R_LINEN",0,0,0,[]],
  [1304,1305,2,0,0,"수건","Towel","R_LINEN",0,0,0,[]],
  [1305,1306,3,0,0,"자수 냅킨","Embroidered Napkin","R_LINEN",0,0,0,[]],
  [1306,1307,4,0,0,"테이블보","Tablecloth","R_LINEN",0,0,0,[]],
  [1307,1308,5,0,0,"레이스 테이블보","Lace Tablecloth","R_LINEN",0,0,0,[]],
  [1308,1309,6,0,0,"침구 세트","Bedding Set","R_LINEN",0,0,0,[]],
  [1309,1310,7,0,0,"커튼","Curtain","R_LINEN",0,0,0,[]],
  [1310,1311,8,0,0,"자수 커튼","Embroidered Curtain","R_LINEN",0,0,0,[]],
  [1311,0,9,0,0,"창가 커튼 세트","Window Set","R_LINEN",0,0,0,[]],
  [1501,1502,0,0,0,"마른 풀","Dry Grass","M_HIVE",0,0,0,[]],
  [1502,1503,0,0,0,"나뭇조각","Wood Chip","M_HIVE",0,0,0,[]],
  [1503,1504,1,0,0,"벌집 조각","Comb Piece","M_HIVE",0,0,0,[]],
  [1504,1505,2,0,0,"작은 벌집","Small Comb","M_HIVE",0,0,0,[]],
  [1505,1506,3,0,1,"벌통","Beehive","M_HIVE",36,1,180,[[1603,100]]],
  [1506,1507,4,0,1,"이단 벌통","Two-Tier Hive","M_HIVE",36,1,180,[[1603,34],[1703,3]]],
  [1507,1508,5,0,1,"삼단 벌통","Three-Tier Hive","M_HIVE",36,1,180,[[1603,33],[1604,1],[1703,5]]],
  [1508,1509,6,0,1,"양봉장","Apiary","M_HIVE",36,1,180,[[1603,34],[1604,1],[1605,1],[1703,6]]],
  [1509,1510,7,0,1,"대형 양봉장","Grand Apiary","M_HIVE",36,1,180,[[1603,33],[1604,2],[1605,1],[1703,6]]],
  [1510,1511,8,0,1,"유리 벌통","Glass Hive","M_HIVE",36,1,180,[[1603,32],[1604,3],[1605,1],[1703,6]]],
  [1511,0,9,0,1,"마을 양봉원","Village Apiary","M_HIVE",36,1,180,[[1603,32],[1604,3],[1605,1],[1703,5],[1704,1]]],
  [1601,1602,0,0,0,"꽃가루","Pollen","R_HONEY",0,0,0,[]],
  [1602,1603,0,0,0,"꿀방울","Honey Drop","R_HONEY",0,0,0,[]],
  [1603,1604,1,0,0,"벌집 꿀","Comb Honey","R_HONEY",0,0,0,[]],
  [1604,1605,2,0,0,"꿀단지","Honey Jar","R_HONEY",0,0,0,[]],
  [1605,1606,3,0,0,"아카시아 꿀","Acacia Honey","R_HONEY",0,0,0,[]],
  [1606,1607,4,0,0,"야생화 꿀","Wildflower Honey","R_HONEY",0,0,0,[]],
  [1607,1608,5,0,0,"밤꿀","Chestnut Honey","R_HONEY",0,0,0,[]],
  [1608,1609,6,0,0,"벌집채 꿀","Honeycomb Jar","R_HONEY",0,0,0,[]],
  [1609,1610,7,0,0,"허니 디퍼","Honey Dipper","R_HONEY",0,0,0,[]],
  [1610,1611,8,0,0,"꿀 선물함","Honey Gift Box","R_HONEY",0,0,0,[]],
  [1611,1612,9,0,0,"꿀 진열대","Honey Display","R_HONEY",0,0,0,[]],
  [1612,0,10,0,0,"마을 꿀 세트","Village Honey Set","R_HONEY",0,0,0,[]],
  [1701,1702,0,0,0,"밀랍 부스러기","Wax Crumb","R_WAX",0,0,0,[]],
  [1702,1703,0,0,0,"밀랍 조각","Wax Chip","R_WAX",0,0,0,[]],
  [1703,1704,1,0,0,"밀랍 덩이","Wax Block","R_WAX",0,0,0,[]],
  [1704,1705,2,0,0,"정제 밀랍","Refined Wax","R_WAX",0,0,0,[]],
  [1705,1706,3,0,0,"밀랍 시트","Wax Sheet","R_WAX",0,0,0,[]],
  [1706,1707,4,0,0,"밀랍 블록","Wax Bar","R_WAX",0,0,0,[]],
  [1707,0,5,0,0,"밀랍 상자","Wax Box","R_WAX",0,0,0,[]],
  [1801,1802,0,0,0,"방석","Cushion","Q_CAT",0,0,0,[]],
  [1802,1803,0,0,0,"담요","Blanket","Q_CAT",0,0,0,[]],
  [1803,1804,1,0,0,"바구니","Basket","Q_CAT",0,0,0,[]],
  [1804,1805,2,0,1,"고양이 바구니","Cat Basket","Q_CAT",6,1,9000,[[1903,100]]],
  [1805,1806,3,0,1,"캣 하우스","Cat House","Q_CAT",8,1,14400,[[1903,90],[1904,10]]],
  [1806,1807,4,0,1,"캣 타워","Cat Tower","Q_CAT",10,1,19800,[[1903,80],[1904,15],[1905,5]]],
  [1807,0,5,0,1,"대형 캣 타워","Grand Cat Tower","Q_CAT",12,1,21600,[[1903,70],[1904,20],[1905,10]]],
  [1901,1902,0,0,0,"아기 고양이","Kitten","R_CAT",0,0,0,[]],
  [1902,1903,0,0,0,"턱시도","Tuxedo","R_CAT",0,0,0,[]],
  [1903,1904,1,0,0,"치즈태비","Ginger Tabby","R_CAT",0,0,0,[]],
  [1904,1905,2,0,0,"삼색이","Calico","R_CAT",0,0,0,[]],
  [1905,1906,3,0,0,"러시안 블루","Russian Blue","R_CAT",0,0,0,[]],
  [1906,1907,4,0,0,"브리티시 숏헤어","British Shorthair","R_CAT",0,0,0,[]],
  [1907,1908,5,0,0,"페르시안","Persian","R_CAT",0,0,0,[]],
  [1908,1909,6,0,0,"메인쿤","Maine Coon","R_CAT",0,0,0,[]],
  [1909,1910,7,0,0,"노르웨이숲","Norwegian Forest","R_CAT",0,0,0,[]],
  [1910,0,8,0,0,"스핑크스","Sphynx","R_CAT",0,0,0,[]],
  [2001,2002,0,0,0,"실 감개","Bobbin","Q_SEW",0,0,0,[]],
  [2002,2003,0,0,0,"바늘쌈","Needle Book","Q_SEW",0,0,0,[]],
  [2003,2004,1,0,1,"재봉 바구니","Sewing Basket","Q_SEW",4,1,3600,[[2103,10]]],
  [2004,2005,2,0,1,"반짇고리","Sewing Box","Q_SEW",6,1,7200,[[2103,90],[2104,10]]],
  [2005,2006,3,0,1,"재봉 상자","Sewing Chest","Q_SEW",8,1,10800,[[2103,80],[2104,15],[2105,5]]],
  [2006,0,4,0,1,"재봉 장","Sewing Cabinet","Q_SEW",10,1,14400,[[2103,75],[2104,15],[2105,10]]],
  [2101,2102,0,0,0,"단추","Button","R_EMB",0,0,0,[]],
  [2102,2103,0,0,0,"리본","Ribbon","R_EMB",0,0,0,[]],
  [2103,2104,1,0,0,"레이스","Lace","R_EMB",0,0,0,[]],
  [2104,2105,2,0,0,"자수 천","Embroidery Cloth","R_EMB",0,0,0,[]],
  [2105,2106,3,0,0,"자수 손수건","Embroidered Hanky","R_EMB",0,0,0,[]],
  [2106,2107,4,0,0,"자수 쿠션","Embroidered Cushion","R_EMB",0,0,0,[]],
  [2107,2108,5,0,0,"자수 액자","Embroidery Frame","R_EMB",0,0,0,[]],
  [2108,2109,6,0,0,"자수 벽걸이","Wall Hanging","R_EMB",0,0,0,[]],
  [2109,2110,7,0,0,"자수 커버","Embroidered Cover","R_EMB",0,0,0,[]],
  [2110,0,8,0,0,"자수 액자 세트","Frame Set","R_EMB",0,0,0,[]],
  [2201,0,0,0,1,"밀랍 냄비","Wax Pot","Q_WAX",6,1,7200,[[2303,12],[2403,1]]],
  [2301,2302,0,0,0,"초 토막","Candle Stub","R_CANDLE",0,0,0,[]],
  [2302,2303,0,0,0,"양초","Candle","R_CANDLE",0,0,0,[]],
  [2303,2304,1,0,0,"유리 캔들","Glass Candle","R_CANDLE",0,0,0,[]],
  [2304,2305,2,0,0,"향초","Scented Candle","R_CANDLE",0,0,0,[]],
  [2305,2306,3,0,0,"라벤더 캔들","Lavender Candle","R_CANDLE",0,0,0,[]],
  [2306,2307,4,0,0,"3심 캔들","Three-Wick Candle","R_CANDLE",0,0,0,[]],
  [2307,2308,5,0,0,"캔들 홀더","Candle Holder","R_CANDLE",0,0,0,[]],
  [2308,2309,6,0,0,"랜턴","Lantern","R_CANDLE",0,0,0,[]],
  [2309,2310,7,0,0,"캔들 세트","Candle Set","R_CANDLE",0,0,0,[]],
  [2310,0,8,0,0,"캔들 선물함","Candle Gift Box","R_CANDLE",0,0,0,[]],
  [2401,2402,0,0,0,"비누 조각","Soap Sliver","R_SOAP",0,0,0,[]],
  [2402,2403,0,0,0,"비누","Soap Bar","R_SOAP",0,0,0,[]],
  [2403,2404,1,0,0,"꽃비누","Flower Soap","R_SOAP",0,0,0,[]],
  [2404,2405,2,0,0,"허브 비누","Herbal Soap","R_SOAP",0,0,0,[]],
  [2405,2406,3,0,0,"배스밤","Bath Bomb","R_SOAP",0,0,0,[]],
  [2406,0,4,0,0,"비누 선물함","Soap Gift Box","R_SOAP",0,0,0,[]],
  [2501,2502,0,0,0,"붉은 상자","Red Chest","X_BOXR",8,0,0,[[701,2],[101,1],[401,1],[2701,2],[2801,2]]],
  [2502,0,0,0,0,"붉은 장식 상자","Fancy Red Chest","X_BOXR",12,0,0,[[702,2],[102,1],[402,1],[2701,1],[2801,1],[2702,3],[2802,3]]],
  [2601,2602,0,0,0,"초록 상자","Green Chest","X_BOXG",8,0,0,[[1501,2],[1001,1],[1201,1],[2701,2],[2801,2]]],
  [2602,0,0,0,0,"초록 장식 상자","Fancy Green Chest","X_BOXG",12,0,0,[[1502,2],[1002,1],[1202,1],[2701,1],[2801,1],[2702,3],[2802,3]]],
  [2701,2702,0,0,0,"동전 한 닢","A Coin","V_COIN",0,0,0,[]],
  [2702,2703,0,0,0,"동전 두 닢","A Couple of Coins","V_COIN",0,0,0,[]],
  [2703,2704,1,0,0,"잔돈","Spare Coins","V_COIN",0,0,0,[]],
  [2704,2705,2,0,0,"동전 더미","Stack of Coins","V_COIN",0,0,0,[]],
  [2705,0,3,0,0,"돈주머니","Coin Purse","V_COIN",0,0,0,[]],
  [2801,2802,0,0,0,"유리알 하나","A Single Gem","V_GEM",0,0,0,[]],
  [2802,2803,0,0,0,"유리알 둘","Couple of Gems","V_GEM",0,0,0,[]],
  [2803,2804,1,0,0,"유리알 몇 개","A Few Gems","V_GEM",0,0,0,[]],
  [2804,0,2,0,0,"유리알 한 줌","Handful of Gems","V_GEM",0,0,0,[]],
  [2901,2902,0,0,0,"불씨","Zap of Energy","V_SPARK",0,0,0,[]],
  [2902,2903,0,0,0,"잉걸불","Blast of Energy","V_SPARK",0,0,0,[]],
  [2903,2904,1,0,0,"화로 불꽃","Punch of Energy","V_SPARK",0,0,0,[]],
  [2904,2905,2,0,0,"타오르는 화로","Shock of Energy","V_SPARK",0,0,0,[]],
  [2905,0,3,0,0,"큰 화덕불","Big Bolt of Energy","V_SPARK",0,0,0,[]],
  [3001,0,0,0,0,"불씨 상자","Energy Chest","X_BOXE",5,0,0,[[2901,40],[2902,30],[2903,20],[2904,10]]],
  [3101,3102,0,0,0,"작은 이벤트 상자","Small Event Chest","X_BOXEV",6,0,0,[[807,4],[808,1],[905,2],[2803,1]]],
  [3102,3103,0,0,0,"이벤트 상자","Event Chest","X_BOXEV",8,0,0,[[808,3],[809,2],[905,1],[906,2],[2803,1],[2804,1]]],
  [3103,0,1,0,0,"큰 이벤트 상자","Grand Event Chest","X_BOXEV",10,0,0,[[808,2],[809,2],[906,4],[2804,1]]],
];
/* [코드, unlock_level, order_price, diff_score, weight, weight_multiple, repeat_weight_decrease] */
const ORDER_DB = [
  [203,3,2,2,100,1,0],
  [204,3,4,5,100,1,0],
  [205,3,8,10,100,1,0],
  [206,3,12,19,100,1,0],
  [207,3,20,39,100,1,0],
  [208,3,32,78,100,1,10],
  [209,3,50,146,100,1,50],
  [210,3,78,293,100,1,100],
  [303,4,2,2,100,1,0],
  [304,4,4,5,100,1,0],
  [305,4,8,10,100,1,10],
  [306,4,12,19,100,1,50],
  [307,4,20,39,100,1,100],
  [503,6,2,2,100,1,0],
  [504,6,4,5,100,1,0],
  [505,6,8,10,100,1,0],
  [506,6,12,19,100,1,0],
  [507,6,20,39,100,1,0],
  [508,6,32,78,100,1,0],
  [509,6,50,146,100,1,10],
  [510,6,78,293,100,1,50],
  [511,6,118,585,100,1,100],
  [512,6,178,1170,100,1,0],
  [513,6,270,2000,100,1,0],
  [514,6,406,2500,100,1,0],
  [603,7,2,2,100,1,0],
  [604,7,4,5,100,1,0],
  [605,7,8,10,100,1,10],
  [606,7,12,19,100,1,50],
  [607,7,20,39,100,1,100],
  [803,1,2,2,100,1,0],
  [804,1,4,5,100,1,0],
  [805,1,8,10,100,1,0],
  [806,1,12,19,100,1,0],
  [807,1,20,39,100,1,0],
  [808,1,32,78,100,1,0],
  [809,1,50,146,100,1,10],
  [810,1,78,293,100,1,50],
  [811,1,118,585,100,1,100],
  [812,1,178,1170,100,1,0],
  [903,2,2,2,100,1,0],
  [904,2,4,5,100,1,0],
  [905,2,8,10,100,1,10],
  [906,2,12,19,100,1,50],
  [907,2,20,39,100,1,100],
  [1103,9,2,2,100,1,0],
  [1104,9,4,5,100,1,0],
  [1105,9,8,10,100,1,0],
  [1106,9,12,19,100,1,0],
  [1107,9,20,39,100,1,0],
  [1108,9,32,78,100,1,0],
  [1109,9,50,146,100,1,10],
  [1110,9,78,293,100,1,50],
  [1111,9,118,585,100,1,100],
  [1112,9,178,1170,100,1,0],
  [1303,10,2,2,100,1,0],
  [1304,10,4,5,100,1,0],
  [1305,10,8,10,100,1,0],
  [1306,10,12,19,100,1,0],
  [1307,10,20,39,100,1,0],
  [1308,10,32,78,100,1,0],
  [1309,10,50,146,100,1,10],
  [1310,10,78,293,100,1,50],
  [1311,10,118,585,100,1,100],
  [1603,9,2,2,100,1,0],
  [1604,9,4,5,100,1,0],
  [1605,9,8,10,100,1,0],
  [1606,9,12,19,100,1,0],
  [1607,9,20,39,100,1,0],
  [1608,9,32,78,100,1,0],
  [1609,9,50,146,100,1,10],
  [1610,9,78,293,100,1,50],
  [1611,9,118,585,100,1,100],
  [1612,9,178,1170,100,1,0],
  [1703,9,2,2,100,1,0],
  [1704,9,4,5,100,1,0],
  [1705,9,8,10,100,1,10],
  [1706,9,12,19,100,1,50],
  [1707,9,20,39,100,1,100],
  [1903,4,2,2,100,1,0],
  [1904,4,4,5,100,1,0],
  [1905,4,8,10,100,1,0],
  [1906,4,12,19,100,1,0],
  [1907,4,20,39,100,1,0],
  [1908,4,32,78,100,1,10],
  [1909,4,50,146,100,1,50],
  [1910,4,78,293,100,1,100],
  [2103,10,2,2,100,1,0],
  [2104,10,4,5,100,1,0],
  [2105,10,8,10,100,1,0],
  [2106,10,12,19,100,1,0],
  [2107,10,20,39,100,1,0],
  [2108,10,32,78,100,1,10],
  [2109,10,50,146,100,1,50],
  [2110,10,78,293,100,1,100],
  [2303,24,2,2,100,1,0],
  [2304,24,4,5,100,1,0],
  [2305,24,8,10,100,1,0],
  [2306,24,12,19,100,1,0],
  [2307,24,20,39,100,1,0],
  [2308,24,32,78,100,1,10],
  [2309,24,50,146,100,1,50],
  [2310,24,78,293,100,1,100],
  [2403,24,2,2,100,1,0],
  [2404,24,4,5,100,1,10],
  [2405,24,8,10,100,1,50],
  [2406,24,12,19,100,1,100],
];
/* [order_type, slot_count, item_slot_max, refresh_sec, unlock_level, refill_max] */
const RULE_DB = [
  ["normal",2,3,3600,3,5],
  ["avatar",1,3,1800,3,0],
  ["special",1,3,900,4,0],
  ["event",1,3,300,6,0],
];
/* [order_type, band_seq, level_min, level_max, diff_sum_min, diff_sum_max, first_min, first_max, second_min, second_max, third_min, third_max] */
const BAND_DB = [
  ["normal",1,0,15,0,9999,0,6,0,4,0,3],
  ["normal",2,16,30,0,9999,0,6,0,5,0,3],
  ["avatar",1,0,15,0,9999,7,7,0,5,0,4],
  ["avatar",2,16,30,0,9999,7,7,0,6,0,5],
  ["special",1,0,7,0,9999,6,7,0,4,0,3],
  ["special",2,8,15,0,9999,7,8,0,4,0,3],
  ["special",3,16,29,0,9999,7,9,0,6,0,5],
  ["special",4,30,30,0,9999,7,10,0,6,0,5],
  ["event",1,0,7,0,9999,7,8,0,4,0,3],
  ["event",2,8,15,0,9999,7,9,0,5,0,4],
  ["event",3,16,29,0,9999,7,10,0,6,0,5],
  ["event",4,30,30,0,2000,8,11,0,7,0,6],
  ["event",5,30,30,2001,9999,9,11,0,7,0,6],
];
/* [level, item_count, count_weight] */
const COUNT_DB = [
  [1,1,6000],
  [1,2,2000],
  [1,3,2000],
  [4,1,4000],
  [4,2,3000],
  [4,3,3000],
  [8,1,3300],
  [8,2,3300],
  [8,3,3400],
  [11,1,3000],
  [11,2,3000],
  [11,3,4000],
];
/* [fixed_seq, unlock_level, slot_1, slot_2, slot_3, requirement_1, requirement_2, requirement_3] */
const FIXED_DB = [
  [1,1,1,0,0,803,0,0],
  [2,1,1,0,0,808,0,0],
  [3,1,1,0,0,804,0,0],
  [4,1,1,0,0,806,0,0],
  [5,2,1,2,0,904,0,0],
  [6,2,1,2,0,903,0,0],
  [7,2,1,2,0,903,806,0],
  [8,2,1,2,0,905,0,0],
  [9,2,1,2,0,808,0,0],
  [10,2,1,2,0,805,903,0],
  [11,3,1,2,0,204,204,0],
  [12,3,1,2,0,805,205,0],
  [13,3,1,2,0,205,203,0],
  [14,4,1,2,0,303,0,0],
  [15,4,3,0,0,207,804,903],
  [16,4,1,2,0,806,304,0],
];
/* [avatar_key, open_day, unlock_level] */
const AVATAR_DB = [
  ["Poppy",999,999],
  ["Hazel",999,999],
  ["Tess",999,999],
  ["Ada",1,1],
  ["Milo",1,1],
  ["June",1,1],
  ["Otis",1,2],
  ["Pip",1,3],
  ["Loren",1,4],
  ["Izzy",2,5],
  ["Barnett",3,7],
  ["Della",16,25],
  ["Nora",19,29],
];
/* [level, exp_cost] */
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
  "order_daily_diff_band_1": 2000,
  "order_daily_diff_band_2": 2500,
  "order_weight_mult_required_enough": 100,
  "order_weight_mult_not_required": 1000,
  "order_weight_mult_higher_level": 10000,
  "order_daily_diff_reset_utc_sec": 0,
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
  "toast_show_sec": 1
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
/* order_item — 주문 후보 107종. 생성기·상자·재화는 애초에 이 표에 없다.
   unlock_level 은 단계가 아니라 체인 단위다 — Lv3 이 되면 망치부터 공구 세트까지
   8종이 한꺼번에 후보가 된다. weight/weight_multiple 은 전 행 100/1 이라
   지금 가중식(상황 배수)에 곱해도 결과가 같아 곱하지 않는다 — 값이 갈리면 넣는다. */
function buildOrderItem() {
  return ORDER_DB.map(([item_code, unlock_level, order_price, diff_score,
                        weight, weight_multiple, repeat_weight_decrease]) => ({
    item_code, unlock_level, order_price, diff_score,
    weight, weight_multiple, repeat_weight_decrease, in_use: 1,
  }));
}

const DEFAULTS = () => ({
  /* const 48행 통째로 실물이다. order_repeat_reset_count 를 얹어 두었었는데 지웠다 —
     반복 감쇠가 카운터를 쓰지 않으므로(시트 셀 메모) 애초에 없는 게 맞는 값이었다.
     안 쓰는 칸은 그대로 둔다: 무엇을 아직 안 만졌는지가 여기서 드러난다
     (order_daily_diff_band_1/2 · order_daily_diff_reset_utc_sec = 하루 누적 난이도 축, 입력으로만). */
  const: { ...CONST_DB },
  /* 인벤토리 확장 27행 (6칸 → 32칸) — 실물 시트값. 등비 √2 곡선이라 코드로 다시 만들지 않는다 */
  inventory_unlock: INV_DB.map(([slot_index, cost_type, unlock_cost]) =>
    ({ slot_index, cost_type, unlock_cost, in_use: 1 })),
  order_rule: RULE_DB.map(([order_type, slot_count, item_slot_max, refresh_sec, unlock_level, refill_max]) =>
    ({ order_type, slot_count, item_slot_max, refresh_sec, unlock_level, refill_max, in_use: 1 })),
  order_slot_band: BAND_DB.map(([order_type, band_seq, level_min, level_max, diff_sum_min, diff_sum_max,
                                 first_min, first_max, second_min, second_max, third_min, third_max]) =>
    ({ order_type, band_seq, level_min, level_max, diff_sum_min, diff_sum_max,
       first_min, first_max, second_min, second_max, third_min, third_max, in_use: 1 })),
  /* 이벤트 점수 — 규칙은 기획서 1.2.1 [5] 그대로. 값은 시트가 정본이라
     여기 5행은 자리를 채우는 임시값이다(실물 시트로 갈아끼워야 한다).
     기준값이 무엇인지 기획서에 안 적혀 있어 난이도(diff)로 두었다 — 확인 필요. */
  event_order_score: [
    { score_min: 0, score_max: 4, token_pct: 0, token_fix: 1, in_use: 1 },
    { score_min: 5, score_max: 14, token_pct: 0, token_fix: 2, in_use: 1 },
    { score_min: 15, score_max: 29, token_pct: 2000, token_fix: 0, in_use: 1 },
    { score_min: 30, score_max: 59, token_pct: 2500, token_fix: 0, in_use: 1 },
    { score_min: 60, score_max: 9999, token_pct: 3000, token_fix: 0, in_use: 1 },
  ],
  order_item_count: COUNT_DB.map(([level, item_count, count_weight]) =>
    ({ level, item_count, count_weight, in_use: 1 })),
  order_fixed: FIXED_DB.map(([fixed_seq, unlock_level, slot_1, slot_2, slot_3,
                              requirement_1, requirement_2, requirement_3]) =>
    ({ fixed_seq, unlock_level, slot_1, slot_2, slot_3,
       requirement_1, requirement_2, requirement_3, in_use: 1 })),
  /* 손님 13명 — open_day 와 unlock_level 둘 다 걸린다(실물 칸) */
  order_avatar: AVATAR_DB.map(([avatar_key, open_day, unlock_level]) =>
    ({ avatar_key, open_day, unlock_level, in_use: 1 })),
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
const BUILD = "v5.0 · 2026-09-10";   // 인게임 재구조화(Rules/Model/FX/ViewGame) · 아트 224장
const SAVE_KEY = "rw.orderBench";
const SAVE_VER = 4;

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
    /* specSlotMax — 요구 종수 상한을 화면 기획서 정본(2)으로 누른다. 0 이면 시트 값(3).
       [GAP-3] 참조. 기본을 2 로 둔 건 기획서가 세 군데서 「확정」이라 못 박고, 시트 메모의
       근거가 바로 그 문서라서다. 개발자 조작에서 한 번 눌러 시트 값으로 되돌릴 수 있다. */
    specSlotMax: 2,
    day: 1, choreSeq: 0, sel: null, busy: false, orderFree: false, out: null,
    /* chain_repeat 은 죽은 필드라 뺐다 — 반복 감쇠가 「누적 카운터」에서 「직전 오더의
       체인 한 장」으로 정정되면서(시트 셀 메모) 셀 자리가 없어졌다. 감쇠 대상은 prevOfSlot 이다. */
    orderGen: { rng_state: RNG.save(), fixed_next_seq: 1, type_timers: {} },
    slots: {}, prevOfSlot: {}, log: [],
  };
}

/* order_rule 실물 4타입 — normal 이 2칸(슬롯 1·2 예산 공유) · avatar · special · event */
const TYPE_KO = { normal: "일반", avatar: "손님", special: "스페셜", event: "이벤트", fixed: "고정" };
const slotType = (n) => (n === 1 || n === 2 ? "normal" : n === 3 ? "avatar" : n === 4 ? "special" : "event");
const ruleOf = (type) => idx().rule.get(type);

/* 칸이 언제 열리나 — 고정 오더는 order_fixed.unlock_level 로만 걸리고 order_rule 을 안 본다.
   그래서 고정 오더가 들어오는 칸(실물 1·2·3)은 그 최저 레벨부터 열어 두고,
   랜덤 발급 차단은 generateOrder [1] 이 따로 맡는다. 나머지 칸은 타입의 unlock_level 그대로. */
function slotNeed(n) {
  const r = ruleOf(slotType(n));
  const ruleLv = r ? r.unlock_level : 1;
  const fx = DATA.order_fixed.filter((f) => f.in_use && [f.slot_1, f.slot_2, f.slot_3].includes(n));
  return fx.length ? Math.min(ruleLv, ...fx.map((f) => f.unlock_level)) : ruleLv;
}
function allSlots() {
  return [1, 2, 3, 4, 5].map((n) => {
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

/* [GAP-3] 실물 칸 diff_sum_min/max — 하루 누적 난이도 축. 누적값은 호출자가 준다(기본 0).
   누적의 정의(발급 합인지 납품 합인지 · reset_utc 처리)가 기획 미확인이라 축만 뚫어 둔다.
   현 시트는 event Lv30 두 밴드만 갈리므로 기본 0 이면 종전 동작과 같다. */
const pickBand = (type, level, dailyDiff = 0) =>
  DATA.order_slot_band.filter((b) => b.order_type === type && b.in_use)
    .sort((a, b) => a.band_seq - b.band_seq)
    .find((b) => level >= b.level_min && level <= b.level_max
      && (b.diff_sum_min == null || (dailyDiff >= b.diff_sum_min && dailyDiff <= b.diff_sum_max))) || null;

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
      const slotOk = [fx.slot_1, fx.slot_2, fx.slot_3].includes(slotNo);
      const lvOk = level >= fx.unlock_level;
      if (slotOk && lvOk) {
        const reqs = [fx.requirement_1, fx.requirement_2, fx.requirement_3]
          .filter(Boolean).map((code) => ({ code, count: 1 }));
        const coin = reqs.reduce((a, q) => a + (oiOf(q.code)?.order_price || 0), 0);
        const diff = reqs.reduce((a, q) => a + (oiOf(q.code)?.diff_score || 0), 0);
        push(`<span class="k">[0] 고정 오더 채택</span> fixed_seq=${fx.fixed_seq} (unlock_level ${fx.unlock_level} ≤ Lv${level} · 슬롯 ${fx.slot_1}/${fx.slot_2}/${fx.slot_3} 에 ${slotNo} 포함)`);
        push(`    요구 ${reqs.map((q) => labelOf(q.code)).join(" + ")} · 랜덤 예산·대기 변경 없음`);
        if (!dry) S.orderGen.fixed_next_seq++;
        return { card: { slot: slotNo, type: "fixed", reqs, avatar: pickAvatar(), coin, diff, evt: eventScore({ coin, diff }, opts.eventId), band: null }, log: L };
      }
      push(`[0] 고정 오더 fixed_seq=${fx.fixed_seq} 미적용 (${!lvOk ? `unlock_level ${fx.unlock_level} > Lv${level}` : `슬롯 ${fx.slot_1}/${fx.slot_2}/${fx.slot_3} 에 ${slotNo} 없음`}) → 순번 유지, 랜덤 검사로`);
    }
  }

  // ---- [1] 예산·대기
  const rule = ruleOf(type);
  if (!rule) { push(`<span class="w">order_rule 에 ${type} 활성 행 없음</span>`); return { card: null, log: L }; }
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
  const dailyDiff = opts.dailyDiff ?? 0;                                // [GAP-3]
  const band = pickBand(type, level, dailyDiff);
  if (!band) { push(`<span class="w">[2] order_slot_band 에 Lv${level} 구간 없음 → 데이터 오류</span>`); return { card: null, log: L }; }
  push(`<span class="k">[2] 밴드</span> band_seq=${band.band_seq} (Lv ${band.level_min}~${band.level_max}${band.diff_sum_min != null ? ` · 누적 ${dailyDiff} ∈ ${band.diff_sum_min}~${band.diff_sum_max}` : ""}) · 첫째 ${band.first_min}~${band.first_max} · 둘째 ${band.second_min}~${band.second_max} · 셋째 ${band.third_min}~${band.third_max} 단계`);

  // ---- [3] 후보 집합
  const counts = opts.counts ?? boardCounts();
  const othersReq = opts.othersReq ?? requiredElsewhere(slotNo);
  const prev = opts.prev !== undefined ? opts.prev : S.prevOfSlot[slotNo];
  /* 반복 감쇠 대상 — 시트 order_item.repeat_weight_decrease 셀 메모 그대로다.
       「직전에 같은 체인이 오더로 나갔으면 그 아이템의 오더 등장 가중치를 이 값으로
        나눈다 — Weight / RepeatWeightDecrease. 생성기 산출과 무관하다.」  근거: GH 승계 · D-L4
     조건은 「직전 오더 한 장」이고 카운터가 아니다. 전에는 const.order_repeat_reset_count
     로 3회 감쇠를 유지했는데, 시트에 그 상수가 없는 게 정상이었다 — 규칙이 카운터를 안 쓴다.
     직전 요구 코드는 아예 제외되고(banned), 같은 체인의 다른 단계가 이 제수로 나뉜다. */
  const prevChains = new Set((prev || []).map(chainOf));
  const othersChains = new Set([...othersReq].map(chainOf));
  const banned = new Set([...othersReq]);
  if (prev) prev.forEach((c) => banned.add(c));
  push(`[3] 제외 item_code: ${banned.size ? [...banned].map(labelOf).join(", ") : "없음"} <span style="opacity:.65">(체인 전체 아님)</span>`);

  const pool = DATA.order_item.filter((o) => o.in_use && o.unlock_level <= level);
  /* [GAP-3] 요구 종수 상한 — 정본이 어긋난 자리다.
     시트 `order_rule.item_slot_max` 는 3(네 타입 전부)이고, 그 셀 메모의 근거가
     `uiux_ingame §5-3` 이라고 적혀 있다. 그런데 그 문서는 세 군데서 「요구 아이템
     2개 · 접시 슬롯 2칸(확정) · 가변 개수로 설계하지 않는다」라고 못 박는다 —
     **시트가 정본을 인용하면서 정본과 반대로 적었다.** 표 둘의 싸움이 아니다.
     어느 쪽으로 갈지는 문서 결정이라 여기서 못 정한다. 호출자가 고를 수 있게 열어 둔다:
     안 넘기면 시트 값 그대로라 「오더 추첨 분석」 페이지의 판정은 변하지 않는다.
     2 를 넘기면 후보 필터(아래 [5] 종수)에서 3종 행이 빠지고 남은 가중치로만 뽑는다
     — 시트를 정본대로 고쳤을 때와 같은 결과다(가중치는 상대값이라 재정규화가 필요 없다). */
  const slotMax = Math.min(rule.item_slot_max, opts.itemSlotMax ?? Infinity);
  const picked = [];
  const chosen = new Set();
  // 가중치를 실제로 나눈 체인 — 반복 카운터는 「뽑힌 것」이 아니라 「제한이 걸린 것」 기준이다
  const divided = new Set();

  for (let seat = 1; seat <= slotMax; seat++) {
    const lo = seat === 1 ? band.first_min : seat === 2 ? band.second_min : band.third_min;
    const hi = seat === 1 ? band.first_max : seat === 2 ? band.second_max : band.third_max;
    const cand = pool.filter((o) => {
      const st = stepOf(o.item_code);
      return st >= lo && st <= hi && !banned.has(o.item_code) && !chosen.has(o.item_code);
    });
    if (!cand.length) {
      push(`<span class="w">[4] 자리${seat} 후보 0</span> (${lo}~${hi}단계) → 이 자리 이후는 추첨하지 않는다`);
      break;
    }
    const rows = cand.map((o) => {
      const m = situationMult(o.item_code, othersReq, counts, C, othersChains);
      const div = prevChains.has(chainOf(o.item_code)) && o.repeat_weight_decrease > 0
        ? o.repeat_weight_decrease : 0;
      if (div) divided.add(chainOf(o.item_code));
      /* [GAP-1] 시트 기본 가중 = weight × weight_multiple. 전 행 100·1 이라 base=1 로
         오늘은 수치까지 종전과 같다(÷100 이 그 보정). 칸 머리의 「주머니 잔량 · 정규화 금지」가
         잔량 차감 의미일 수 있어 확인 필요 — 여기서는 상대 가중치로 읽는다. */
      const base = ((Number(o.weight) || 100) * (Number(o.weight_multiple) || 1)) / 100;
      return { o, base, mult: m.v, why: m.why, div, w: (base * m.v) / (div || 1) };
    });
    const total = rows.reduce((a, r) => a + r.w, 0);
    const win = rows[RNG.pick(rows.map((r) => r.w))];
    picked.push(win.o); chosen.add(win.o.item_code);

    const byWhy = {};
    rows.forEach((r) => { byWhy[r.why] = (byWhy[r.why] || 0) + 1; });
    push(`<span class="k">[4] 자리${seat}</span> 범위 ${lo}~${hi} · 후보 ${cand.length}종 [${Object.entries(byWhy).map(([k, v]) => `${k} ${v}`).join(" / ")}]`);
    push(`    → <span class="p">${labelOf(win.o.item_code)}</span> 배수 ${win.mult}${win.base !== 1 ? ` ×기본 ${win.base}` : ""}${win.div ? ` ÷제수 ${win.div}` : ""} = 가중 ${win.w.toFixed(1)} / 합 ${total.toFixed(1)} = <span class="p">${((win.w / total) * 100).toFixed(2)}%</span>`);
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
    push(`    버린 후보 ${picked.slice(n).map((o) => labelOf(o.item_code)).join(", ")} — <span class="k">반복 카운터 갱신에는 포함</span>`);

  /* 감쇠가 걸린 체인만 로그에 남긴다 — 카운터를 유지하지 않으므로 상태 갱신이 없다.
     다음 발급의 감쇠 대상은 이 카드의 요구 체인(= prevOfSlot)에서 다시 계산된다. */
  if (divided.size)
    push(`    반복 감쇠 ${[...divided].map(chainName).join(", ")} <span style="opacity:.65">(직전 오더와 같은 체인 → 가중치 ÷제수)</span>`);

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

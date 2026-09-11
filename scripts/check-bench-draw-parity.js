/* 프로토타입 ↔ 오더 시뮬레이터 데이터 동등성 검사.
   ──────────────────────────────────────────────────────────────────────
   두 페이지는 엔진 파일 하나를 같이 읽으므로 **로직은 구조적으로 같다**.
   갈릴 수 있는 건 데이터뿐이다 — 벤치는 엔진에 박힌 DEFAULTS(*_DB 블록),
   오더 시뮬레이터는 docs/data/rosewood-balance.json 을 읽는다.
   실제로 event_order_score 가 임시값으로 남아 Lv30 이벤트 점수가 94 대 24 로 갈린 적이 있다.

   같은 시드로 두 데이터셋을 돌려 카드(타입·요구·코인·난이도·이벤트 점수)를 전수 비교한다.
   주의: vm 컨텍스트에서 `ctx.DATA = ...` 는 엔진의 `let DATA` 바인딩을 못 덮는다.
        반드시 컨텍스트 **안에서** 대입해야 한다 — 안 그러면 둘 다 같은 데이터로 돌고
        「불일치 0」이 거짓으로 나온다.

   사용:  node scripts/check-bench-draw-parity.js     (레포 루트에서)
   ────────────────────────────────────────────────────────────────────── */
const fs=require('fs'), vm=require('vm');
const src=fs.readFileSync('docs/js/rosewood-order-engine.js','utf8');
const B=JSON.parse(fs.readFileSync('docs/data/rosewood-balance.json','utf8'));
function run(useJson){
  const ctx={document:{querySelector:()=>null},localStorage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}},window:{},console};
  ctx.__BAL=JSON.parse(JSON.stringify(B));
  for(const r of ctx.__BAL.item_spec) if(r.name==null&&r.name_ko!=null) r.name=r.name_ko;
  vm.createContext(ctx); vm.runInContext(src,ctx);
  if(useJson) vm.runInContext('DATA = __BAL; IDX=null; reindex();',ctx);
  vm.runInContext('S = freshState()',ctx);
  const out=[];
  for(let lv=1;lv<=30;lv++) for(const slot of [1,2,3,4,5,6]) for(const seed of [1,20260911,777777]){
    vm.runInContext(`RNG.load(${seed}); S.level=${lv}; S.slots={}; S.prevOfSlot={}; S.orderGen={rng_state:RNG.save(),fixed_next_seq:1,chain_repeat:{},type_timers:{}};`,ctx);
    const r=vm.runInContext(`generateOrder(${slot},{dry:true,level:${lv}})`,ctx);
    const c=r.card;
    out.push(c? `${c.type}|${c.reqs.map(q=>q.code).join('+')}|${c.coin}|${c.diff}|${c.evt}` : `null|${r.locked?'lock':r.failed?'fail':r.scripted?'script':'none'}`);
  }
  return out;
}
const a=run(false), b=run(true);
let diff=0, samples=[];
for(let i=0;i<a.length;i++) if(a[i]!==b[i]){ diff++; if(samples.length<5) samples.push(`  벤치 ${a[i]}  /  드로우 ${b[i]}`); }
console.log(`전수 ${a.length}건 (Lv1~30 × 슬롯1~6 × 시드3) · 불일치 ${diff}건`);
samples.forEach(s=>console.log(s));

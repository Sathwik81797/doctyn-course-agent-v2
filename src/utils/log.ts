let stageIndex = 0;
let stageTotal = 0;

export const log = {
  setStageTotal(n: number) {
    stageTotal = n;
    stageIndex = 0;
  },
  stage(name: string, detail = "") {
    stageIndex++;
    console.log("");
    console.log(`[${stageIndex}/${stageTotal}] ${name}${detail ? ` — ${detail}` : ""}`);
  },
  info(msg: string) {
    console.log(`    ${msg}`);
  },
  ok(msg: string) {
    console.log(`  ✓ ${msg}`);
  },
  reuse(msg: string) {
    console.log(`  ↺ ${msg} (reused from checkpoint)`);
  },
  warn(msg: string) {
    console.warn(`  ! ${msg}`);
  },
  fail(msg: string) {
    console.error(`  ✗ ${msg}`);
  },
};

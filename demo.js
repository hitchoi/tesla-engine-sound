// 데모 주행: 공회전 블립 → 풀 가속 → 발 떼기(팝) → 부분 가속 → 정속 → 제동 → REV 길게
// [시작 초, 입력]. 다음 칸이 올 때까지 그 입력을 유지한다.
const STEPS = [
  [0, {}],
  [0.9, { rev: true }],
  [1.25, {}],
  [2.0, { rev: true }],
  [2.35, {}],
  [3.2, { gas: 1 }],
  [8.6, {}],
  [11.6, { gas: 0.45 }],
  [14.0, { hold: true }],
  [16.0, { brake: 0.75 }],
  [22.5, {}],
  [23.5, { rev: true }],
  [25.3, {}],
];

export const DEMO_LEN = 27.5;

export function demoInput(t) {
  let cur = STEPS[0][1];
  for (const [at, v] of STEPS) {
    if (t >= at) cur = v;
    else break;
  }
  return { gas: cur.gas || 0, brake: cur.brake || 0, hold: !!cur.hold, rev: !!cur.rev };
}

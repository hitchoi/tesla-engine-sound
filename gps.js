// GPS 위치를 속도·가속도로 바꾼다. 위치는 이 브라우저 안에서만 쓰고 어디로도 보내지 않는다.
// 위치 갱신은 보통 1초에 한 번이고 몇 m씩 흔들리므로, 속도·가속도 두 상태를 갖는
// 칼만 필터로 거른다. 다음 갱신까지는 추정 가속도로 이어 그린다.

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const RAD = Math.PI / 180;
const JERK = 4; // 가속도가 얼마나 빨리 바뀔 수 있다고 볼지(m²/s⁵)

export function distance(a, b) {
  const dLat = (b.lat - a.lat) * RAD,
    dLon = (b.lon - a.lon) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(s)));
}

export class SpeedEstimator {
  constructor() {
    this.reset();
  }
  reset() {
    this.prev = null;
    this.recent = [];
    this.v = 0;
    this.a = 0;
    this.P = [4, 0, 0, 4]; // 공분산 [vv, va, av, aa]
    this.tFix = 0;
    this.arrival = 0;
    this.n = 0;
  }
  // fix: { lat, lon, speed(m/s 또는 null), accuracy(m), t(ms) }, now: performance.now()
  push(fix, now) {
    // 최근 위치들이 2초 넘게 작은 원 안에 머물면 서 있는 것으로 본다(신호 대기 중 흔들림)
    this.recent.push(fix);
    while (this.recent.length > 2 && fix.t - this.recent[1].t >= 2000) this.recent.shift();
    const still =
      this.recent.length >= 3 &&
      fix.t - this.recent[0].t >= 2000 &&
      this.recent.every((r) => distance(r, fix) < Math.max(3, (fix.accuracy || 10) * 0.5));
    let z, sz;
    if (fix.speed != null && Number.isFinite(fix.speed) && fix.speed >= 0) {
      z = fix.speed; // 도플러 속도: 위치 차이보다 훨씬 정확하다
      sz = 0.4 + 0.02 * z;
    } else if (this.prev) {
      const dt = (fix.t - this.prev.t) / 1000;
      if (dt < 0.25) return;
      // 두 위치 사이 평균 속도는 구간 가운데 시각의 속도라 반 구간만큼 앞으로 당긴다
      z = distance(this.prev, fix) / dt + (this.a * dt) / 2;
      const rel = clamp((fix.accuracy || 10) * 0.2, 0.5, 4);
      sz = (Math.SQRT2 * rel) / dt;
      if (z < sz) z = 0; // 서 있을 때의 흔들림
    } else {
      this.prev = fix;
      return;
    }
    this.prev = fix;
    if (z > 95) return;
    if (still && fix.speed == null && this.v < 2.5) {
      this.v = 0;
      this.a = 0;
      this.tFix = fix.t;
      this.arrival = now;
      this.n++;
      return;
    }
    const dt = this.n ? (fix.t - this.tFix) / 1000 : 0;
    if (!this.n || dt > 5 || dt <= 0) {
      this.v = z;
      this.a = 0;
      this.P = [sz * sz, 0, 0, 1];
    } else {
      this.predict(dt);
      this.correct(z, sz * sz);
    }
    this.a = clamp(this.a, -11, 11);
    if (this.v < 0.3) this.v = 0;
    this.tFix = fix.t;
    this.arrival = now;
    this.n++;
  }
  predict(dt) {
    const d = Math.exp(-dt / 3); // 가속도는 시간이 지나면 0 쪽으로 돌아간다
    const [p00, p01, p10, p11] = this.P;
    this.v += this.a * dt;
    this.a *= d;
    const q = JERK;
    const n00 = p00 + dt * (p10 + p01) + dt * dt * p11 + (q * dt ** 3) / 3;
    const n01 = d * (p01 + dt * p11) + (q * dt * dt) / 2;
    const n10 = d * (p10 + dt * p11) + (q * dt * dt) / 2;
    const n11 = d * d * p11 + q * dt;
    this.P = [n00, n01, n10, n11];
  }
  correct(z, r) {
    const [p00, p01, p10, p11] = this.P;
    const s = p00 + r,
      k0 = p00 / s,
      k1 = p10 / s,
      y = z - this.v;
    this.v += k0 * y;
    this.a += k1 * y;
    this.P = [(1 - k0) * p00, (1 - k0) * p01, p10 - k1 * p00, p11 - k1 * p01];
  }
  sample(now) {
    if (!this.n) return { v: 0, a: 0, age: Infinity };
    const age = (now - this.arrival) / 1000;
    const v = Math.max(0, this.v + this.a * Math.min(age, 1.2));
    const a = age < 2.5 ? this.a : this.a * Math.exp(-(age - 2.5));
    return { v, a, age };
  }
}

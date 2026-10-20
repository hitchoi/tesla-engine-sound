// 속도(GPS 또는 시험 주행 페달)를 엔진 상태로 바꾼다.
// 회전수·기어·부하·팝 구간·터보 압력과 소리 이벤트를 만들어 dsp.js 로 넘긴다.

const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const sstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const ease = (dt, tau) => 1 - Math.exp(-dt / tau);

// 그 속도를 유지하는 데 드는 스로틀
const cruiseLoad = (v) => 0.1 + 0.22 * clamp(v / 38);

// GPS 가속도 → 스로틀 추정. intensity 가 클수록 같은 가속에도 더 깊이 밟은 것으로 본다
export function gpsThrottle(v, a, intensity) {
  const cruise = cruiseLoad(v);
  if (v < 0.3 && a < 0.2) return 0;
  if (a >= 0.1) return clamp(cruise + (a / 3.2) * (0.55 + 1.1 * intensity));
  if (a > -0.35) return clamp(cruise * (1 + a / 0.35));
  return 0;
}

export class Drive {
  constructor() {
    this.settings = { intensity: 0.5, character: 0.5, crackle: 0.35 };
    this.events = [];
    this.on = false;
    this.v = 0;
    this.aSm = 0;
    this.t = 0;
    this.o = {};
  }

  setPreset(p) {
    this.p = p;
    this.gear = 0;
    this.shift = null;
    this.lastShift = -9;
    this.rpm = p.idle || 0;
    this.boost = 0;
    this.overrunT = 0;
    this.thr = 0;
    this.thrSlow = 0;
    this.thrPeak = 0;
    this.loadPeak = 0;
    this.revLvl = 0;
    this.push = 0;
    this.startT = 99;
    this.bovCool = 0;
    this.limiter = false;
  }

  start() {
    this.on = true;
    this.startT = 0;
    this.events.push('ignite');
  }

  stop() {
    this.on = false;
  }

  takeEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  // inp: { mode: 'gps'|'test', gpsV, gpsA, gas, brake, hold, rev }
  update(dt, inp) {
    const p = this.p,
      S = this.settings;
    this.t += dt;
    let thrIn;
    if (inp.mode === 'test') {
      const gas = inp.gas || 0,
        brake = inp.brake || 0;
      let acc;
      if (inp.hold && gas === 0) {
        acc = -brake * 9.5;
        thrIn = cruiseLoad(this.v);
      } else {
        const loss = this.shift && this.shift.up ? p.shiftLoss || 0 : 0;
        const push = gas * Math.min(p.grip, p.pw / Math.max(this.v, 3)) * (1 - loss);
        const drag = 0.00042 * this.v * this.v + (this.v > 0.05 ? 0.1 : 0) + (gas === 0 && this.v > 0.5 ? 0.45 : 0);
        acc = push - drag - brake * 9.5;
        thrIn = gas;
      }
      const v0 = this.v;
      this.v = clamp(this.v + acc * dt, 0, p.vmax / 3.6);
      const aReal = dt > 0 ? (this.v - v0) / dt : 0;
      this.aSm += (aReal - this.aSm) * ease(dt, 0.12);
    } else {
      this.v += ((inp.gpsV || 0) - this.v) * ease(dt, 0.25);
      if (this.v < 0.05) this.v = 0;
      this.aSm += ((inp.gpsA || 0) - this.aSm) * ease(dt, 0.2);
      thrIn = gpsThrottle(this.v, this.aSm, S.intensity);
    }
    this.thr += (thrIn - this.thr) * ease(dt, 0.07);
    this.thrSlow += (this.thr - this.thrSlow) * ease(dt, 0.4);
    this.mode = inp.mode;
    this.thrPeak = Math.max(this.thr, this.thrPeak - dt * 0.6);
    const revHeld = !!inp.rev && this.v < 1;
    this.revLvl += ((revHeld ? 1 : 0) - this.revLvl) * ease(dt, revHeld ? 0.5 : 0.8);

    const o = this.o;
    o.on = this.on;
    o.kind = p.kind;
    o.speed = this.v;
    o.rev = this.revLvl;
    o.starter = 0;
    o.limiter = false;
    o.cut = 0;
    o.boost = 0;
    o.overrun = 0;
    o.push = 0;
    o.regen = 0;
    o.thrust = 0;
    if (p.kind === 'ice') this.ice(dt, revHeld);
    else if (p.kind === 'thruster') this.thruster(dt, revHeld);
    else this.ev(dt, revHeld);
    return o;
  }

  ice(dt, revHeld) {
    const p = this.p,
      S = this.settings,
      o = this.o;
    const vk = this.v * 3.6,
      thr = this.thr,
      n = p.gearMax.length;
    const rpmAt = (g) => (p.redline * vk) / p.gearMax[g];
    let load = thr,
      cut = 0,
      limiter = false;
    this.startT += dt;
    const neutral = vk < 1.2 && (thr < 0.15 || revHeld);

    if (neutral) {
      this.gear = 0;
      this.shift = null;
      if (this.startT < 0.55) {
        // 시동 모터가 크랭크를 돌린다
        this.rpm = 230 + 25 * Math.sin(this.t * 40);
        load = 0.05;
        o.starter = 1;
      } else if (this.startT < 0.85) {
        // 첫 폭발 뒤 회전이 확 솟는다
        this.rpm += (Math.min(p.idle * 1.9, p.idle + 1400) - this.rpm) * ease(dt, 0.06);
        load = 0.55;
      } else if (revHeld) {
        const top = p.idle + (p.limiter + 250 - p.idle) * clamp(0.7 + 0.4 * S.intensity);
        this.rpm = Math.min(top, this.rpm + p.rise * dt * (0.55 + 0.45 * S.intensity));
        load = 1;
      } else {
        const above = this.rpm - p.idle;
        this.rpm = Math.max(p.idle, this.rpm - p.fall * dt * clamp(above / 900 + 0.12));
        load = this.rpm > p.idle * 1.3 ? 0 : 0.12;
      }
      if (this.rpm >= p.limiter) {
        limiter = true;
        this.rpm = p.limiter;
      }
    } else {
      // GPS 는 속도가 흔들리므로 변속 간격을 넉넉히 두고, 내리는 판단은 느린 스로틀로 한다
      const gap = p.minGap * (this.mode === 'gps' ? 1.6 : 1);
      if (!this.shift && this.t - this.lastShift > gap) {
        const k = (x) => clamp(Math.pow(x, 1.15 - 0.5 * S.intensity) * (0.6 + 0.8 * S.intensity));
        const up = p.idle + (p.redline - p.idle) * clamp(0.22 + 0.76 * k(Math.max(thr, this.thrSlow)), 0.22, 0.985);
        const down = p.idle * 1.08 + (p.redline - p.idle) * (0.05 + 0.4 * k(this.thrSlow));
        const g = this.gear;
        if (g < n - 1 && (rpmAt(g) > up || rpmAt(g) >= p.limiter * 0.995)) this.beginShift(g + 1, true);
        else if (g > 0 && rpmAt(g) < down && rpmAt(g - 1) < up * 0.93) this.beginShift(g - 1, false);
      }
      let target = Math.max(rpmAt(this.gear), p.idle * 0.98);
      // 출발할 때 클러치가 미끄러지며 회전이 먼저 오른다
      const slipV = 14;
      if (this.gear === 0 && vk < slipV) {
        const launch = p.idle + (p.redline * 0.4 * (0.7 + 0.6 * S.intensity) - p.idle) * thr;
        target = Math.max(target, launch + (rpmAt(0) - launch) * (vk / slipV));
      }
      let tau = 0.05;
      if (this.shift) {
        const s = this.shift;
        s.t += dt;
        const f = clamp(s.t / s.dur);
        const rFrom = Math.max(rpmAt(s.from), p.idle),
          rTo = Math.max(rpmAt(s.to), p.idle);
        if (s.up && p.manual) {
          // 수동: 클러치를 밟고 발을 떼면 회전이 떨어졌다가 다시 물린다
          load = 0;
          target = f < 0.8 ? Math.max(rTo * 0.92, s.rpm0 - p.fall * s.t) : rTo;
          tau = 0.03;
        } else if (s.up) {
          cut = f < 0.7 && thr > 0.25 ? 1 : 0;
          target = rFrom + (rTo - rFrom) * sstep(0, 1, f);
          tau = 0.02;
        } else {
          // 내릴 때는 회전을 맞추려고 한 번 띄운다
          if (f < 0.6) load = Math.max(load, 0.55);
          target = rTo * (f < 0.6 ? 1.04 : 1);
          tau = 0.04;
        }
        if (f >= 1) {
          this.gear = s.to;
          this.shift = null;
        }
      }
      this.rpm += (target - this.rpm) * ease(dt, tau);
      if (this.rpm >= p.limiter) {
        this.rpm = p.limiter;
        limiter = thr > 0.3;
      }
    }

    // 발을 떼면 팝 구간이 열리고 몇 초에 걸쳐 잦아든다
    if (thr < 0.06 && !revHeld && this.rpm > p.idle * 1.4) this.overrunT += dt;
    else this.overrunT = 0;
    o.overrun = this.overrunT > 0 ? Math.exp(-this.overrunT / (0.7 + 2.3 * S.crackle)) : 0;

    if (p.tone.turbo) {
      const tgt = load * sstep(1300, 3300, this.rpm) * (cut ? 0.6 : 1);
      this.boost += (tgt - this.boost) * ease(dt, tgt > this.boost ? 0.55 : 0.2);
      this.bovCool -= dt;
      this.loadPeak = Math.max(load, this.loadPeak - dt * 1.5);
      if (this.loadPeak > 0.5 && load < 0.12 && this.boost > 0.45 && this.bovCool <= 0) {
        this.events.push('bov');
        this.bovCool = 1.2;
        this.loadPeak = 0;
      }
      o.boost = this.boost;
    }

    // 리미터에 닿으면 회전이 튕긴다
    const bounce = limiter ? 140 * Math.abs(Math.sin(this.t * Math.PI * 14)) : 0;
    o.rpm = this.rpm - bounce;
    o.load = load;
    o.cut = cut;
    o.limiter = limiter;
    o.gearLabel = neutral ? 'N' : String((this.shift && this.shift.up ? this.shift.from : this.gear) + 1);
    o.readout = o.rpm;
    o.unit = 'rpm';
    o.gauge = clamp(o.rpm / (p.limiter * 1.02));
    o.red = p.redline / (p.limiter * 1.02);
  }

  ev(dt, revHeld) {
    const p = this.p,
      S = this.settings,
      o = this.o;
    const a = this.aSm;
    let tgt = clamp(((a - 0.15) / 2.6) * (0.6 + S.intensity));
    if (revHeld) tgt = 1;
    this.push += (tgt - this.push) * ease(dt, tgt > this.push ? 0.12 : 0.45);
    o.push = this.push;
    o.regen = clamp(-a / 3);
    o.load = this.push;
    const motor = p.motorMax * clamp(Math.max(this.v * 3.6, this.revLvl * 80) / p.vmax);
    o.rpm = motor;
    o.gearLabel = this.v < 0.3 ? 'P' : 'D';
    o.readout = motor;
    o.unit = 'rpm';
    o.gauge = clamp(motor / p.motorMax);
    o.red = 1;
  }

  thruster(dt, revHeld) {
    const o = this.o;
    const fire = revHeld || this.thr > 0.85;
    o.thrust = fire ? 1 : 0;
    o.load = this.thr;
    this.push += ((fire ? 1 : 0) - this.push) * ease(dt, fire ? 0.05 : 0.35);
    o.rpm = 0;
    o.gearLabel = this.v < 0.3 ? 'P' : 'D';
    o.readout = Math.round(this.push * 100);
    o.unit = '추력 %';
    o.gauge = this.push;
    o.red = 1;
  }

  beginShift(to, up) {
    this.shift = { from: this.gear, to, up, t: 0, dur: up ? this.p.shift : this.p.shift * 0.8, rpm0: this.rpm };
    this.lastShift = this.t;
  }
}

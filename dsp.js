// 엔진·모터 소리 합성기.
// Web Audio API 에 기대지 않는 순수 계산 코드라 AudioWorklet, ScriptProcessor 대체 경로,
// Node 시험(test/render.mjs)에서 똑같이 돈다. 녹음 파일은 쓰지 않는다.

const TAU = Math.PI * 2;
const BLOCK = 32; // 계수 갱신 단위(샘플)
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const sstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

export class Rng {
  constructor(seed = 1) {
    this.s = seed | 0 || 1;
  }
  next() {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x;
    return (x >>> 0) / 4294967296;
  }
  bi() {
    return this.next() * 2 - 1;
  }
}

// 상태변수 필터(TPT). tick 뒤 lp·bp·hp 를 읽는다. bp*k 는 중심 이득 1.
class SVF {
  constructor() {
    this.ic1 = 0;
    this.ic2 = 0;
    this.k = 1;
    this.a1 = 0;
    this.a2 = 0;
    this.a3 = 0;
    this.lp = 0;
    this.bp = 0;
    this.hp = 0;
  }
  set(fc, q, sr) {
    const g = Math.tan((Math.PI * clamp(fc, 10, sr * 0.45)) / sr);
    this.k = 1 / q;
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
    return this;
  }
  tick(x) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2;
    this.bp = v1;
    this.hp = x - this.k * v1 - v2;
    return v2;
  }
}

// 대역 제한 톱니파(polyBLEP)
class Saw {
  constructor(ph = 0) {
    this.ph = ph;
  }
  tick(inc) {
    let t = this.ph + inc;
    if (t >= 1) t -= 1;
    this.ph = t;
    let v = 2 * t - 1;
    if (t < inc) {
      const x = t / inc;
      v -= x + x - x * x - 1;
    } else if (t > 1 - inc) {
      const x = (t - 1) / inc;
      v -= x * x + x + x + 1;
    }
    return v;
  }
}

// 천천히 떠도는 무작위 값(-1~1)
class Drift {
  constructor(rng, hz) {
    this.rng = rng;
    this.hz = hz;
    this.v = 0;
    this.t = 0;
    this.n = 0;
  }
  step(n, sr) {
    this.n += n;
    if (this.n * this.hz >= sr) {
      this.n = 0;
      this.t = this.rng.bi();
    }
    this.v += (this.t - this.v) * Math.min(1, (n * this.hz * 1.5) / sr);
    return this.v;
  }
}

// ── 내연기관 ────────────────────────────────────────────────
// 크랭크 각도를 돌리며 실린더마다 점화 순서대로 배기 펄스를 만든다.
// 펄스는 뱅크별 배기관(되먹임 지연선)과 머플러(저역 필터)를 지나고,
// 흡기 울림·기계음·터보·슈퍼차저·팝이 더해진다.
class IceVoice {
  constructor(sr, rng, p) {
    this.sr = sr;
    this.rng = rng;
    this.p = p;
    const t = (this.t = p.tone);
    // 실린더마다 아주 조금씩 다른 세기·타이밍(완벽히 고른 엔진은 기계처럼 들린다)
    this.cyl = p.firing
      .map((f) => {
        const a0 = clamp((f.a + rng.bi() * 1.2 + 720) % 720, 1, 718);
        return { a0, a: a0, bank: f.bank, g: 1 + rng.bi() * 0.07 };
      })
      .sort((x, y) => x.a - y.a);
    this.theta = 0;
    this.base = 0;
    this.idx = 0;
    this.fires = 0;
    this.banks = t.pipe.map((len) => ({
      exc: 0,
      z1: 0,
      z2: 0,
      dcx: 0,
      dcy: 0,
      buf: new Float32Array(Math.max(8, Math.round(((2 * len) / 480) * sr))),
      w: 0,
      lp: 0,
      crack: 0,
      pulse: 0,
      out: 0,
      muff: new SVF(),
      boom: new SVF(),
    }));
    this.howl = new SVF();
    this.intake = new SVF();
    this.clat = new SVF();
    this.tick = 0;
    this.whoosh = new SVF();
    this.bovF = new SVF();
    this.hunt = new Drift(rng, 2.6);
    this.rpm = p.idle;
    this.load = 0.1;
    this.trbPh = 0;
    this.scPh = 0;
    this.whPh = 0;
    this.stPh = 0;
    this.bov = 0;
    this.bovT = 0;
    this.time = 0;
  }

  trigger(name) {
    if (name === 'bov' && this.t.turbo && this.t.turbo.bov > 0) {
      this.bov = 1;
      this.bovT = 0;
    }
  }

  pop(b, cr, c) {
    const rng = this.rng;
    let s = (0.45 + rng.next()) * (0.6 + 0.8 * cr);
    if (rng.next() < 0.12 * cr) s *= 2.2; // 가끔 큰 뱅
    b.exc += s * 0.9;
    b.crack = Math.max(b.crack, s * (0.3 + 0.6 * c) * this.t.crackTone);
  }

  fire(cyl, P) {
    const t = this.t,
      rng = this.rng,
      b = this.banks[cyl.bank];
    const c = P.character,
      cr = P.crackle;
    this.fires++;
    if (P.limiter && this.fires % 3 !== 0) {
      // 리미터: 연료를 끊어 점화를 건너뛴다
      if (rng.next() < 0.06 + 0.2 * cr * t.pops) this.pop(b, cr, c);
      return;
    }
    // 다음 사이클 점화 시점을 조금 흔든다(연소는 매번 똑같지 않다)
    cyl.a = cyl.a0 + rng.bi() * (0.8 + 4 * P.overrun);
    this.tick = t.clatter * (0.4 + 0.6 * this.rpmN) * (0.6 + 0.4 * rng.next());
    let A = (0.06 + 0.94 * Math.pow(this.load, 0.75)) * (0.6 + 0.4 * this.rpmN) * cyl.g;
    A *= (1 - 0.85 * P.cut) * (1 + t.idleBoost * this.idleF);
    A *= 1 + rng.bi() * (0.12 + 0.08 * this.rpmN + t.lope * (0.3 + c) * this.idleF * 0.55 + 0.4 * P.overrun);
    if (this.idleF > 0 && rng.next() < t.lope * c * this.idleF * 0.05) A *= 0.15; // 캠 오버랩 실화
    b.exc += A;
    let pp = cr * t.pops * P.overrun * sstep(1500, 4500, this.rpm) * 0.3;
    if (P.cut > 0.5) pp += cr * t.pops * 0.22;
    if (rng.next() < pp) this.pop(b, cr, c);
  }

  render(L, R, off, n, P) {
    const sr = this.sr,
      t = this.t,
      p = this.p,
      rng = this.rng,
      inv = 1 / sr;
    this.rpm += (P.rpm - this.rpm) * (1 - Math.exp(-n / (sr * 0.03)));
    this.load += (P.load - this.load) * (1 - Math.exp(-n / (sr * 0.04)));
    const c = P.character,
      l = this.load;
    this.rpmN = clamp((this.rpm - p.idle) / (p.redline - p.idle));
    const rpmN = this.rpmN;
    this.idleF = 1 - sstep(p.idle * 1.05, p.idle * 2.2, this.rpm);
    // 공회전 헌팅(럼피 캠일수록 크게 출렁인다)
    const hunt = this.hunt.step(n, sr);
    const rpm = Math.max(60, this.rpm * (1 + hunt * (t.lope * (0.3 + c) * this.idleF * 0.05 + 0.006)));
    const degPS = (rpm * 6) / sr;
    const tauS = clamp((t.tau * (1.25 - 0.45 * l) * (1.15 - 0.3 * c)) / degPS, 1.5, sr * 0.025);
    const pole = Math.exp(-1 / tauS),
      ip = 1 - pole;
    const edge = clamp(t.edge * (0.7 + 0.6 * c));
    const rasp = t.rasp * (0.35 + c) * (0.4 + 0.8 * l + 1.2 * P.overrun);
    const flow = t.flow * (0.3 + 0.7 * l) * Math.pow(0.15 + rpmN, 1.2) * (0.6 + 0.6 * c);
    const fb = t.pipeFb * (0.75 + 0.35 * c);
    const muffHz = Math.min(
      7500,
      t.muffle * (0.7 + 0.9 * c + 1.6 * c * c) * (0.7 + 0.55 * l) * (0.85 + 0.45 * rpmN) * (P.overrun > 0.05 ? 0.8 : 1),
    );
    for (const b of this.banks) {
      b.muff.set(muffHz, 0.75, sr);
      b.boom.set(t.boom * (0.9 + 0.3 * rpmN), t.boomQ, sr);
    }
    this.howl.set(t.howl * (0.85 + 0.35 * rpmN), t.howlQ, sr);
    this.clat.set(t.clatterHz, 1.8, sr);
    this.intake.set(t.intakeHz * (0.8 + 0.7 * rpmN), 1.3, sr);
    const howlG = t.howlGain * (0.1 + 0.9 * l) * Math.pow(rpmN, 1.3) * (0.6 + 0.6 * c);
    const intakeG = t.intake * (0.15 + 0.85 * l) * (0.2 + rpmN);
    const crackK = Math.exp(-1 / (sr * 0.006));
    const tickK = Math.exp(-1 / (sr * 0.0018));
    const gl0 = 0.5 + 0.5 * t.spread,
      gl1 = 0.5 - 0.5 * t.spread;
    // 휘잉: 기어(모든 차), 슈퍼차저, 터보
    const wp = P.whinePitch,
      wv = P.whineVol;
    const whInc = ((rpm / 60) * 7.3 * wp) * inv;
    const whG = t.whine * (0.2 + 0.8 * l) * rpmN * wv * 2;
    const sc = t.sc;
    const scInc = sc ? ((rpm / 60) * sc.ratio * wp) * inv : 0;
    const scG = sc ? sc.gain * (0.15 + 0.85 * l) * (0.2 + rpmN) * (0.4 + 1.2 * wv) : 0;
    const tb = t.turbo;
    let trbInc = 0,
      trbG = 0,
      whooshG = 0;
    if (tb) {
      trbInc = ((tb.f0 + tb.f1 * P.boost) * wp) * inv;
      trbG = tb.gain * P.boost * P.boost * (0.5 + wv);
      whooshG = tb.gain * 1.6 * P.boost * l;
      this.whoosh.set(2400, 0.9, sr);
      if (this.bov > 1e-3) this.bovF.set(900 + 1700 * this.bov, 1.6, sr);
    }
    const bovK = Math.exp(-1 / (sr * 0.22));
    const stG = P.starter * 0.22,
      stInc = 175 * inv;
    const gain = t.gain;

    for (let i = off, e = off + n; i < e; i++) {
      this.theta += degPS;
      while (this.theta >= this.cyl[this.idx].a + this.base) {
        this.fire(this.cyl[this.idx], P);
        if (++this.idx >= this.cyl.length) {
          this.idx = 0;
          this.base += 720;
        }
      }
      if (this.theta >= 720 && this.base >= 720) {
        this.theta -= 720;
        this.base -= 720;
      }
      let sum = 0;
      for (let k = 0; k < this.banks.length; k++) {
        const b = this.banks[k];
        b.z1 = b.z1 * pole + b.exc;
        b.z2 = b.z2 * pole + ip * b.z1;
        b.exc = 0;
        const env = b.z1 * edge + b.z2 * Math.E * (1 - edge);
        // 직류 제거
        const x0 = env + rng.bi() * (rasp * env + flow);
        const x = x0 - b.dcx + 0.995 * b.dcy;
        b.dcx = x0;
        b.dcy = x;
        b.pulse = x;
        sum += x;
        // 배기관: 열린 끝에서 뒤집혀 돌아오는 반사
        const rd = b.buf[b.w];
        b.lp += (rd - b.lp) * 0.3;
        const y = x + fb * b.lp;
        b.buf[b.w] = y;
        if (++b.w >= b.buf.length) b.w = 0;
        b.muff.tick(y);
        b.boom.tick(y);
        let o = b.muff.lp + t.boomGain * b.boom.bp * b.boom.k;
        if (b.crack > 1e-4) {
          o += rng.bi() * b.crack;
          b.crack *= crackK;
        }
        b.out = o;
      }
      this.howl.tick(sum);
      this.intake.tick(rng.bi());
      this.clat.tick(rng.bi() * this.tick);
      this.tick *= tickK;
      let common =
        this.howl.bp * this.howl.k * howlG + this.intake.bp * this.intake.k * intakeG + this.clat.bp * this.clat.k;
      if (whG > 1e-5) {
        this.whPh += whInc;
        if (this.whPh >= 1) this.whPh -= 1;
        common += Math.sin(TAU * this.whPh) * whG;
      }
      if (scG > 0) {
        this.scPh += scInc;
        if (this.scPh >= 1) this.scPh -= 1;
        common += (Math.sin(TAU * this.scPh) + 0.35 * Math.sin(2 * TAU * this.scPh)) * scG;
      }
      if (tb) {
        this.trbPh += trbInc;
        if (this.trbPh >= 1) this.trbPh -= 1;
        this.whoosh.tick(rng.bi());
        common += Math.sin(TAU * this.trbPh) * trbG + this.whoosh.bp * this.whoosh.k * whooshG;
        if (this.bov > 1e-3) {
          this.bovF.tick(rng.bi());
          common += this.bovF.bp * this.bovF.k * this.bov * tb.bov * (0.6 + 0.4 * Math.sin(TAU * 28 * this.bovT));
          this.bov *= bovK;
          this.bovT += inv;
        }
      }
      if (stG > 0) {
        this.stPh += stInc;
        if (this.stPh >= 1) this.stPh -= 1;
        const s = Math.sin(TAU * this.stPh);
        common += (s + 0.4 * s * s * s) * stG * (0.7 + 0.3 * Math.sin(TAU * 9 * this.time));
      }
      this.time += inv;
      const b0 = this.banks[0].out,
        b1 = this.banks[1].out;
      L[i] = (b0 * gl0 + b1 * gl1 + common) * gain;
      R[i] = (b0 * gl1 + b1 * gl0 + common) * gain;
    }
  }
}

// ── 전기 모터(ElectricZen) ─────────────────────────────────
// 모터 회전에 맞춘 버즈. 느릴 땐 낮고 굵게, 빠를 땐 가볍게.
// 일정 속도·회생 때는 거의 들리지 않는 험만 남는다.
class EvVoice {
  constructor(sr, rng, p) {
    this.sr = sr;
    this.rng = rng;
    this.p = p;
    this.saw = new Saw(0);
    this.saw2 = new Saw(0.37);
    this.subPh = 0;
    this.w1 = 0;
    this.w2 = 0;
    this.f = new SVF();
    this.g = new SVF();
    this.v = 0;
    this.amp = 0;
  }
  trigger() {}
  render(L, R, off, n, P) {
    const sr = this.sr,
      inv = 1 / sr,
      rng = this.rng;
    const vIn = Math.max(P.speed, P.rev * 22);
    this.v += (vIn - this.v) * (1 - Math.exp(-n / (sr * 0.06)));
    const tgt = P.regen > 0.15 ? 0.03 : 0.05 + 0.95 * P.push;
    this.amp += (tgt - this.amp) * (1 - Math.exp(-n / (sr * (tgt > this.amp ? 0.08 : 0.35))));
    const c = P.character;
    const fm = (16 + this.v * 12.5) * P.whinePitch;
    this.f.set(fm * (2.2 + 5 * this.amp + 7 * c), 0.9 + c, sr);
    this.g.set(fm * 7.5, 5, sr);
    const subG = 0.9 * (1 - sstep(4, 28, this.v));
    const out = this.amp * sstep(0.2, 2.5, this.v) * this.p.tone.gain;
    const wv = P.whineVol;
    for (let i = off, e = off + n; i < e; i++) {
      const s = this.saw.tick(fm * inv) + 0.45 * this.saw2.tick(fm * 2.003 * inv);
      this.subPh += fm * 0.5 * inv;
      if (this.subPh >= 1) this.subPh -= 1;
      this.f.tick(s + rng.bi() * c * 0.25);
      this.g.tick(rng.bi() * s);
      this.w1 += fm * 6 * inv;
      if (this.w1 >= 1) this.w1 -= 1;
      this.w2 += fm * 9.5 * inv;
      if (this.w2 >= 1) this.w2 -= 1;
      const o =
        (this.f.lp +
          Math.sin(TAU * this.subPh) * subG +
          this.g.bp * this.g.k * c * 0.6 +
          (Math.sin(TAU * this.w1) * 0.08 + Math.sin(TAU * this.w2) * 0.05) * wv) *
        out;
      L[i] = o;
      R[i] = o;
    }
  }
}

// ── 포르쉐 타이칸(일렉트릭 스포츠 사운드 느낌) ──────────────
// 낮게 깔린 웅웅거림 위로 속도 따라 오르는 화음. 가속할수록 필터가 열려 밝아지고,
// 좌우로 살짝 다른 음정을 줘서 넓게 퍼진다.
class TaycanVoice {
  constructor(sr, rng, p) {
    this.sr = sr;
    this.rng = rng;
    this.p = p;
    this.ph = new Float64Array(3);
    this.sl = [new Saw(0.1), new Saw(0.6)];
    this.sr2 = [new Saw(0.3), new Saw(0.85)];
    this.fl = new SVF();
    this.fr = new SVF();
    this.air = new SVF();
    this.v = 0;
    this.amp = 0.2;
    this.lfo = 0;
    this.ign = 0;
  }
  trigger(name) {
    if (name === 'ignite') this.ign = 1.6;
  }
  render(L, R, off, n, P) {
    const sr = this.sr,
      inv = 1 / sr,
      rng = this.rng;
    const vIn = Math.max(P.speed, P.rev * 24);
    this.v += (vIn - this.v) * (1 - Math.exp(-n / (sr * 0.08)));
    let ignAmp = 0,
      ignF = 0;
    if (this.ign > 0) {
      // 시동: 아래에서 위로 쓸어 올렸다가 제자리로
      const t = 1.6 - this.ign;
      ignF = 70 * Math.sin(Math.PI * clamp(t / 1.4));
      ignAmp = 0.6 * Math.sin(Math.PI * clamp(t / 1.6));
      this.ign -= n * inv;
    }
    const moving = sstep(0.2, 3, this.v);
    const tgt = P.regen > 0.15 ? 0.14 : 0.18 + 0.82 * P.push;
    this.amp += (tgt - this.amp) * (1 - Math.exp(-n / (sr * (tgt > this.amp ? 0.12 : 0.5))));
    const c = P.character;
    const f0 = (42 + this.v * 5.2 + ignF) * P.whinePitch * (P.regen > 0.15 ? 0.985 : 1);
    this.lfo += n * inv * 0.12;
    const sweep = 1 + 0.15 * Math.sin(TAU * this.lfo);
    const fc = f0 * (3 + 9 * this.amp + 4 * c) * sweep;
    this.fl.set(fc, 1.4, sr);
    this.fr.set(fc * 1.06, 1.4, sr);
    this.air.set(f0 * 8, 2, sr);
    const lvl = (0.25 * (1 - moving) + this.amp * moving + ignAmp) * this.p.tone.gain;
    const airG = 0.3 * P.push * moving;
    const wv = 0.5 + P.whineVol;
    for (let i = off, e = off + n; i < e; i++) {
      this.ph[0] += f0 * inv;
      if (this.ph[0] >= 1) this.ph[0] -= 1;
      this.ph[1] += f0 * 0.5 * inv;
      if (this.ph[1] >= 1) this.ph[1] -= 1;
      this.ph[2] += f0 * 3 * inv;
      if (this.ph[2] >= 1) this.ph[2] -= 1;
      const core = Math.sin(TAU * this.ph[0]) * 0.8 + Math.sin(TAU * this.ph[1]) * 0.7;
      const hi = Math.sin(TAU * this.ph[2]) * 0.18 * this.amp * wv;
      const sl = this.sl[0].tick(f0 * 1.5 * 1.004 * inv) * 0.35 + this.sl[1].tick(f0 * 2.002 * inv) * 0.25;
      const sr_ = this.sr2[0].tick(f0 * 1.5 * 0.996 * inv) * 0.35 + this.sr2[1].tick(f0 * 1.998 * inv) * 0.25;
      this.fl.tick(sl);
      this.fr.tick(sr_);
      this.air.tick(rng.bi());
      const a = this.air.bp * this.air.k * airG;
      L[i] = (core + this.fl.lp + hi + a) * lvl;
      R[i] = (core + this.fr.lp + hi + a) * lvl;
    }
  }
}

// ── 테슬라 로드스터(냉가스 추진기) ──────────────────────────
// 평소엔 조용하고, 풀 가속이나 REV 때만 초음속 공기 분사가 터진다.
class ThrusterVoice {
  constructor(sr, rng, p) {
    this.sr = sr;
    this.rng = rng;
    this.p = p;
    this.T = 0;
    this.lpL = new SVF();
    this.lpR = new SVF();
    this.rum = new SVF().set(140, 0.8, sr);
    this.hiss = new SVF().set(3800, 0.7, sr);
    this.screech = new SVF().set(3400, 9, sr);
    this.turb = new Drift(rng, 34);
    this.thump = 0;
    this.prev = 0;
    this.crack = 0;
  }
  trigger() {}
  render(L, R, off, n, P) {
    const sr = this.sr,
      rng = this.rng;
    const tgt = P.thrust;
    this.T += (tgt - this.T) * (1 - Math.exp(-n / (sr * (tgt > this.T ? 0.05 : 0.35))));
    if (this.T > 0.12 && this.prev <= 0.12) this.thump = 1;
    this.prev = this.T;
    const T = this.T;
    if (T < 1e-4 && this.thump < 1e-4) {
      for (let i = off, e = off + n; i < e; i++) L[i] = R[i] = 0;
      return;
    }
    const fc = 900 + 5200 * T;
    this.lpL.set(fc, 0.7, sr);
    this.lpR.set(fc * 0.94, 0.7, sr);
    const am = 1 + 0.35 * this.turb.step(n, sr);
    const g = Math.pow(T, 1.3) * am * this.p.tone.gain;
    const thK = Math.exp(-1 / (sr * 0.08)),
      crK = Math.exp(-1 / (sr * 0.004));
    for (let i = off, e = off + n; i < e; i++) {
      const nl = rng.bi(),
        nr = rng.bi();
      this.lpL.tick(nl);
      this.lpR.tick(nr);
      this.rum.tick((nl + nr) * 0.5 + this.thump * 6);
      this.hiss.tick(nl - nr);
      this.screech.tick(nl);
      if (rng.next() < 30 * T / sr) this.crack = 0.5 + rng.next() * 0.5; // 충격파 다이아몬드
      const cr = this.crack > 1e-3 ? rng.bi() * this.crack : 0;
      this.crack *= crK;
      const body = this.rum.lp * 2.4 + this.hiss.hp * 0.25 + this.screech.bp * this.screech.k * 0.12 + cr * 0.4;
      this.thump *= thK;
      L[i] = (this.lpL.lp + body) * g;
      R[i] = (this.lpR.lp + body) * g;
    }
  }
}

const VOICES = { ice: IceVoice, ev: EvVoice, taycan: TaycanVoice, thruster: ThrusterVoice };

export const DEFAULT_PARAMS = {
  on: false,
  rpm: 0,
  load: 0,
  overrun: 0,
  limiter: false,
  cut: 0,
  boost: 0,
  starter: 0,
  speed: 0,
  push: 0,
  regen: 0,
  rev: 0,
  thrust: 0,
  character: 0.5,
  crackle: 0.35,
  whinePitch: 1,
  whineVol: 0.5,
};

export class EngineDSP {
  constructor(sampleRate, seed = 1) {
    this.sr = sampleRate;
    this.rng = new Rng(seed);
    this.P = { ...DEFAULT_PARAMS };
    this.voice = null;
    this.next = null;
    this.fade = 0;
    this.hpL = new SVF().set(22, 0.7, sampleRate);
    this.hpR = new SVF().set(22, 0.7, sampleRate);
  }
  setPreset(p) {
    this.next = p;
    if (!this.voice || this.fade < 1e-3) this.swap();
  }
  swap() {
    this.voice = new VOICES[this.next.kind](this.sr, this.rng, this.next);
    this.next = null;
  }
  setParams(o) {
    for (const k in o) if (k in this.P) this.P[k] = o[k];
  }
  trigger(name) {
    if (this.voice) this.voice.trigger(name);
  }
  process(L, R, n) {
    const fadeK = 1 - Math.exp(-1 / (this.sr * 0.04));
    for (let off = 0; off < n; off += BLOCK) {
      const m = Math.min(BLOCK, n - off);
      const target = this.next ? 0 : this.P.on ? 1 : 0;
      if (!this.voice || (target === 0 && this.fade < 1e-4)) {
        for (let i = off; i < off + m; i++) L[i] = R[i] = 0;
        this.fade = 0;
      } else {
        this.voice.render(L, R, off, m, this.P);
        for (let i = off; i < off + m; i++) {
          this.fade += (target - this.fade) * fadeK;
          this.hpL.tick(L[i]);
          this.hpR.tick(R[i]);
          L[i] = Math.tanh(this.hpL.hp * this.fade);
          R[i] = Math.tanh(this.hpR.hp * this.fade);
        }
      }
      if (this.next && this.fade < 1e-3) this.swap();
    }
  }
}

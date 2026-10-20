// 오프라인 시험: 데모 주행을 차마다 합성해 WAV 로 저장하고 수치를 확인한다.
// 사용: node test/render.mjs [출력 폴더] [차 id ...]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PRESETS } from '../presets.js';
import { Drive } from '../drive.js';
import { EngineDSP } from '../dsp.js';
import { demoInput, DEMO_LEN } from '../demo.js';
import { SpeedEstimator } from '../gps.js';

const SR = 48000,
  CTRL = 60,
  STEP = SR / CTRL;
const outDir = process.argv[2] || 'test/out';
const only = process.argv.slice(3);
mkdirSync(outDir, { recursive: true });
const SETTINGS = { intensity: 0.5, character: 0.5, crackle: 0.35, whinePitch: 1, whineVol: 0.5 };

function wav(path, L, R) {
  const n = L.length,
    buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), 46 + i * 4);
  }
  writeFileSync(path, buf);
}

const rms = (a, s, e) => {
  let q = 0;
  for (let i = s; i < e; i++) q += a[i] * a[i];
  return Math.sqrt(q / Math.max(1, e - s));
};
const db = (x) => (20 * Math.log10(x + 1e-12)).toFixed(1);

// 데모 주행 합성
function renderDemo(p) {
  const drive = new Drive();
  Object.assign(drive.settings, SETTINGS);
  drive.setPreset(p);
  const dsp = new EngineDSP(SR, 7);
  dsp.setPreset(p);
  drive.start();
  const steps = Math.ceil(DEMO_LEN * CTRL);
  const L = new Float32Array(steps * STEP),
    R = new Float32Array(steps * STEP);
  const trace = [];
  let shifts = 0,
    lastGear = 'N',
    maxRpm = 0,
    maxKmh = 0,
    events = {};
  for (let s = 0; s < steps; s++) {
    const t = s / CTRL;
    const o = drive.update(1 / CTRL, { mode: 'test', ...demoInput(t) });
    for (const e of drive.takeEvents()) {
      dsp.trigger(e);
      events[e] = (events[e] || 0) + 1;
    }
    dsp.setParams({ ...o, ...SETTINGS });
    dsp.process(L.subarray(s * STEP, (s + 1) * STEP), R.subarray(s * STEP, (s + 1) * STEP), STEP);
    if (o.gearLabel !== lastGear) {
      shifts++;
      lastGear = o.gearLabel;
    }
    maxRpm = Math.max(maxRpm, o.rpm);
    maxKmh = Math.max(maxKmh, o.speed * 3.6);
    if (s % 30 === 0) trace.push(`${t.toFixed(1)}s ${(o.speed * 3.6).toFixed(0)}km/h ${o.gearLabel} ${Math.round(o.rpm)}`);
  }
  return { L, R, trace, shifts, maxRpm, maxKmh, events };
}

const seg = (t0, t1) => [Math.floor(t0 * SR), Math.floor(t1 * SR)];
const rows = [];
for (const p of PRESETS) {
  if (only.length && !only.includes(p.id)) continue;
  const t0 = Date.now();
  const r = renderDemo(p);
  const ms = Date.now() - t0;
  let peak = 0,
    nan = 0,
    clip = 0;
  for (let i = 0; i < r.L.length; i++) {
    const x = r.L[i];
    if (!Number.isFinite(x)) nan++;
    const ax = Math.abs(x);
    if (ax > peak) peak = ax;
    if (ax > 0.97) clip++;
  }
  wav(join(outDir, `${p.id}.wav`), r.L, r.R);
  rows.push({
    id: p.id,
    idle: db(rms(r.L, ...seg(1.3, 1.9))),
    full: db(rms(r.L, ...seg(4, 8.5))),
    lift: db(rms(r.L, ...seg(8.8, 11.4))),
    cruise: db(rms(r.L, ...seg(14.2, 15.8))),
    peak: peak.toFixed(2),
    clip,
    nan,
    shifts: r.shifts,
    maxRpm: Math.round(r.maxRpm),
    maxKmh: Math.round(r.maxKmh),
    events: JSON.stringify(r.events),
    cpu: `${((ms / 1000 / DEMO_LEN) * 100).toFixed(1)}%`,
  });
  if (only.length) console.log(r.trace.join('\n'));
}
console.table(rows);

// GPS 경로 시험: 1초마다 위치만 오고(speed=null) 위치가 흔들려도 회전수·기어가 요동치지 않는지.
// 흔들림 두 가지: 매번 ±2 m 무작위(가혹), 0.3 m씩 떠도는 오차(실제 GPS 에 가까움)
function gpsRun(noise, withDoppler) {
  const p = PRESETS.find((x) => x.id === 'gt3');
  const est = new SpeedEstimator();
  const drive = new Drive();
  drive.setPreset(p);
  drive.start();
  const prof = (t) => (t < 5 ? 0 : t < 15 ? (t - 5) * 2.5 : t < 30 ? 25 : t < 40 ? 25 - (t - 30) * 2.5 : 0); // m/s
  let dist = 0, walk = 0, maxJump = 0, prevRpm = null, gearChanges = 0, prevGear = null, lagErr = 0, idleMove = 0;
  const thrs = [];
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  for (let s = 0; s < 45 * CTRL; s++) {
    const t = s / CTRL, now = t * 1000;
    dist += prof(t) / CTRL;
    if (s % CTRL === 0) {
      walk += rnd() * 0.3;
      const j = noise === 'white' ? rnd() * 2 : walk;
      const speed = withDoppler ? Math.max(0, prof(t) + rnd() * 0.3) : null;
      est.push({ lat: 37.5 + (dist + j) / 111320, lon: 127, speed, accuracy: 6, t: now }, now);
    }
    const g = est.sample(now);
    const o = drive.update(1 / CTRL, { mode: 'gps', gpsV: g.v, gpsA: g.a });
    if (prevRpm != null && !drive.shift) maxJump = Math.max(maxJump, Math.abs(o.rpm - prevRpm));
    prevRpm = o.rpm;
    if (o.gearLabel !== prevGear) { gearChanges++; prevGear = o.gearLabel; }
    if (t > 8) lagErr = Math.max(lagErr, Math.abs(o.speed - prof(t - 0.8)));
    if (t > 19 && t < 29) thrs.push(drive.thr);
    if (t < 4.5 && o.speed > 0) idleMove++;
  }
  const mean = thrs.reduce((a, b) => a + b, 0) / thrs.length;
  const sd = Math.sqrt(thrs.reduce((a, b) => a + (b - mean) ** 2, 0) / thrs.length);
  return {
    noise: noise + (withDoppler ? '+doppler' : ''),
    gearChanges,
    maxRpmStepNoShift: Math.round(maxJump),
    lagErrKmh: (lagErr * 3.6).toFixed(1),
    cruiseThrMean: mean.toFixed(2),
    cruiseThrSd: sd.toFixed(2),
    stoppedButMoving: idleMove,
  };
}
console.table([gpsRun('white', false), gpsRun('walk', false), gpsRun('white', true)]);

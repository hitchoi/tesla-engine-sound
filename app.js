import { PRESETS, byId } from './presets.js';
import { Drive } from './drive.js';
import { SpeedEstimator } from './gps.js';
import { AudioEngine } from './audio.js';
import { demoInput, DEMO_LEN } from './demo.js';

const KEY = 'engine-sound.v1';
const DEFAULTS = {
  car: 'gt3',
  mode: 'gps',
  unit: 'kmh',
  volume: 0.8,
  intensity: 0.5,
  character: 0.5,
  crackle: 0.35,
  whinePitch: 1,
  whineVol: 0.5,
};
const st = { ...DEFAULTS };
try {
  Object.assign(st, JSON.parse(localStorage.getItem(KEY) || '{}'));
} catch {}
if (!PRESETS.some((p) => p.id === st.car)) st.car = DEFAULTS.car;
const save = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(st));
  } catch {}
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);

const audio = new AudioEngine();
const drive = new Drive();
const gps = new SpeedEstimator();
const inp = { mode: st.mode, gas: 0, brake: 0, hold: false, rev: false, gpsV: 0, gpsA: 0 };
let running = false;
let watchId = null;
let demo = null;
let wakeLock = null;
let fadeUntil = 0;

const preset = () => byId(st.car);
drive.setPreset(preset());
applySettings();

// ── 차량 목록 ─────────────────────────────
const carsEl = $('#cars');
PRESETS.forEach((p, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'car';
  b.dataset.id = p.id;
  b.innerHTML = `<small>${String(i + 1).padStart(2, '0')}</small><b></b><span></span>`;
  b.querySelector('b').textContent = p.name;
  b.querySelector('span').textContent = p.spec;
  b.addEventListener('click', () => selectCar(p.id));
  carsEl.appendChild(b);
});

function selectCar(id) {
  st.car = id;
  save();
  const p = preset();
  drive.setPreset(p);
  if (running) {
    audio.setPreset(p);
    drive.start();
  }
  renderStatic();
}

// ── 시동 ─────────────────────────────────
$('#btnStart').addEventListener('click', () => (running ? stopEngine() : startEngine()));

async function startEngine() {
  try {
    await audio.start();
  } catch (e) {
    toast(`소리를 켜지 못했습니다. (${e.message})`);
    return;
  }
  const p = preset();
  audio.setVolume(st.volume);
  audio.setPreset(p);
  drive.setPreset(p);
  drive.start();
  running = true;
  if (st.mode === 'gps') startGps();
  keepAwake();
  renderStatic();
}

function stopEngine() {
  running = false;
  drive.stop();
  stopGps();
  stopDemo();
  fadeUntil = performance.now() + 400;
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
  renderStatic();
}

async function keepAwake() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch {}
}

// ── GPS ──────────────────────────────────
let gpsState = 'off';
let gpsAcc = null;

function startGps() {
  if (watchId != null) return;
  if (!('geolocation' in navigator)) return setGps('unsupported');
  if (!window.isSecureContext) return setGps('insecure');
  gps.reset();
  setGps('wait');
  watchId = navigator.geolocation.watchPosition(onPos, onPosErr, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 20000,
  });
}

function stopGps() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  setGps('off');
}

function onPos(pos) {
  const c = pos.coords;
  gps.push(
    { lat: c.latitude, lon: c.longitude, speed: c.speed, accuracy: c.accuracy, t: pos.timestamp || Date.now() },
    performance.now(),
  );
  gpsAcc = c.accuracy;
  setGps('ok');
}

function onPosErr(e) {
  if (e.code === 1) {
    setGps('denied');
    toast('위치 권한이 꺼져 있습니다. 브라우저 설정에서 이 사이트의 위치를 허용하거나, 시험 주행을 써 주세요.');
  } else if (gpsState !== 'ok') {
    setGps('wait');
  }
}

function setGps(s) {
  gpsState = s;
  renderStatic();
}

// ── 주행 방식 ────────────────────────────
$$('[data-mode]').forEach((b) =>
  b.addEventListener('click', () => {
    st.mode = b.dataset.mode;
    save();
    inp.mode = st.mode;
    if (st.mode === 'gps') {
      stopDemo();
      releasePedals();
      if (running) startGps();
    } else {
      stopGps();
    }
    renderStatic();
  }),
);

$$('[data-unit]').forEach((b) =>
  b.addEventListener('click', () => {
    st.unit = b.dataset.unit;
    save();
    renderStatic();
  }),
);

// ── REV·페달 ─────────────────────────────
function holdButton(el, on, off) {
  let id = null;
  el.addEventListener('pointerdown', (e) => {
    id = e.pointerId;
    el.setPointerCapture(id);
    el.classList.add('held');
    on();
    e.preventDefault();
  });
  const end = (e) => {
    if (e.pointerId !== id) return;
    id = null;
    el.classList.remove('held');
    off();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('lostpointercapture', end);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

for (const el of [$('#btnRev'), $('#btnRev2')]) {
  holdButton(
    el,
    () => {
      stopDemo();
      inp.rev = true;
    },
    () => (inp.rev = false),
  );
}

// 페달: 누른 높이가 깊이. 가속 페달 맨 위(16%)는 속도 유지
const HOLD_ZONE = 0.16;
function bindPedal(el, set) {
  let id = null;
  const upd = (e) => {
    const r = el.getBoundingClientRect();
    set(clamp((e.clientY - r.top) / r.height));
  };
  el.addEventListener('pointerdown', (e) => {
    stopDemo();
    id = e.pointerId;
    el.setPointerCapture(id);
    el.classList.add('down');
    upd(e);
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerId === id) upd(e);
  });
  const end = (e) => {
    if (e.pointerId !== id) return;
    id = null;
    el.classList.remove('down');
    set(null);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('lostpointercapture', end);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

const pedGas = $('#pedGas'),
  pedBrake = $('#pedBrake');
bindPedal(pedGas, (y) => setGas(y));
bindPedal(pedBrake, (y) => setBrake(y));

function setGas(y) {
  if (y == null) {
    inp.gas = 0;
    inp.hold = false;
  } else if (y < HOLD_ZONE) {
    inp.gas = 0;
    inp.hold = true;
  } else {
    inp.hold = false;
    inp.gas = clamp(0.08 + ((y - HOLD_ZONE) / (1 - HOLD_ZONE)) * 0.92);
  }
}
function setBrake(y) {
  inp.brake = y == null ? 0 : clamp(0.1 + y * 0.9);
}
function releasePedals() {
  inp.gas = inp.brake = 0;
  inp.hold = inp.rev = false;
}

// 키보드(맥에서 시험할 때): ↑ 가속, ↓ 브레이크, 스페이스 REV
const keys = new Set();
addEventListener('keydown', (e) => {
  if (e.target.closest && e.target.closest('input')) return;
  if (!['ArrowUp', 'ArrowDown', ' '].includes(e.key)) return;
  e.preventDefault();
  keys.add(e.key);
  stopDemo();
  if (e.key === ' ') inp.rev = true;
  if (e.key === 'ArrowUp') inp.gas = 1;
  if (e.key === 'ArrowDown') inp.brake = 0.8;
});
addEventListener('keyup', (e) => {
  keys.delete(e.key);
  if (e.key === ' ') inp.rev = false;
  if (e.key === 'ArrowUp') inp.gas = 0;
  if (e.key === 'ArrowDown') inp.brake = 0;
});

// ── 데모 주행 ────────────────────────────
$('#btnDemo').addEventListener('click', async () => {
  if (demo) return stopDemo();
  if (!running) await startEngine();
  if (!running) return;
  drive.v = 0;
  demo = { t: 0 };
  renderStatic();
});
function stopDemo() {
  if (!demo) return;
  demo = null;
  releasePedals();
  renderStatic();
}

// ── 조절 ─────────────────────────────────
const fmt = {
  volume: (v) => `${Math.round(v * 100)}%`,
  intensity: (v) => `${Math.round(v * 100)}%`,
  character: (v) => `${Math.round(v * 100)}%`,
  crackle: (v) => `${Math.round(v * 100)}%`,
  whinePitch: (v) => `×${v.toFixed(2)}`,
  whineVol: (v) => `${Math.round(v * 100)}%`,
};
$$('input[data-key]').forEach((el) => {
  const k = el.dataset.key;
  el.value = st[k];
  const show = () => {
    const v = Number(el.value);
    $(`output[data-for="${k}"]`).textContent = fmt[k](v);
    el.style.setProperty('--p', `${((v - el.min) / (el.max - el.min)) * 100}%`);
  };
  show();
  el.addEventListener('input', () => {
    st[k] = Number(el.value);
    show();
    save();
    if (k === 'volume') audio.setVolume(st.volume);
    applySettings();
  });
});

function applySettings() {
  drive.settings.intensity = st.intensity;
  drive.settings.character = st.character;
  drive.settings.crackle = st.crackle;
}

// ── 루프: 주행 계산 → 소리 → 화면 ──────────
let last = performance.now();
const params = {};
function tick() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (demo) {
    demo.t += dt;
    if (demo.t > DEMO_LEN) stopDemo();
    else Object.assign(inp, demoInput(demo.t));
  }
  inp.mode = st.mode;
  if (st.mode === 'gps') {
    const g = gps.sample(now);
    inp.gpsV = g.v;
    inp.gpsA = g.a;
  }
  const o = drive.update(dt, inp);
  if (running || now < fadeUntil) {
    for (const e of drive.takeEvents()) audio.trigger(e);
    Object.assign(params, o, {
      character: st.character,
      crackle: st.crackle,
      whinePitch: st.whinePitch,
      whineVol: st.whineVol,
    });
    audio.setParams(params);
  } else {
    drive.takeEvents();
  }
  draw(o);
}
setInterval(tick, 16);

// ── 화면 ─────────────────────────────────
const el = {
  spd: $('#spd'),
  gear: $('#gear'),
  rpm: $('#rpm'),
  rpmUnit: $('#rpmUnit'),
  fill: $('#tachFill'),
  red: $('#tachRed'),
  pedGasFill: pedGas.querySelector('i'),
  pedBrakeFill: pedBrake.querySelector('i'),
};
const shown = {};
function put(key, node, text) {
  if (shown[key] !== text) {
    shown[key] = text;
    node.textContent = text;
  }
}

function draw(o) {
  const live = running;
  const v = st.unit === 'mph' ? o.speed * 2.23694 : o.speed * 3.6;
  put('spd', el.spd, String(Math.round(v)));
  put('gear', el.gear, live ? o.gearLabel : '–');
  const r = live ? o.readout : 0;
  put('rpm', el.rpm, o.unit === 'rpm' ? (Math.round(r / 10) * 10).toLocaleString('en-US') : String(Math.round(r)));
  put('rpmUnit', el.rpmUnit, o.unit);
  const g = live ? o.gauge : 0;
  el.fill.style.width = `${(g * 100).toFixed(1)}%`;
  el.fill.classList.toggle('hot', live && o.red < 1 && g >= o.red);
  el.red.style.width = o.red < 1 ? `${((1 - o.red) * 100).toFixed(1)}%` : '0';
  document.documentElement.style.setProperty('--thrust', live && o.kind === 'thruster' ? o.gauge.toFixed(3) : '0');
  // 시험 주행 페달 표시(데모·키보드 포함)
  const gasY = inp.hold ? HOLD_ZONE * 0.6 : inp.gas ? HOLD_ZONE + ((inp.gas - 0.08) / 0.92) * (1 - HOLD_ZONE) : 0;
  el.pedGasFill.style.height = `${gasY * 100}%`;
  pedGas.classList.toggle('down', inp.gas > 0 || inp.hold);
  pedGas.classList.toggle('hold', inp.hold);
  el.pedBrakeFill.style.height = `${inp.brake ? ((inp.brake - 0.1) / 0.9) * 100 : 0}%`;
  pedBrake.classList.toggle('down', inp.brake > 0);
  for (const b of [$('#btnRev'), $('#btnRev2')]) b.classList.toggle('held', inp.rev);
  window.__engine = { level: audio.measure(), rpm: o.rpm, speed: o.speed, gear: o.gearLabel, running, mode: audio.mode };
}

function renderStatic() {
  const p = preset();
  $('#carName').textContent = p.name;
  $('#carSpec').textContent = p.spec;
  $$('.car').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === st.car)));
  $$('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === st.mode)));
  $$('[data-unit]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.unit === st.unit)));
  $('#unitLbl').textContent = st.unit === 'mph' ? 'mph' : 'km/h';
  $('#gpsPane').hidden = st.mode !== 'gps';
  $('#testPane').hidden = st.mode !== 'test';
  const start = $('#btnStart');
  start.textContent = running ? '시동 끄기' : '엔진 시동';
  start.classList.toggle('on', running);
  $('#btnDemo').textContent = demo ? '■ 데모 멈춤' : '▶ 데모 주행';
  $('#btnDemo').classList.toggle('on', !!demo);
  const eng = $('#chipEng');
  eng.textContent = running ? '엔진 켜짐' : '엔진 꺼짐';
  eng.className = `chip ${running ? 'live' : ''}`;
  const chip = $('#chipGps');
  const gpsText = {
    off: st.mode === 'test' ? '시험 주행' : 'GPS 꺼짐',
    wait: 'GPS 기다리는 중',
    ok: `GPS 정상${gpsAcc ? ` ±${Math.round(gpsAcc)} m` : ''}`,
    denied: '위치 권한 없음',
    unsupported: 'GPS 없음',
    insecure: 'https 필요',
  }[gpsState];
  chip.textContent = gpsText;
  $('#gpsHint').textContent = {
    off: '시동을 걸면 위치 권한을 물어봅니다. 허용해야 속도에 맞춰 회전수가 오릅니다.',
    wait: '위치 신호를 기다리고 있습니다. 지하·건물 안에서는 늦게 잡힐 수 있습니다.',
    ok: '속도에 맞춰 회전수가 오르고 변속합니다. 신호 대기 중에는 REV를 길게 눌러 보세요.',
    denied: '위치 권한이 꺼져 있어 회전수가 오르지 않습니다. 브라우저 설정에서 허용하거나 시험 주행을 써 주세요.',
    unsupported: '이 브라우저는 위치를 지원하지 않습니다. 시험 주행을 써 주세요.',
    insecure: 'https 주소로 열어야 위치를 쓸 수 있습니다.',
  }[gpsState];
  chip.className = `chip ${{ ok: 'ok', wait: 'wait', denied: 'bad', unsupported: 'bad', insecure: 'bad' }[gpsState] || ''}`;
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 9000);
}

// 화면으로 돌아오면 소리를 다시 켠다
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && running) {
    audio.resume();
    keepAwake();
  }
});

// ── 호환성 ───────────────────────────────
{
  const AC = window.AudioContext || window.webkitAudioContext;
  const checks = [
    ['보안 연결(https)', window.isSecureContext],
    ['소리 합성(Web Audio)', !!AC],
    ['저지연 합성(AudioWorklet)', !!(AC && 'audioWorklet' in AC.prototype), '없음 · 대체 방식으로 동작'],
    ['위치(GPS)', 'geolocation' in navigator],
  ];
  for (const [name, ok, alt] of checks) {
    const li = document.createElement('li');
    li.className = ok || alt ? 'yes' : 'no';
    li.textContent = `${name} ${ok ? '지원' : alt || '없음'}`;
    $('#compat').appendChild(li);
  }
}

renderStatic();

import * as THREE from 'three';
import { Sky, fullscreenGeometry } from './sky.js';
import { Clouds, loadCloudAssets, CLOUD } from './clouds.js';
import { Terrain, WORLD } from './terrain.js';
import { loadModels, buildDiver, buildPlane, buildCanopy, Rings, WindStreaks } from './objects.js';
import { GameAudio } from './audio.js';

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- tuning
const JUMP_ALT = Number(params.get('alt')) || 4000;
const DEPLOY_MAX_ALT = 1500;
const AAD_ALT = 330;
const PLANE_SPEED = 46;
const PLANE_RADIUS = 1500;
const G = 9.81;

const TIMES = [
  { name: '黃金時刻', el: 10, az: 205, exposure: 0.7 },
  { name: '午後晴空', el: 42, az: 150, exposure: 0.5 },
  { name: '日落餘暉', el: 4, az: 232, exposure: 0.85 },
  { name: '清晨薄光', el: 9, az: 25, exposure: 0.72 },
];
let timeIndex = Number(params.get('t')) || 0;

// ---------------------------------------------------------------- renderer
const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.autoClear = false;

const camera = new THREE.PerspectiveCamera(62, 1, 0.5, 300000);
camera.position.set(0, JUMP_ALT, 0);

const bgScene = new THREE.Scene(); // sky + ground -> HDR target with depth
const fgScene = new THREE.Scene(); // actors, drawn over the cloud composite
fgScene.fog = new THREE.FogExp2(0xffffff, 0);

const sceneTarget = new THREE.WebGLRenderTarget(4, 4, {
  type: THREE.HalfFloatType,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  depthTexture: new THREE.DepthTexture(4, 4, THREE.FloatType),
});

const composite = new THREE.ShaderMaterial({
  uniforms: {
    tScene: { value: sceneTarget.texture },
    tCloud: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uDebug: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D tScene;
    uniform sampler2D tCloud;
    uniform vec2 uTexel;
    uniform int uDebug;
    void main() {
      vec3 scene = texture2D(tScene, vUv).rgb;
      // small tent filter hides the half-res march and its blue-noise jitter
      vec4 c = texture2D(tCloud, vUv) * 0.36;
      c += texture2D(tCloud, vUv + uTexel * vec2(1.0, 0.6)) * 0.16;
      c += texture2D(tCloud, vUv + uTexel * vec2(-0.6, 1.0)) * 0.16;
      c += texture2D(tCloud, vUv + uTexel * vec2(-1.0, -0.6)) * 0.16;
      c += texture2D(tCloud, vUv + uTexel * vec2(0.6, -1.0)) * 0.16;
      vec3 col = scene * c.a + c.rgb;
      if (uDebug > 0) col = c.rgb;
      vec2 q = vUv - 0.5;
      col *= 1.0 - 0.32 * dot(q, q);
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
  depthTest: false,
  depthWrite: false,
});
const compositeScene = new THREE.Scene();
const compositeMesh = new THREE.Mesh(fullscreenGeometry(), composite);
compositeMesh.frustumCulled = false;
compositeScene.add(compositeMesh);
const orthoCamera = new THREE.Camera();

// ---------------------------------------------------------------- world state
let sky, clouds, terrain, diver, plane, canopy, rings, streaks;
const audio = new GameAudio();

const bgSun = new THREE.DirectionalLight(0xffffff, 1);
const bgHemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
bgScene.add(bgSun, bgHemi);
const fgSun = new THREE.DirectionalLight(0xffffff, 1);
const fgHemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
fgScene.add(fgSun, fgSun.target, fgHemi);

const game = {
  phase: 'loading', // loading | menu | plane | freefall | opening | canopy | landed
  time: 0,
  phaseTime: 0,
  pos: new THREE.Vector3(),
  prevPos: new THREE.Vector3(),
  vel: new THREE.Vector3(),
  yaw: 0,
  yawRate: 0,
  pitch: 0,
  roll: 0,
  canopyOpen: 0,
  fwdSpeed: 0,
  sink: 0,
  camYaw: 0,
  camPitch: 0.36,
  camDist: 9,
  camLift: 1.8,
  viewYaw: 0, // user orbit offset
  viewPitch: 0,
  planeAngle: 0.6,
  planePos: new THREE.Vector3(),
  planeVel: new THREE.Vector3(),
  planeYaw: 0,
  inCloud: 0,
  cloudTime: 0,
  score: 0,
  combo: 0,
  ringsHit: 0,
  ringsTotal: 0,
  ringScore: 0,
  shake: 0,
  aad: false,
  touchdownSink: 0,
};
window.__game = game;

const keys = new Set();
const input = { x: 0, y: 0, dive: false };

// ---------------------------------------------------------------- helpers
const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const v3 = new THREE.Vector3();
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const fwdOf = (yaw, out) => out.set(-Math.sin(yaw), 0, -Math.cos(yaw));
const rightOf = (yaw, out) => out.set(Math.cos(yaw), 0, -Math.sin(yaw));
function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function applyTime() {
  const t = TIMES[timeIndex % TIMES.length];
  sky.setSun(t.el, t.az);
  renderer.toneMappingExposure = t.exposure;
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  sceneTarget.setSize(size.x, size.y);
  if (clouds) {
    clouds.setSize(size.x, size.y);
    composite.uniforms.uTexel.value.set(1 / clouds.target.width, 1 / clouds.target.height);
  }
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

// ---------------------------------------------------------------- HUD
const hud = {
  alt: $('alt'), vs: $('vs'), hs: $('hs'), score: $('score'), combo: $('combo'),
  prompt: $('prompt'), toast: $('toast'), keys: $('keys'), tick: $('altTick'),
  mkDz: $('mkDz'), mkRing: $('mkRing'),
  cache: {},
};
function setText(el, key, value) {
  if (hud.cache[key] !== value) {
    hud.cache[key] = value;
    el.textContent = value;
  }
}
function setPrompt(html, warn = false) {
  if (hud.cache.prompt !== html) {
    hud.cache.prompt = html;
    hud.prompt.innerHTML = html;
  }
  hud.prompt.classList.toggle('warn', warn);
}
function toast(text) {
  hud.toast.textContent = text;
  hud.toast.classList.remove('show');
  void hud.toast.offsetWidth;
  hud.toast.classList.add('show');
}
function layoutAltBar() {
  const pct = (a) => `${(1 - a / JUMP_ALT) * 100}%`;
  const cloud = document.querySelector('.altbar .cloud');
  cloud.style.top = pct(Math.min(CLOUD.top, JUMP_ALT));
  cloud.style.bottom = `${(CLOUD.bottom / JUMP_ALT) * 100}%`;
  const dep = document.querySelector('.altbar .deploy');
  dep.style.top = pct(Math.min(DEPLOY_MAX_ALT, JUMP_ALT));
  dep.style.bottom = `${(AAD_ALT / JUMP_ALT) * 100}%`;
  dep.style.left = '8px';
  dep.style.right = '-8px';
  dep.querySelector('span').style.right = '22px';
}
function placeMarker(el, world, label) {
  v1.copy(world).project(camera);
  const behind = v1.z > 1;
  let x = v1.x;
  let y = v1.y;
  if (behind) { x = -x; y = -y; }
  const m = 0.9;
  const off = behind || Math.abs(x) > m || Math.abs(y) > m;
  if (off) {
    const k = m / Math.max(Math.abs(x), Math.abs(y), 1e-3);
    x *= k;
    y *= k;
    if (behind && Math.abs(y) < m) y = -m; // keep "behind" markers on the bottom edge
  }
  el.style.display = 'block';
  el.style.transform = `translate(${((x * 0.5 + 0.5) * window.innerWidth).toFixed(1)}px, ${((-y * 0.5 + 0.5) * window.innerHeight).toFixed(1)}px)`;
  el.lastElementChild.textContent = label;
}

// ---------------------------------------------------------------- flow
function setPhase(p) {
  game.phase = p;
  game.phaseTime = 0;
}

function addScore(n) {
  game.score += Math.round(n);
}

function toMenu() {
  setPhase('menu');
  $('menu').classList.remove('hidden');
  $('result').classList.add('hidden');
  $('hud').classList.add('hidden');
}

function boardPlane() {
  audio.start();
  Object.assign(game, {
    score: 0, combo: 0, ringsHit: 0, ringsTotal: 0, ringScore: 0, cloudTime: 0, aad: false,
    canopyOpen: 0, viewYaw: 0, viewPitch: 0, inCloud: 0,
  });
  rings.clear();
  canopy.visible = false;
  diver.root.visible = false;
  $('menu').classList.add('hidden');
  $('result').classList.add('hidden');
  $('hud').classList.remove('hidden');
  hud.keys.textContent = 'W A S D 移動 · SHIFT 俯衝 · 拖曳滑鼠轉視角';
  setPhase('plane');
}

function spawnRings() {
  const dirToDz = v1.set(-game.pos.x, 0, -game.pos.z).normalize().clone();
  const perp = new THREE.Vector3(-dirToDz.z, 0, dirToDz.x);
  const start = game.pos.clone().addScaledVector(game.planeVel, 1.1);
  const span = JUMP_ALT - CLOUD.top;
  const above = span > 500 ? [0.22, 0.38, 0.54, 0.7, 0.86].map((k) => JUMP_ALT - span * k) : [];
  const below = [CLOUD.bottom - 170, CLOUD.bottom - 310, CLOUD.bottom - 450].filter((a) => a < JUMP_ALT - 80);
  [...above, ...below].forEach((alt, k) => {
    const along = 70 + 52 * k + (alt < CLOUD.bottom ? 110 : 0);
    const lateral = Math.sin(k * 1.9 + 0.7) * 38;
    rings.add(
      start.x + dirToDz.x * along + perp.x * lateral,
      alt,
      start.z + dirToDz.z * along + perp.z * lateral,
    );
  });
  game.ringsTotal = rings.items.length;
}

function jump() {
  rightOf(game.planeYaw, v2);
  game.pos.copy(game.planePos).addScaledVector(v2, 2.6);
  game.pos.y -= 1.4;
  game.prevPos.copy(game.pos);
  game.vel.copy(game.planeVel).addScaledVector(v2, 3.5);
  game.vel.y = -2;
  game.yaw = game.planeYaw;
  game.camYaw = game.planeYaw;
  game.pitch = -0.4;
  game.roll = 0;
  diver.root.visible = true;
  spawnRings();
  setPhase('freefall');
  toast('GO!');
  audio.blip(440, 0, 0.3, 'triangle');
}

function deploy(auto = false) {
  game.aad = auto;
  canopy.visible = true;
  game.fwdSpeed = Math.hypot(game.vel.x, game.vel.z);
  game.sink = -game.vel.y;
  if (game.fwdSpeed > 3) game.yaw = Math.atan2(-game.vel.x, -game.vel.z);
  game.shake = 1;
  setPhase('opening');
  audio.whump();
  toast(auto ? '緊急自動開傘！' : '開傘！');
  hud.keys.textContent = 'A D 轉向 · W 加速下降 · S 煞車';
  if (!auto) addScore(THREE.MathUtils.clamp((DEPLOY_MAX_ALT - game.pos.y) / (DEPLOY_MAX_ALT - AAD_ALT), 0, 1) * 300);
}

function land() {
  const d = Math.hypot(game.pos.x, game.pos.z);
  const crashed = game.phase !== 'canopy';
  const accuracy = crashed ? 0 : Math.round(1000 * Math.max(0, 1 - d / 150));
  const soft = !crashed && game.touchdownSink < 3.4 ? 250 : 0;
  const cloudBonus = Math.round(game.cloudTime * 15);
  const before = game.score;
  addScore(accuracy + soft + cloudBonus);
  game.pos.y = 0;
  game.vel.set(0, 0, 0);
  setPhase('landed');
  setPrompt('');
  hud.mkDz.style.display = 'none';
  hud.mkRing.style.display = 'none';
  $('resEyebrow').textContent = crashed ? '落地太硬了 · 下次早點開傘' : d < 4 ? '正中靶心！' : d < 32 ? '漂亮的降落' : '降落完成';
  $('resTitle').textContent = game.score.toLocaleString();
  const rows = [
    ['穿越光環', `${game.ringsHit} / ${game.ringsTotal}　+${game.ringScore}`],
    ['雲中飛行', `${game.cloudTime.toFixed(1)} 秒　+${cloudBonus}`],
    ['開傘時機', `+${before - game.ringScore}`],
    ['距離靶心', `${d.toFixed(1)} m　+${accuracy}`],
    ['輕柔著陸', soft ? `+${soft}` : '—'],
  ];
  $('resList').innerHTML = rows.map(([a, b]) => `<div><dt>${a}</dt><dd>${b}</dd></div>`).join('');
  setTimeout(() => {
    if (game.phase === 'landed') $('result').classList.remove('hidden');
  }, 1400);
  if (!crashed) audio.fanfare();
  else audio.miss();
}

function action() {
  if (game.phase === 'menu') boardPlane();
  else if (game.phase === 'plane' && game.phaseTime > 0.4) jump();
  else if (game.phase === 'freefall') {
    if (game.pos.y <= DEPLOY_MAX_ALT) deploy(false);
    else toast(`${DEPLOY_MAX_ALT} m 以下才能開傘`);
  } else if (game.phase === 'landed' && game.phaseTime > 1.5) boardPlane();
}

// ---------------------------------------------------------------- input
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  keys.add(e.code);
  if (e.code === 'Space' || e.code === 'Enter') {
    e.preventDefault();
    action();
  }
  if (e.code === 'KeyT' && sky) {
    timeIndex = (timeIndex + 1) % TIMES.length;
    applyTime();
    if (game.phase !== 'menu') toast(TIMES[timeIndex].name);
  }
  if (e.code === 'KeyM') audio.setMuted(!audio.muted);
  if (e.code === 'KeyG' && clouds) {
    const d = (clouds.uniforms.uDebug.value + 1) % 4;
    clouds.uniforms.uDebug.value = d;
    composite.uniforms.uDebug.value = d;
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

let dragging = false;
canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointerup', () => (dragging = false));
canvas.addEventListener('pointercancel', () => (dragging = false));
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  game.viewYaw -= e.movementX * 0.005;
  game.viewPitch = THREE.MathUtils.clamp(game.viewPitch + e.movementY * 0.004, -0.6, 1.0);
});
$('startBtn').addEventListener('click', boardPlane);
$('againBtn').addEventListener('click', boardPlane);

function readInput(dt) {
  const k = (c) => (keys.has(c) ? 1 : 0);
  input.x = k('KeyD') + k('ArrowRight') - k('KeyA') - k('ArrowLeft');
  input.y = k('KeyW') + k('ArrowUp') - k('KeyS') - k('ArrowDown');
  input.dive = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const turn = k('KeyE') - k('KeyQ');
  game.viewYaw -= turn * 1.6 * dt;
}

// ---------------------------------------------------------------- simulation
function updatePlane(dt) {
  game.planeAngle += (PLANE_SPEED / PLANE_RADIUS) * dt;
  const a = game.planeAngle;
  game.planePos.set(Math.cos(a) * PLANE_RADIUS, JUMP_ALT, Math.sin(a) * PLANE_RADIUS);
  game.planeVel.set(-Math.sin(a) * PLANE_SPEED, 0, Math.cos(a) * PLANE_SPEED);
  game.planeYaw = Math.atan2(-game.planeVel.x, -game.planeVel.z);
  plane.position.copy(game.planePos);
  plane.rotation.set(0, game.planeYaw, 0.14, 'YXZ');
}

function updateFreefall(dt) {
  const diving = input.dive;
  // steer relative to where the camera looks
  const steerYaw = game.camYaw + game.viewYaw;
  fwdOf(steerYaw, v1);
  rightOf(steerYaw, v2);
  const k = diving ? 0.4 : 1;
  const tx = (v1.x * input.y * (input.y > 0 ? 34 : 14) + v2.x * input.x * 24) * k;
  const tz = (v1.z * input.y * (input.y > 0 ? 34 : 14) + v2.z * input.x * 24) * k;
  game.vel.x = damp(game.vel.x, tx, 0.95, dt);
  game.vel.z = damp(game.vel.z, tz, 0.95, dt);

  const vt = diving ? 84 : input.y > 0 ? 59 : input.y < 0 ? 48 : 54;
  const vy = game.vel.y;
  game.vel.y += (-G + G * (vy * Math.abs(vy)) / (vt * vt) * -1) * dt;

  // body follows the view, leans into the motion
  game.yaw += angleDelta(game.yaw, steerYaw) * (1 - Math.exp(-3 * dt));
  const targetPitch = diving ? -1.15 : -0.32 * input.y;
  game.pitch = damp(game.pitch, targetPitch, 3.5, dt);
  game.roll = damp(game.roll, -0.55 * input.x, 4, dt);

  if (game.pos.y < AAD_ALT) deploy(true);
}

function updateOpening(dt) {
  game.canopyOpen = Math.min(1, game.canopyOpen + dt / 1.6);
  game.sink = damp(game.sink, 5.5, 2.4, dt);
  game.fwdSpeed = damp(game.fwdSpeed, 12, 1.5, dt);
  fwdOf(game.yaw, v1);
  game.vel.set(v1.x * game.fwdSpeed, -game.sink, v1.z * game.fwdSpeed);
  game.pitch = damp(game.pitch, 0, 3, dt);
  game.roll = damp(game.roll, 0, 3, dt);
  if (game.phaseTime > 2.2) setPhase('canopy');
}

function updateCanopy(dt) {
  game.canopyOpen = 1;
  game.yawRate = damp(game.yawRate, -input.x * 0.95, 2.2, dt);
  game.yaw += game.yawRate * dt;
  const flare = input.y < 0;
  const front = input.y > 0;
  const turnSink = Math.abs(game.yawRate) * 4.5;
  game.fwdSpeed = damp(game.fwdSpeed, flare ? 6 : front ? 18 : 12.5, 1.4, dt);
  game.sink = damp(game.sink, (flare ? 2.1 : front ? 12 : 5.6) + turnSink, 1.6, dt);
  fwdOf(game.yaw, v1);
  game.vel.set(v1.x * game.fwdSpeed, -game.sink, v1.z * game.fwdSpeed);
  game.roll = damp(game.roll, game.yawRate * 0.55, 4, dt);
  game.pitch = damp(game.pitch, flare ? 0.12 : front ? -0.18 : 0, 3, dt);
  game.touchdownSink = game.sink;
}

function updateActor(dt) {
  const p = game.phase;
  if (p === 'freefall') updateFreefall(dt);
  else if (p === 'opening') updateOpening(dt);
  else if (p === 'canopy') updateCanopy(dt);
  if (game.phase === 'landed' || p === 'plane' || p === 'menu') return;

  // soft airspace boundary keeps the landing on level ground
  const r = Math.hypot(game.pos.x, game.pos.z);
  if (r > WORLD.playRadius) {
    const push = (r - WORLD.playRadius) * 0.06;
    game.pos.x -= (game.pos.x / r) * push * dt * 10;
    game.pos.z -= (game.pos.z / r) * push * dt * 10;
  }

  game.prevPos.copy(game.pos);
  game.pos.addScaledVector(game.vel, dt);
  if (game.pos.y <= 0.9) land();
}

function updateDiverVisual(dt) {
  if (!diver.root.visible) return;
  diver.root.position.copy(game.pos);
  diver.root.rotation.set(0, game.yaw, 0);
  const upright = game.phase === 'freefall' ? 0 : game.phase === 'landed' ? 1 : THREE.MathUtils.smoothstep(game.phaseTime, 0.1, 1.1);
  const base = -Math.PI / 2 * (1 - upright);
  const wobble = game.phase === 'freefall' ? Math.sin(game.time * 9) * 0.015 : 0;
  if (game.phase === 'freefall') {
    diver.tilt.rotation.set(base + game.pitch + wobble, game.roll * 0.0, 0);
    diver.tilt.rotation.z = game.roll; // bank around the direction of travel
  } else {
    diver.tilt.rotation.set(base + game.pitch * (1 - upright) + game.pitch * upright, 0, game.roll * 0.6);
  }
  if (game.phase === 'landed') {
    diver.root.position.y = 0.98;
    game.canopyOpen = Math.max(0, game.canopyOpen - dt * 0.9);
  }
  // canopy inflation: snatch then settle
  const o = game.canopyOpen;
  const ease = 1 - Math.pow(1 - o, 3);
  canopy.visible = o > 0.01;
  canopy.scale.set(0.25 + 0.75 * ease, 0.5 + 0.5 * ease + 0.12 * Math.sin(o * Math.PI) , 0.35 + 0.65 * ease);
  canopy.rotation.z = game.roll * 0.8 + (game.phase === 'opening' ? Math.sin(game.phaseTime * 9) * 0.1 * (1 - o) : 0);
  canopy.position.y = 0.55;
}

const camDesired = new THREE.Vector3();
const camLook = new THREE.Vector3();
function updateCamera(dt) {
  const p = game.phase;
  let fov = 60;
  if (p === 'menu' || p === 'plane' || p === 'loading') {
    const t = game.time;
    fwdOf(game.planeYaw, v1);
    rightOf(game.planeYaw, v2);
    if (p === 'plane') {
      camDesired.copy(game.planePos).addScaledVector(v1, -27).addScaledVector(v2, 9).add(v3.set(0, 6.5, 0));
      camLook.copy(game.planePos).addScaledVector(v1, 6);
    } else {
      const a = 0.9 + Math.sin(t * 0.07) * 0.5;
      camDesired.copy(game.planePos)
        .addScaledVector(v1, Math.cos(a) * 30)
        .addScaledVector(v2, Math.sin(a) * 30)
        .add(v3.set(0, 3.5 + Math.sin(t * 0.11) * 3, 0));
      camLook.copy(game.planePos).addScaledVector(v2, -6);
    }
    if (game.phaseTime < 0.05 && p !== 'plane') camera.position.copy(camDesired);
    camera.position.lerp(camDesired, 1 - Math.exp(-(p === 'plane' ? 3 : 20) * dt));
    camera.lookAt(camLook);
    fov = 52;
  } else {
    let pitch, dist, lift;
    if (p === 'freefall') {
      // ease the view toward the drop zone right after the exit
      if (game.phaseTime < 3.5) {
        const toDz = Math.atan2(game.pos.x, game.pos.z);
        game.camYaw += angleDelta(game.camYaw, toDz) * (1 - Math.exp(-1.6 * dt));
      }
      pitch = 0.36;
      dist = input.dive ? 7.5 : 9;
      lift = 1.8;
      fov = 62 + 18 * THREE.MathUtils.smoothstep(-game.vel.y, 35, 88);
    } else if (p === 'landed') {
      game.viewYaw += dt * 0.25;
      pitch = 0.2;
      dist = 12;
      lift = 2.5;
    } else {
      // under canopy the view trails the wing's heading
      game.camYaw += angleDelta(game.camYaw, game.yaw) * (1 - Math.exp(-2.5 * dt));
      pitch = 0.24;
      dist = 15;
      lift = 5.5;
      fov = 60;
    }
    game.camPitch = damp(game.camPitch, pitch, 2.5, dt);
    game.camDist = damp(game.camDist, dist, 2.5, dt);
    game.camLift = damp(game.camLift, lift, 2.5, dt);
    const yaw = game.camYaw + game.viewYaw;
    const pt = THREE.MathUtils.clamp(game.camPitch + game.viewPitch, -0.35, 1.45);
    v1.set(-Math.sin(yaw) * Math.cos(pt), -Math.sin(pt), -Math.cos(yaw) * Math.cos(pt));
    camDesired.copy(game.pos).addScaledVector(v1, -game.camDist);
    camDesired.y += game.camLift;
    camDesired.addScaledVector(game.vel, -0.018);
    // buffeting
    const amp = 0.05 * THREE.MathUtils.smoothstep(game.vel.length(), 30, 90) + game.shake * 0.35;
    camDesired.x += Math.sin(game.time * 31) * amp;
    camDesired.y += Math.sin(game.time * 37 + 1.3) * amp;
    camDesired.z += Math.sin(game.time * 29 + 2.1) * amp;
    camDesired.y = Math.max(camDesired.y, 1.2);
    camera.position.copy(camDesired);
    camLook.copy(game.pos).addScaledVector(v1, 7);
    camLook.y += game.camLift * 0.55;
    camera.lookAt(camLook);
    game.shake = Math.max(0, game.shake - dt * 1.4);
  }
  camera.fov = damp(camera.fov, fov, 3, dt);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}

function updateHud() {
  const p = game.phase;
  if (p === 'menu' || p === 'loading') return;
  const alt = p === 'plane' ? JUMP_ALT : Math.max(0, game.pos.y);
  setText(hud.alt, 'alt', String(Math.round(alt)));
  setText(hud.vs, 'vs', String(Math.round(Math.max(0, -game.vel.y) * 3.6)));
  setText(hud.hs, 'hs', String(Math.round(Math.hypot(game.vel.x, game.vel.z) * 3.6)));
  setText(hud.score, 'score', game.score.toLocaleString());
  setText(hud.combo, 'combo', game.combo > 1 ? `連擊 ×${game.combo}` : '');
  hud.tick.style.top = `${(1 - alt / JUMP_ALT) * 100}%`;

  if (p === 'plane') {
    setPrompt('按 <kbd>空白鍵</kbd> 跳出機艙');
  } else if (p === 'freefall') {
    if (alt <= DEPLOY_MAX_ALT) setPrompt('按 <kbd>空白鍵</kbd> 開傘', alt < 800);
    else if (game.inCloud > 0.3) setPrompt('穿越雲層中…');
    else if (game.phaseTime < 7) setPrompt('穿過光環得分 · <kbd>SHIFT</kbd> 俯衝');
    else setPrompt('');
  } else if (p === 'opening') {
    setPrompt('');
  } else if (p === 'canopy') {
    if (alt < 45) setPrompt('按住 <kbd>S</kbd> 煞車，輕柔落地', true);
    else if (Math.hypot(game.pos.x, game.pos.z) > WORLD.playRadius) setPrompt('接近空域邊界，請回頭', true);
    else if (game.phaseTime < 6) setPrompt('<kbd>A</kbd><kbd>D</kbd> 轉向 · 瞄準橘色靶心');
    else setPrompt('');
  }

  if (p === 'freefall' || p === 'opening' || p === 'canopy') {
    const d = Math.hypot(game.pos.x, game.pos.z);
    placeMarker(hud.mkDz, v2.set(0, 0, 0), `靶心 ${d >= 1000 ? (d / 1000).toFixed(2) + ' km' : Math.round(d) + ' m'}`);
    const next = p === 'freefall' ? rings.next(game.pos.y) : null;
    if (next) {
      const rp = next.group.position;
      placeMarker(hud.mkRing, rp, `光環 ${Math.round(game.pos.y - rp.y)} m`);
    } else hud.mkRing.style.display = 'none';
  } else {
    hud.mkDz.style.display = 'none';
    hud.mkRing.style.display = 'none';
  }
}

// ---------------------------------------------------------------- frame
const fogColor = new THREE.Color();
function frame(dt) {
  game.time += dt;
  game.phaseTime += dt;
  readInput(dt);
  updatePlane(dt);
  updateActor(dt);
  updateDiverVisual(dt);
  updateCamera(dt);

  // cloud probe at the actor (or camera while on the plane)
  const probe = diver.root.visible ? game.pos : camera.position;
  const dens = clouds.densityAt(probe.x, probe.y, probe.z);
  game.inCloud = damp(game.inCloud, Math.min(dens * 3, 1), 4, dt);
  if (game.phase === 'freefall' && game.inCloud > 0.35) game.cloudTime += dt;

  rings.update(dt, game.time, game.prevPos, game.pos, camera, 1 - game.inCloud * 0.85,
    (r) => {
      game.combo++;
      game.ringsHit++;
      const pts = 100 * game.combo;
      game.ringScore += pts;
      addScore(pts);
      toast(`+${pts}`);
      audio.ring(game.combo);
    },
    () => {
      game.combo = 0;
      audio.miss();
    },
  );
  streaks.update(camera, game.phase === 'plane' || game.phase === 'menu' ? game.planeVel : game.vel, game.inCloud);

  clouds.update(dt);
  terrain.update(game.time);
  sky.update(camera, game.time);

  // lights track the sky model
  for (const [sun, hemi] of [[bgSun, bgHemi], [fgSun, fgHemi]]) {
    sun.color.copy(sky.sunColor);
    sun.position.copy(camera.position).addScaledVector(sky.sunDir, 100);
    sun.target.position.copy(camera.position);
    sun.target.updateMatrixWorld();
    hemi.color.copy(sky.ambientTop).multiplyScalar(2.2);
    hemi.groundColor.copy(sky.ambientBottom).multiplyScalar(1.6);
  }
  fogColor.copy(sky.sunColor).multiplyScalar(0.45).add(sky.ambientTop);
  fgScene.fog.color.copy(fogColor);
  fgScene.fog.density = game.inCloud * 0.03;

  const speed = game.phase === 'plane' || game.phase === 'menu' ? 40 : game.vel.length();
  audio.update(speed, game.inCloud, camera.position.distanceTo(game.planePos));
  updateHud();

  // 1) sky + ground  2) clouds at reduced res  3) composite  4) actors
  renderer.setRenderTarget(sceneTarget);
  renderer.clear();
  renderer.render(bgScene, camera);
  clouds.render(renderer, camera, sceneTarget.depthTexture);
  composite.uniforms.tCloud.value = clouds.target.texture;
  renderer.setRenderTarget(null);
  renderer.clear();
  renderer.render(compositeScene, orthoCamera);
  renderer.clearDepth();
  renderer.render(fgScene, camera);
}

let last = performance.now();
function loop(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  frame(dt);
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- boot
async function boot() {
  const [assets, models] = await Promise.all([loadCloudAssets(), loadModels()]);
  sky = new Sky(renderer, assets.weather);
  clouds = new Clouds(assets, sky, params.get('q') || 'medium');
  terrain = new Terrain(sky, clouds);
  bgScene.add(sky.dome, terrain.group);

  diver = buildDiver(models.diver);
  diver.root.visible = false;
  canopy = buildCanopy();
  diver.root.add(canopy);
  plane = buildPlane(models.plane);
  fgScene.add(diver.root, plane);
  rings = new Rings(fgScene);
  streaks = new WindStreaks(fgScene);

  applyTime();
  layoutAltBar();
  resize();
  updatePlane(0);
  toMenu();
  const btn = $('startBtn');
  btn.disabled = false;
  btn.textContent = '開始跳傘';
  requestAnimationFrame((t) => {
    last = t;
    loop(t);
  });
}

boot().catch((err) => {
  console.error(err);
  $('startBtn').textContent = '載入失敗';
});

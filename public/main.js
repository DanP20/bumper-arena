// Bumper Arena client — three.js renderer, input, HUD and generated audio.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const $ = id => document.getElementById(id);
// Storage can be blocked (private mode, in-app browsers); the game must still start without it.
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* blocked */ } },
};
const TEAM_HEX = [0x22e5ff, 0xff4fd8];
const TEAM_CSS = ['#22e5ff', '#ff4fd8'];
const TEAM_NAME = ['CYAN', 'PINK'];

const params = new URLSearchParams(location.search);
// Every visitor without a ?room= link gets a private room of their own, with its code put in the address bar to share.
function newRoomCode() {
  const A = ['icy', 'snowy', 'frosty', 'chilly', 'glacial', 'polar', 'wintry', 'slippy', 'bumpy', 'zippy'];
  const B = ['puck', 'pine', 'yeti', 'moose', 'otter', 'penguin', 'husky', 'comet', 'sled', 'lynx'];
  const pick = l => l[Math.floor(Math.random() * l.length)];
  return `${pick(A)}-${pick(B)}-${Math.floor(100 + Math.random() * 900)}`;
}
let roomName = (params.get('room') || '').toLowerCase().replace(/[^a-z0-9\-_]/g, '').slice(0, 24);
// Whoever opens the plain address is the host of a new game; anyone arriving on a ?room= link is a guest of that game.
if (!roomName) {
  // Coming back to the plain address returns you to the game you last hosted (for 12 hours), so the
  // link you already shared keeps working. "Start a fresh game" on the name screen (?new=1) makes a new one.
  let last = null;
  try { last = JSON.parse(store.get('ba-room') || 'null'); } catch { /* ignore */ }
  const reuse = !params.has('new') && last && typeof last.code === 'string' && Date.now() - last.t < 12 * 3600e3;
  roomName = reuse ? last.code.toLowerCase().replace(/[^a-z0-9\-_]/g, '').slice(0, 24) || newRoomCode() : newRoomCode();
  params.delete('new');
  store.set('ba-room', JSON.stringify({ code: roomName, t: Date.now() }));
  params.set('room', roomName);
  history.replaceState(null, '', `${location.pathname}?${params}`);
  try { sessionStorage.setItem('ba-host', roomName); } catch { /* private mode */ }
}
let isHost = false;
try { isHost = sessionStorage.getItem('ba-host') === roomName; } catch { /* private mode */ }
try { if (JSON.parse(store.get('ba-room') || 'null').code === roomName) isHost = true; } catch { /* none saved */ }
const linkMode = params.get('mode') === '1' ? 1 : params.get('mode') === '2' ? 2 : 0;
$('roomname').textContent = roomName;
$('sharelink').textContent = location.href;

let cfg = null, myId = null, joined = false;
let roster = [];
const net = { st: 'countdown', cd: 0, sc: [0, 0], w: -1, pz: 0 };
const roomInfo = { size: 2, mins: 3, host: -1, hostName: '' };

// ---------- renderer ----------
const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 900);
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.5, 0.86);
composer.addPass(bloom);
composer.addPass(new OutputPass());

const CAM_BASE = new THREE.Vector3(0, 35, 41);
let camScale = 1, shake = 0;
function resize() {
  const w = Math.max(1, innerWidth), h = Math.max(1, innerHeight);
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camScale = Math.max(1.08, 2.05 / camera.aspect);
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

scene.fog = new THREE.Fog(0x7f9cc4, 140, 560);
scene.add(new THREE.HemisphereLight(0xbcd4ff, 0x5a6f96, 0.95));
const sun = new THREE.DirectionalLight(0xfff0dc, 1.0);
sun.position.set(-20, 50, 25);
scene.add(sun);

// ---------- sky ----------
function buildSky() {
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(600, 32, 20),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { t: { value: 0 } },
      vertexShader: 'varying vec3 d; void main(){ d = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `varying vec3 d; uniform float t;
        void main(){
          float h = d.y;
          vec3 top = vec3(0.02,0.05,0.16), mid = vec3(0.10,0.22,0.45), hor = vec3(0.62,0.72,0.86);
          vec3 c = mix(hor, mid, smoothstep(-0.02,0.3,h));
          c = mix(c, top, smoothstep(0.25,0.85,h));
          float a = atan(d.z, d.x);
          float band = sin(a*3.0 + t*0.05 + sin(h*9.0 + t*0.1)*1.3) * 0.5 + 0.5;
          c += vec3(0.1,0.55,0.35) * band * smoothstep(0.12,0.35,h) * smoothstep(0.8,0.35,h) * 0.3;
          gl_FragColor = vec4(c, 1.0);
        }`,
    }));
  scene.add(sky);
  const n = 900, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3().randomDirection(); v.y = Math.abs(v.y) * 0.8 + 0.2; v.normalize().multiplyScalar(520);
    pos.set([v.x, v.y, v.z], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xe6f0ff, size: 1.5, sizeAttenuation: false, transparent: true, opacity: 0.7, fog: false })));

  // snowfield, mountains and pines
  const snowMat = new THREE.MeshStandardMaterial({ color: 0xb4c8e2, roughness: 1 });
  const ground = new THREE.Mesh(new THREE.CircleGeometry(560, 64), snowMat);
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.55; scene.add(ground);
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x8ea3c4, roughness: 1, flatShading: true });
  const capMat = new THREE.MeshStandardMaterial({ color: 0xf2f7ff, roughness: 1, flatShading: true });
  for (let i = 0; i < 11; i++) {
    const a = Math.PI * (1.08 + 0.84 * i / 10), dist = 300 + (i % 3) * 45, hgt = 70 + ((i * 37) % 60), rad = 80 + ((i * 53) % 50);
    const m = new THREE.Mesh(new THREE.ConeGeometry(rad, hgt, 7), rockMat);
    m.position.set(Math.cos(a) * dist, hgt / 2 - 2, Math.sin(a) * dist); m.rotation.y = i; scene.add(m);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(rad * 0.46, hgt * 0.45, 7), capMat);
    cap.position.set(m.position.x, hgt * 0.775 - 1.5, m.position.z); cap.rotation.y = i; scene.add(cap);
  }
  const pineMat = new THREE.MeshStandardMaterial({ color: 0x1f5a48, roughness: 0.9, flatShading: true });
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3426, roughness: 1 });
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 90; i++) {
    let x, z;
    if (i < 22) { x = -58 + i * 5.4 + rnd() * 3; z = -22 - rnd() * 14; } // a row of pines right behind the rink
    else {
      const a = rnd() * Math.PI * 2, dist = 46 + rnd() * 90;
      x = Math.cos(a) * dist * 1.25; z = Math.sin(a) * dist;
      if (z > 6 && Math.abs(x) < 70) continue; // keep the camera's side clear
      if (Math.abs(x) < 40 && Math.abs(z) < 24) continue;
    }
    const sc = 0.8 + rnd() * 1.1, tree = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 2, 6), trunkMat); trunk.position.y = 1; tree.add(trunk);
    for (let k = 0; k < 3; k++) {
      const r = 2.6 - k * 0.7, hh = 3.2 - k * 0.5, y = 2.6 + k * 1.9;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(r, hh, 8), pineMat); cone.position.y = y; tree.add(cone);
      const sn = new THREE.Mesh(new THREE.ConeGeometry(r * 0.62, hh * 0.6, 8), capMat); sn.position.y = y + hh * 0.22; tree.add(sn);
    }
    tree.position.set(x, -0.55, z); tree.scale.setScalar(sc); scene.add(tree);
  }
  // falling snow
  const SN = 1600, sp = new Float32Array(SN * 3);
  for (let i = 0; i < SN; i++) sp.set([(Math.random() - 0.5) * 150, Math.random() * 55, (Math.random() - 0.5) * 110], i * 3);
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  const snow = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 0.32, transparent: true, opacity: 0.85, depthWrite: false, fog: false }));
  snow.frustumCulled = false; scene.add(snow);
  return { sky, snow, sp, SN };
}
function stepSnow(dt, time) {
  const { sp, SN, snow } = skyParts;
  for (let i = 0; i < SN; i++) {
    const j = i * 3;
    sp[j + 1] -= (5 + (i % 5)) * dt; sp[j] += (1.5 + Math.sin(time * 0.6 + i) * 1.2) * dt;
    if (sp[j + 1] < 0) sp[j + 1] += 55;
    if (sp[j] > 75) sp[j] -= 150;
  }
  snow.geometry.attributes.position.needsUpdate = true;
}
const skyParts = buildSky();

// ---------- arena ----------
const arena = new THREE.Group();
scene.add(arena);
const bumperMeshes = [];
const goalGlow = [];

function roundedPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
}

function iceTexture() {
  const { L, W, CR, GW } = cfg;
  const S = 20, cw = 2 * L * S, ch = 2 * W * S;
  const c = document.createElement('canvas'); c.width = cw; c.height = ch;
  const x = c.getContext('2d');
  roundedPath(x, 0, 0, cw, ch, CR * S); x.clip();
  const g = x.createLinearGradient(0, 0, cw, 0);
  g.addColorStop(0, '#7fc4dc'); g.addColorStop(0.5, '#a9cfe6'); g.addColorStop(1, '#c9aede');
  x.fillStyle = g; x.fillRect(0, 0, cw, ch);
  x.strokeStyle = 'rgba(255,255,255,0.22)'; x.lineWidth = 1.2; // skate scratches
  for (let i = 0; i < 260; i++) { const sx0 = Math.random() * cw, sy0 = Math.random() * ch, rr = 30 + Math.random() * 160, a0 = Math.random() * 7; x.beginPath(); x.arc(sx0, sy0, rr, a0, a0 + 0.3 + Math.random() * 0.8); x.stroke(); }
  const line = (col, w) => { x.strokeStyle = col; x.lineWidth = w; x.shadowColor = col; x.shadowBlur = 14; };
  line('#ffffff', 5);
  x.beginPath(); x.moveTo(cw / 2, 0); x.lineTo(cw / 2, ch); x.stroke();
  x.beginPath(); x.arc(cw / 2, ch / 2, 4.5 * S, 0, 7); x.stroke();
  x.fillStyle = '#ffffff'; x.beginPath(); x.arc(cw / 2, ch / 2, 7, 0, 7); x.fill();
  // goal creases, coloured by the team that defends them
  line(TEAM_CSS[0], 6);
  x.beginPath(); x.arc(0, ch / 2, (GW + 2.2) * S, -Math.PI / 2, Math.PI / 2); x.stroke();
  x.beginPath(); x.moveTo(cw * 0.3, 0); x.lineTo(cw * 0.3, ch); x.stroke();
  line(TEAM_CSS[1], 6);
  x.beginPath(); x.arc(cw, ch / 2, (GW + 2.2) * S, Math.PI / 2, Math.PI * 1.5); x.stroke();
  x.beginPath(); x.moveTo(cw * 0.7, 0); x.lineTo(cw * 0.7, ch); x.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

class PolyCurve extends THREE.Curve {
  constructor(pts) { super(); this.pts = pts; }
  getPoint(t, target = new THREE.Vector3()) {
    const f = t * (this.pts.length - 1), i = Math.min(Math.floor(f), this.pts.length - 2);
    return target.lerpVectors(this.pts[i], this.pts[i + 1], f - i);
  }
}

function boardPoints(sign) { // one half of the boards (z side = sign), from the right goal post round to the left one
  const { L, W, CR, GW } = cfg, pts = [], y = 1.0;
  const add = (px, pz) => pts.push(new THREE.Vector3(px, y, pz * sign));
  const seg = (x0, z0, x1, z1) => { const n = Math.max(1, Math.round(Math.hypot(x1 - x0, z1 - z0) / 0.6)); for (let i = 0; i < n; i++) add(x0 + (x1 - x0) * i / n, z0 + (z1 - z0) * i / n); };
  const arc = (cx, cz, a0, a1) => { const n = 16; for (let i = 0; i < n; i++) { const a = a0 + (a1 - a0) * i / n; add(cx + Math.cos(a) * CR, cz + Math.sin(a) * CR); } };
  seg(L, GW, L, W - CR); arc(L - CR, W - CR, 0, Math.PI / 2);
  seg(L - CR, W, -(L - CR), W); arc(-(L - CR), W - CR, Math.PI / 2, Math.PI);
  seg(-L, W - CR, -L, GW); add(-L, GW);
  return pts;
}

function buildArena() {
  const { L, W, CR, GW, GD, BUMPERS, BUMPER_R } = cfg;
  const tex = iceTexture();
  const ice = new THREE.Mesh(new THREE.PlaneGeometry(2 * L, 2 * W),
    new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.18, roughness: 0.12, metalness: 0.2, transparent: true }));
  ice.rotation.x = -Math.PI / 2;
  arena.add(ice);

  // floating slab under the ice
  const m = 1.6, shape = new THREE.Shape();
  const sx = L + GD + m, sz = W + m, r = CR + m;
  shape.moveTo(-sx + r, -sz); shape.lineTo(sx - r, -sz); shape.absarc(sx - r, -sz + r, r, -Math.PI / 2, 0);
  shape.lineTo(sx, sz - r); shape.absarc(sx - r, sz - r, r, 0, Math.PI / 2);
  shape.lineTo(-sx + r, sz); shape.absarc(-sx + r, sz - r, r, Math.PI / 2, Math.PI);
  shape.lineTo(-sx, -sz + r); shape.absarc(-sx + r, -sz + r, r, Math.PI, Math.PI * 1.5);
  const slab = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 2.2, bevelEnabled: true, bevelSize: 0.5, bevelThickness: 0.5, bevelSegments: 2 }),
    new THREE.MeshStandardMaterial({ color: 0xe4edf8, roughness: 1 })); // packed-snow bank around the lake
  slab.rotation.x = Math.PI / 2; slab.position.y = -0.58; // bevel adds 0.5 above the front face
  arena.add(slab);
  // lamp posts with warm lights at the four corners
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x2a3348, roughness: 0.6 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x332200, emissive: 0xffc878, emissiveIntensity: 2.2 });
  for (const [px, pz] of [[L - 2, -(W + 2.4)], [-(L - 2), -(W + 2.4)], [L + GD + 2.2, W - 3], [-(L + GD + 2.2), W - 3]]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 7, 8), poleMat); pole.position.set(px, 3.2, pz); arena.add(pole);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.55, 16, 12), lampMat); lamp.position.set(px, 7, pz); arena.add(lamp);
  }

  // boards: translucent wall with a glowing rail on top
  const railMat = new THREE.MeshStandardMaterial({ color: 0x556688, emissive: 0xbfe0ff, emissiveIntensity: 1.1 });
  const glassMat = new THREE.MeshBasicMaterial({ color: 0xe8f4ff, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
  for (const sign of [1, -1]) {
    const pts = boardPoints(sign);
    arena.add(new THREE.Mesh(new THREE.TubeGeometry(new PolyCurve(pts), pts.length * 2, 0.13, 6), railMat));
    const pos = [], idx = [];
    pts.forEach((p, i) => {
      pos.push(p.x, 0, p.z, p.x, p.y, p.z);
      if (i) { const a = (i - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
    arena.add(new THREE.Mesh(g, glassMat));
  }

  // goals: the +x goal is defended by team 1, the -x goal by team 0
  for (const side of [1, -1]) {
    const team = side === 1 ? 1 : 0, col = TEAM_HEX[team];
    const mat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: col, emissiveIntensity: 1.6 });
    const grp = new THREE.Group();
    const bar = (len, px, py, pz, axis) => {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, len, 8), mat);
      if (axis === 'x') mesh.rotation.z = Math.PI / 2; else if (axis === 'z') mesh.rotation.x = Math.PI / 2;
      mesh.position.set(px, py, pz); grp.add(mesh);
    };
    const H = 2.4, bx = L + GD;
    for (const zs of [1, -1]) {
      bar(H, L, H / 2, zs * GW, 'y'); bar(H, bx, H / 2, zs * GW, 'y');
      bar(GD, L + GD / 2, H, zs * GW, 'x'); bar(GD, L + GD / 2, 0.16, zs * GW, 'x');
    }
    bar(2 * GW, L, H, 0, 'z'); bar(2 * GW, bx, H, 0, 'z'); bar(2 * GW, bx, 0.16, 0, 'z');
    const netMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false });
    const back = new THREE.Mesh(new THREE.PlaneGeometry(2 * GW, H), netMat); back.rotation.y = Math.PI / 2; back.position.set(bx, H / 2, 0); grp.add(back);
    const floorMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.22 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(GD, 2 * GW), floorMat); floor.rotation.x = -Math.PI / 2; floor.position.set(L + GD / 2, 0.02, 0); grp.add(floor);
    grp.scale.x = side;
    arena.add(grp);
    goalGlow[team] = { mat, floorMat, flash: 0 };
  }

  // bumpers
  BUMPERS.forEach(([bx, bz]) => {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(BUMPER_R * 0.82, BUMPER_R, 1.3, 28),
      new THREE.MeshStandardMaterial({ color: 0xf4f8ff, roughness: 0.5 }));
    body.position.y = 0.65; g.add(body);
    const ringMat = new THREE.MeshStandardMaterial({ color: 0x331000, emissive: 0xff7a3d, emissiveIntensity: 1.6 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(BUMPER_R * 0.86, 0.14, 8, 32), ringMat);
    ring.rotation.x = Math.PI / 2; ring.position.y = 1.3; g.add(ring);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(BUMPER_R * 0.5, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), ringMat);
    cap.position.y = 1.3; g.add(cap);
    g.position.set(bx, 0, bz);
    arena.add(g);
    bumperMeshes.push({ g, ringMat, pulse: 0 });
  });
}

// ---------- players & ball ----------
const players = new Map(); // id -> view
let ballView = null;

function nameSprite(text, color) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const x = c.getContext('2d');
  x.font = '700 34px system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.lineWidth = 6; x.strokeStyle = 'rgba(0,0,0,.75)'; x.strokeText(text, 128, 32);
  x.fillStyle = color; x.fillText(text, 128, 32);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false }));
  s.scale.set(6, 1.5, 1); s.renderOrder = 5;
  return s;
}

function makePlayerView(info) {
  const R = cfg.PR, col = TEAM_HEX[info.team];
  const g = new THREE.Group(), car = new THREE.Group();
  g.add(car);
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); car.add(m); return m; };
  const paint = new THREE.Color(col); if (info.slot === 1) paint.lerp(new THREE.Color(0xffffff), 0.6);
  const paintMat = new THREE.MeshStandardMaterial({ color: paint, roughness: 0.25, metalness: 0.45, emissive: paint, emissiveIntensity: 0.12 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.9 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1c2233, roughness: 0.7 });
  const ringMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: col, emissiveIntensity: 1.5 });
  // local +x is the front of the car
  // boxy body: rounded rectangles, longer than wide (collisions stay circular)
  const HL = R * 1.15, HW = R * 1.0;
  const slab = (hl, hw, r, depth, bevel, mat, x, y) => {
    const sh = new THREE.Shape();
    sh.moveTo(-hl + r, -hw); sh.lineTo(hl - r, -hw); sh.absarc(hl - r, -hw + r, r, -Math.PI / 2, 0);
    sh.lineTo(hl, hw - r); sh.absarc(hl - r, hw - r, r, 0, Math.PI / 2);
    sh.lineTo(-hl + r, hw); sh.absarc(-hl + r, hw - r, r, Math.PI / 2, Math.PI);
    sh.lineTo(-hl, -hw + r); sh.absarc(-hl + r, -hw + r, r, Math.PI, Math.PI * 1.5);
    const geo = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 3, curveSegments: 8 });
    const m = add(geo, mat, x, y, 0); m.rotation.x = -Math.PI / 2; return m;
  };
  slab(HL, HW, 0.78, 0.5, 0, rubber, 0, 0.08);                               // rubber bumper skirt
  const ring = slab(HL + 0.06, HW + 0.06, 0.82, 0.12, 0, ringMat, 0, 0.44);  // glowing team stripe
  slab(HL - 0.3, HW - 0.28, 0.52, 0.5, 0.16, paintMat, 0, 0.74);              // shell
  slab(0.42, HW - 0.5, 0.2, 0.12, 0.08, paintMat, HL - 0.82, 1.36);          // hood
  add(new THREE.CylinderGeometry(0.58, 0.58, 0.3, 20), dark, -0.22, 1.36, 0);            // cockpit
  add(new THREE.BoxGeometry(0.22, 0.8, 0.95), paintMat, -0.85, 1.5, 0);                 // seat back
  const wheel = add(new THREE.TorusGeometry(0.24, 0.045, 6, 16), dark, 0.32, 1.55, 0);  // steering wheel
  wheel.rotation.y = Math.PI / 2; wheel.rotation.z = 0.5;
  add(new THREE.CylinderGeometry(0.3, 0.36, 0.6, 12), new THREE.MeshStandardMaterial({ color: info.slot ? 0x2a3350 : 0xf0f4ff, roughness: 0.8 }), -0.25, 1.62, 0); // driver
  add(new THREE.SphereGeometry(0.36, 18, 14), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, emissive: col, emissiveIntensity: 0.25 }), -0.22, 2.16, 0); // helmet
  add(new THREE.BoxGeometry(0.1, 0.16, 0.46), dark, 0.1, 2.18, 0);                      // visor
  const lightMat = new THREE.MeshStandardMaterial({ color: 0x333322, emissive: 0xfff2c0, emissiveIntensity: 2.4 });
  for (const zs of [0.5, -0.5]) add(new THREE.SphereGeometry(0.17, 12, 10), lightMat, HL - 0.2, 1.0, zs * 1.2);
  add(new THREE.CylinderGeometry(0.045, 0.045, 2.7, 6), dark, -R * 0.9, 2.2, 0);       // pole
  add(new THREE.SphereGeometry(0.16, 12, 10), ringMat, -R * 0.9, 3.6, 0);              // spark tip
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(R * 1.3, 28), new THREE.MeshBasicMaterial({ color: 0x1b2a4a, transparent: true, opacity: 0.28, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.03; shadow.scale.set(1.15, 1, 1); car.add(shadow);
  const label = nameSprite(info.bot ? `BOT ${info.name}` : info.name, info.bot ? '#aab6cc' : info.id === myId ? '#ffffff' : TEAM_CSS[info.team]);
  if (info.bot) label.scale.multiplyScalar(0.8);
  label.position.y = 5.2; g.add(label);
  let marker = null;
  if (info.id === myId) {
    marker = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.9, 4), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    marker.rotation.x = Math.PI; marker.position.y = 6.6; g.add(marker);
    const me = new THREE.Mesh(new THREE.RingGeometry(R * 1.45, R * 1.65, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
    me.rotation.x = -Math.PI / 2; me.position.y = 0.04; g.add(me);
  }
  const heading = info.team === 0 ? 0 : Math.PI;
  car.rotation.y = heading;
  scene.add(g);
  return { g, car, heading, ring, ringMat, label, marker, name: info.name, team: info.team, slot: info.slot, bot: info.bot, x: 0, z: 0, tx: 0, tz: 0, vx: 0, vz: 0, fresh: true, dash: 0, dashCd: 0, isMe: info.id === myId };
}

function disposeView(v) {
  scene.remove(v.g);
  v.g.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
}

function applyRoster(list) {
  // announce people arriving and leaving, so it is obvious the game is shared
  const before = new Set(roster.filter(p => !p.bot).map(p => p.name)), after = new Set(list.filter(p => !p.bot).map(p => p.name));
  if (roster.length) {
    for (const n of after) if (!before.has(n)) toast(`${n} joined the game`);
    for (const n of before) if (!after.has(n)) toast(`${n} left — a bot took over`);
  }
  roster = list;
  const seen = new Set();
  for (const info of list) {
    seen.add(info.id);
    let v = players.get(info.id);
    if (v && (v.name !== info.name || v.bot !== info.bot || v.isMe !== (info.id === myId))) {
      const old = v; v = makePlayerView(info);
      Object.assign(v, { x: old.x, z: old.z, tx: old.tx, tz: old.tz, fresh: old.fresh, heading: old.heading });
      disposeView(old); players.set(info.id, v);
    } else if (!v) players.set(info.id, makePlayerView(info));
  }
  for (const [id, v] of players) if (!seen.has(id)) { disposeView(v); players.delete(id); }
  renderRoster();
}

function renderRoster() {
  const el = $('rosterlist'); el.textContent = '';
  for (const team of [0, 1]) {
    for (const p of roster.filter(q => q.team === team)) {
      const row = document.createElement('div');
      row.className = 'row' + (p.id === myId ? ' me' : '') + (p.bot ? ' bot' : '');
      row.style.color = TEAM_CSS[team];
      const n = document.createElement('span');
      const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = p.bot ? 'BOT' : p.id === myId ? 'YOU' : 'PLAYER';
      n.append(tag, p.name);
      const i = document.createElement('i'); i.textContent = p.goals + (p.goals === 1 ? ' goal' : ' goals');
      row.append(n, i); el.append(row);
    }
  }
}

function buildBall() {
  const R = cfg.BR;
  const g = new THREE.Group();
  const mesh = new THREE.Group(); // a chunky glowing puck
  const puck = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 0.5, 28), new THREE.MeshStandardMaterial({ color: 0x1a1a22, roughness: 0.5 }));
  const glowMat = new THREE.MeshStandardMaterial({ color: 0x332200, emissive: 0xffb23d, emissiveIntensity: 2.2 });
  const top = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.62, R * 0.62, 0.54, 6), glowMat);
  const band = new THREE.Mesh(new THREE.TorusGeometry(R, 0.07, 6, 28), glowMat); band.rotation.x = Math.PI / 2;
  mesh.add(puck, top, band);
  mesh.position.y = 0.3; g.add(mesh);
  const light = new THREE.PointLight(0xffb23d, 12, 12); light.position.y = 1.6; g.add(light);
  scene.add(g);
  const N = 18, tpos = new Float32Array(N * 3), tcol = new Float32Array(N * 3);
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.BufferAttribute(tpos, 3));
  tg.setAttribute('color', new THREE.BufferAttribute(tcol, 3));
  for (let i = 0; i < N; i++) { const f = 1 - i / N; tcol.set([f, f * 0.9, f * 0.42], i * 3); }
  const trail = new THREE.Line(tg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  trail.frustumCulled = false;
  scene.add(trail);
  ballView = { g, mesh, trail, tpos, N, x: 0, z: 0, tx: 0, tz: 0, vx: 0, vz: 0, fresh: true };
}

// ---------- particles ----------
const PN = 400;
const pGeo = new THREE.BufferGeometry();
const pPos = new Float32Array(PN * 3), pCol = new Float32Array(PN * 3);
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
const pPoints = new THREE.Points(pGeo, new THREE.PointsMaterial({ size: 0.5, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
pPoints.frustumCulled = false;
scene.add(pPoints);
const parts = Array.from({ length: PN }, () => ({ life: 0, x: 0, y: -99, z: 0, vx: 0, vy: 0, vz: 0, c: new THREE.Color() }));
let pNext = 0;
function burst(x, y, z, hex, count, speed) {
  for (let i = 0; i < count; i++) {
    const p = parts[pNext = (pNext + 1) % PN];
    const a = Math.random() * Math.PI * 2, u = Math.random();
    p.x = x; p.y = y; p.z = z; p.life = 0.5 + Math.random() * 0.8;
    p.vx = Math.cos(a) * speed * (0.3 + u); p.vz = Math.sin(a) * speed * (0.3 + u); p.vy = speed * (0.2 + Math.random() * 0.8);
    p.c.setHex(hex);
  }
}
function stepParticles(dt) {
  for (let i = 0; i < PN; i++) {
    const p = parts[i];
    if (p.life > 0) {
      p.life -= dt; p.vy -= 22 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.y < 0.1) { p.y = 0.1; p.vy *= -0.4; }
      const f = Math.max(0, Math.min(1, p.life * 2));
      pPos.set([p.x, p.y, p.z], i * 3); pCol.set([p.c.r * f, p.c.g * f, p.c.b * f], i * 3);
      if (p.life <= 0) pPos[i * 3 + 1] = -99;
    }
  }
  pGeo.attributes.position.needsUpdate = true; pGeo.attributes.color.needsUpdate = true;
}

// ---------- audio (all generated) ----------
const audio = { ctx: null, master: null, muted: store.get('ba-muted') === '1', nextStep: 0, step: 0 };
function initAudio() {
  if (audio.ctx) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    audio.ctx = ctx;
    audio.master = ctx.createGain(); audio.master.gain.value = audio.muted ? 0 : 0.7;
    const comp = ctx.createDynamicsCompressor();
    audio.master.connect(comp).connect(ctx.destination);
    audio.music = ctx.createGain(); audio.music.gain.value = 0.32; audio.music.connect(audio.master);
    audio.sfx = ctx.createGain(); audio.sfx.gain.value = 0.8; audio.sfx.connect(audio.master);
    const len = ctx.sampleRate, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    audio.noise = buf;
    audio.nextStep = ctx.currentTime + 0.1;
    setInterval(scheduleMusic, 60);
  } catch { audio.ctx = null; }
}
function setMuted(m) {
  audio.muted = m; store.set('ba-muted', m ? '1' : '0');
  $('mute').textContent = m ? '🔇' : '🔊';
  if (audio.ctx) audio.master.gain.setTargetAtTime(m ? 0 : 0.7, audio.ctx.currentTime, 0.03);
}
$('mute').textContent = audio.muted ? '🔇' : '🔊';
$('mute').onclick = e => { setMuted(!audio.muted); e.currentTarget.blur(); };

function tone(type, f0, f1, dur, vol, when, dest) {
  const ctx = audio.ctx; if (!ctx) return;
  const t = when ?? ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vol, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(dest || audio.sfx); o.start(t); o.stop(t + dur + 0.02);
}
function noise(dur, vol, freq, when, dest, q = 1, type = 'bandpass') {
  const ctx = audio.ctx; if (!ctx) return;
  const t = when ?? ctx.currentTime, s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = audio.noise; f.type = type; f.frequency.value = freq; f.Q.value = q;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f).connect(g).connect(dest || audio.sfx); s.start(t, Math.random() * 0.5, dur + 0.02);
}
const sfx = {
  hit(i) { const v = Math.min(1, i / 25); tone('sine', 150, 50, 0.22, 0.5 * v + 0.15); noise(0.12, 0.35 * v + 0.1, 900); },
  kick(i) { const v = Math.min(1, i / 30); tone('triangle', 520 + v * 300, 260, 0.09, 0.3 * v + 0.12); noise(0.05, 0.2 * v + 0.05, 3000); },
  wall(i) { const v = Math.min(1, i / 35); tone('square', 220, 160, 0.06, 0.1 * v + 0.04); },
  bump() { tone('sine', 300, 900, 0.16, 0.35); tone('triangle', 600, 1800, 0.12, 0.15); },
  dash() { noise(0.25, 0.25, 1400, undefined, undefined, 0.7); tone('sawtooth', 180, 420, 0.18, 0.08); },
  beep(hi) { tone('square', hi ? 880 : 440, hi ? 880 : 440, hi ? 0.35 : 0.14, 0.14); },
  goal(mine) {
    const t = audio.ctx?.currentTime; if (t == null) return;
    for (const f of [196, 247, 294]) tone('sawtooth', f, f * 0.98, 1.1, 0.16, t);
    const notes = mine ? [523, 659, 784, 1047] : [523, 466, 392, 311];
    notes.forEach((f, i) => tone('triangle', f, f, 0.22, 0.25, t + 0.15 + i * 0.12));
    noise(0.9, 0.2, 5000, t, undefined, 0.5, 'highpass');
  },
  win(mine) {
    const t = audio.ctx?.currentTime; if (t == null) return;
    const notes = mine ? [392, 523, 659, 784, 1047, 1319] : [392, 370, 330, 294, 247, 196];
    notes.forEach((f, i) => tone('square', f, f, 0.3, 0.14, t + i * 0.16));
  },
};
// music: a small looping synth bed (bass, chord stabs, hat, kick)
const CHORDS = [[57, 60, 64, 67], [53, 57, 60, 64], [48, 52, 55, 59], [55, 59, 62, 65]]; // Am7 Fmaj7 Cmaj7 G7
const mtof = n => 440 * Math.pow(2, (n - 69) / 12);
function scheduleMusic() {
  const ctx = audio.ctx; if (!ctx || ctx.state !== 'running') return;
  const stepDur = 60 / 118 / 4;
  if (audio.nextStep < ctx.currentTime) audio.nextStep = ctx.currentTime + 0.05;
  while (audio.nextStep < ctx.currentTime + 0.2) {
    const s = audio.step, t = audio.nextStep, bar = Math.floor(s / 16) % 4, k = s % 16, ch = CHORDS[bar];
    const lively = !net.pz && (net.st === 'play' || net.st === 'goal');
    if (k % 4 === 0) { tone('sine', 120, 42, 0.22, 0.75, t, audio.music); }
    if (k % 2 === 0) {
      const root = ch[0] - 24 + (k === 14 ? 7 : k % 8 === 6 ? 12 : 0);
      tone('sawtooth', mtof(root), mtof(root), stepDur * 1.7, 0.2, t, audio.musicLP || (audio.musicLP = lp(500)));
    }
    if (k % 4 === 2) noise(0.04, lively ? 0.28 : 0.12, 8000, t, audio.music, 0.8, 'highpass');
    if (lively && (k === 4 || k === 12)) noise(0.12, 0.3, 1800, t, audio.music, 0.9);
    if (k === 0 || k === 6 || k === 11) for (const n of ch) tone('triangle', mtof(n + 12), mtof(n + 12), stepDur * 2.6, 0.07, t, audio.music);
    if (lively) { const arp = ch[[0, 2, 1, 3, 2, 1, 3, 2][k % 8]] + 24; tone('sine', mtof(arp), mtof(arp), stepDur * 1.2, 0.05, t, audio.music); }
    audio.step++; audio.nextStep += stepDur;
  }
}
function lp(freq) { const f = audio.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq; f.connect(audio.music); return f; }

// ---------- HUD ----------
let bannerTimer = 0;
function banner(html, color, ms = 1800) {
  const b = $('banner');
  b.innerHTML = html; b.style.color = color; b.style.textShadow = `0 0 30px ${color}`;
  b.classList.add('show');
  clearTimeout(bannerTimer);
  if (ms) bannerTimer = setTimeout(() => b.classList.remove('show'), ms);
}
let toastTimer = 0;
function toast(text) {
  const t = $('toast'); t.textContent = text; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
$('copy2').onclick = async e => {
  const btn = e.currentTarget;
  try { await navigator.clipboard.writeText(location.href); btn.textContent = 'Copied!'; } catch { btn.textContent = 'Copy it from above'; }
  setTimeout(() => { btn.textContent = 'Copy link'; }, 2500);
};
$('copy').onclick = async e => {
  const btn = e.currentTarget;
  try { await navigator.clipboard.writeText(location.href); btn.textContent = 'Link copied!'; }
  catch { btn.textContent = location.href; }
  setTimeout(() => { btn.textContent = 'Copy invite link'; }, 2500);
  btn.blur();
};

// ---------- pause menu and match settings ----------
const pick = { size: 2, mins: 3 };
function wsSend(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function togglePause() { if (joined) wsSend({ t: 'pause', on: !net.pz }); }
function markOpts() {
  for (const b of $('optsize').children) b.classList.toggle('on', Number(b.dataset.v) === pick.size);
  for (const b of $('optwin').children) b.classList.toggle('on', Number(b.dataset.v) === pick.mins);
}
function updateMenu() {
  const menu = $('menu'), amHost = roomInfo.host === myId && myId !== -1;
  menu.classList.toggle('show', !!net.pz);
  $('menubtn').textContent = net.pz ? '▶ Resume' : '⏸ Pause';
  if (!net.pz) return;
  $('pausedby').textContent = `Paused by ${net.pz}. Anyone can resume.`;
  pick.size = roomInfo.size; pick.mins = roomInfo.mins; markOpts();
  menu.classList.toggle('guest', !amHost);
  $('hostnote').textContent = amHost
    ? 'You are the host. Starting a new match resets the score for everyone.'
    : `Only the host${roomInfo.hostName ? ` (${roomInfo.hostName})` : ''} can change these and start a new match.`;
}
function applyRoomInfo(m) {
  Object.assign(roomInfo, { size: m.size, mins: m.mins, host: m.host, hostName: m.hostName });
  $('modename').textContent = `${m.size} v ${m.size}`;
  $('winat').textContent = m.mins;
  if (params.get('mode') !== String(m.size)) { // keep the invite link in step with the game
    params.set('mode', String(m.size));
    history.replaceState(null, '', `${location.pathname}?${params}`);
    $('sharelink').textContent = location.href;
  }
  if (net.pz) { const keep = { ...pick }; updateMenu(); Object.assign(pick, keep); markOpts(); }
}
$('menubtn').onclick = e => { togglePause(); e.currentTarget.blur(); };
$('resume').onclick = () => wsSend({ t: 'pause', on: false });
$('optsize').onclick = e => { const v = Number(e.target.dataset.v); if (v) { pick.size = v; markOpts(); } };
$('optwin').onclick = e => { const v = Number(e.target.dataset.v); if (v) { pick.mins = v; markOpts(); } };
$('newmatch').onclick = () => wsSend({ t: 'new', size: pick.size, mins: pick.mins });

// ---------- network ----------
let ws = null;
function myTeam() { const me = roster.find(p => p.id === myId); return me ? me.team : -1; }
let lastCount = -1, welcomed = false;

function connect(name) {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/?room=${encodeURIComponent(roomName)}`);
  ws.onopen = () => { $('status').textContent = ''; $('status').classList.remove('bad'); ws.send(JSON.stringify({ t: 'join', name, size: modeSize })); };
  ws.onclose = () => {
    const el = $('status'); el.classList.add('bad');
    el.textContent = welcomed ? 'Connection lost — reconnecting…' : 'Cannot reach the game server yet — retrying… (if this stays, your network may be blocking it)';
    setTimeout(() => connect(name), 1500);
  };
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.t === 'welcome') {
      myId = m.id;
      if (!cfg) { cfg = m.cfg; buildArena(); buildBall(); }
      $('modename').textContent = m.size === 1 ? '1 v 1' : '2 v 2';
      if (myId === -1) $('status').textContent = `Room is full (${m.size * 2} players) — you are spectating.`;
      else if (m.size !== modeSize && !welcomed) { $('status').textContent = `This room was already set to ${m.size} v ${m.size}.`; setTimeout(() => { $('status').textContent = ''; }, 6000); }
      else if (myId !== -1) $('status').textContent = '';
      welcomed = true; modeSize = m.size;
    } else if (m.t === 'roster') {
      if (cfg) { applyRoster(m.players); applyRoomInfo(m); }
    } else if (m.t === 's' && cfg) onState(m);
  };
}

function onState(m) {
  const prev = net.st;
  net.st = m.st; net.cd = m.cd; net.w = m.w;
  if (m.tl !== net.tl || m.gg !== net.gg) {
    net.tl = m.tl; net.gg = m.gg;
    $('clock').textContent = m.gg ? 'GOLDEN GOAL' : `${Math.floor(m.tl / 60)}:${String(m.tl % 60).padStart(2, '0')}`;
    $('clocklbl').textContent = m.gg ? 'NEXT GOAL WINS' : 'TIME';
    $('clockbox').classList.toggle('golden', !!m.gg);
    $('clockbox').classList.toggle('low', !m.gg && m.tl <= 10);
    if (!m.gg && m.tl <= 5 && m.tl > 0 && m.st === 'play') sfx.beep(false);
  }
  if ((m.pz || 0) !== net.pz) { net.pz = m.pz || 0; updateMenu(); }
  if (m.sc[0] !== net.sc[0] || m.sc[1] !== net.sc[1] || !joined) { $('s0').textContent = m.sc[0]; $('s1').textContent = m.sc[1]; }
  net.sc = m.sc;
  const snap = m.st === 'countdown' && prev !== 'countdown';
  for (const [id, x, z, vx, vz, dcd, dashing, h] of m.p) {
    const v = players.get(id); if (!v) continue;
    v.tx = x; v.tz = z; v.vx = vx; v.vz = vz; v.dashCd = dcd; v.dashing = dashing; v.th = -h; // server heading -> three.js y rotation
    if (v.fresh || snap) { v.x = x; v.z = z; v.heading = v.th; v.fresh = false; }
  }
  const b = ballView;
  [b.tx, b.tz, b.vx, b.vz] = m.b;
  if (b.fresh || snap) { b.x = b.tx; b.z = b.tz; b.fresh = false; for (let i = 0; i < b.N; i++) b.tpos.set([b.x, 0.35, b.z], i * 3); }
  if (m.st === 'countdown') {
    const n = Math.ceil(m.cd / 1000);
    if (n !== lastCount && n > 0) { lastCount = n; banner(String(n), '#ffffff', 900); sfx.beep(false); }
  } else lastCount = -1;
  if (m.e) for (const e of m.e) onEvent(e);
}

function onEvent(e) {
  const [type, a, b, c] = e;
  if (type === 'new') banner(`NEW MATCH<small>${a} v ${a} · ${b} minutes</small>`, '#ffe66b', 2200);
  else if (type === 'golden') { banner('GOLDEN GOAL<small>scores level — next goal wins</small>', '#ffe66b', 2600); sfx.beep(true); setTimeout(() => sfx.beep(true), 250); }
  else if (type === 'time') {
    const mine = a === myTeam();
    banner(`${TEAM_NAME[a]} WINS!<small>full time</small><small>new match starting soon…</small>`, TEAM_CSS[a], 6500);
    sfx.beep(true); setTimeout(() => sfx.win(mine || myTeam() === -1), 400);
  }
  else if (type === 'go') { banner('GO!', '#ffe66b', 700); sfx.beep(true); }
  else if (type === 'hit') { sfx.hit(c); burst(a, 1.3, b, 0xffffff, 10 + c, 6 + c * 0.3); shake = Math.max(shake, Math.min(0.8, c / 30)); }
  else if (type === 'kick') { sfx.kick(c); burst(a, 0.6, b, 0xffffff, 8, 5); }
  else if (type === 'wall') sfx.wall(c);
  else if (type === 'bump') { sfx.bump(); const bm = bumperMeshes[a]; if (bm) { bm.pulse = 1; burst(bm.g.position.x, 1.4, bm.g.position.z, 0xffe66b, 14, 8); } }
  else if (type === 'dash') { const v = players.get(a); if (v) { v.dash = 1; burst(v.x, 0.3, v.z, 0xffffff, 16, 5); if (v.isMe) sfx.dash(); } }
  else if (type === 'goal') {
    const team = a, mine = team === myTeam(), col = TEAM_CSS[team];
    const gx = (team === 0 ? 1 : -1) * (cfg.L + 1.5);
    burst(gx, 1.5, 0, TEAM_HEX[team], 120, 16); burst(gx, 1.5, 0, 0xffffff, 40, 10);
    goalGlow[1 - team].flash = 1; shake = 1;
    const who = b ? `<small>${esc(b)}</small>` : '';
    if (net.st === 'over') {
      banner(`${TEAM_NAME[team]} WINS!${who}<small>new match starting soon…</small>`, col, 6500);
      sfx.goal(mine); setTimeout(() => sfx.win(mine || myTeam() === -1), 700);
    } else { banner(`GOAL!${who}`, col, 2200); sfx.goal(mine || myTeam() === -1); }
  }
}

// ---------- input ----------
const keys = new Set();
let dashQueued = false, lastSent = '', lastSendT = 0;
const KEYMAP = { KeyW: 'u', ArrowUp: 'u', KeyS: 'd', ArrowDown: 'd', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r' };
addEventListener('keydown', e => {
  if (!joined) return;
  if (e.code === 'KeyM') { setMuted(!audio.muted); return; }
  if (e.code === 'KeyP' || e.code === 'Escape') { if (!e.repeat) togglePause(); return; }
  if (e.code === 'Space') { if (!e.repeat) dashQueued = true; e.preventDefault(); return; }
  const k = KEYMAP[e.code]; if (k) { keys.add(k); e.preventDefault(); }
});
addEventListener('keyup', e => { const k = KEYMAP[e.code]; if (k) keys.delete(k); });
addEventListener('blur', () => keys.clear());
// touch: left stick drives the car (up = forward, down = reverse, sideways = steer), right button dashes
const touchIn = { x: 0, z: 0 };
const isTouch = navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches;
if (isTouch) document.body.classList.add('touch');
{
  const stick = $('stick'), knob = $('knob'), R = 52;
  let pid = null;
  const move = e => {
    const r = stick.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy);
    if (d > R) { dx *= R / d; dy *= R / d; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    const dead = v => (Math.abs(v) < 0.18 ? 0 : v);
    touchIn.x = dead(dx / R); touchIn.z = dead(dy / R);
  };
  const end = e => { if (e.pointerId !== pid) return; pid = null; touchIn.x = touchIn.z = 0; knob.style.transform = ''; };
  stick.addEventListener('pointerdown', e => { pid = e.pointerId; try { stick.setPointerCapture(pid); } catch { /* pointer already gone */ } move(e); e.preventDefault(); });
  stick.addEventListener('pointermove', e => { if (e.pointerId === pid) move(e); });
  stick.addEventListener('pointerup', end); stick.addEventListener('pointercancel', end);
  const dash = $('dashbtn');
  dash.addEventListener('pointerdown', e => { dashQueued = true; dash.classList.add('down'); e.preventDefault(); });
  for (const t of ['pointerup', 'pointercancel', 'pointerleave']) dash.addEventListener(t, () => dash.classList.remove('down'));
  document.addEventListener('contextmenu', e => { if (isTouch) e.preventDefault(); });
}
function sendInput(now) {
  if (!ws || ws.readyState !== 1 || myId == null || myId < 0) return;
  const cl = v => Math.max(-1, Math.min(1, Math.round(v * 10) / 10));
  const x = cl((keys.has('r') ? 1 : 0) - (keys.has('l') ? 1 : 0) + touchIn.x), z = cl((keys.has('d') ? 1 : 0) - (keys.has('u') ? 1 : 0) + touchIn.z);
  const sig = x + ',' + z;
  if (sig !== lastSent && !dashQueued && now - lastSendT < 45) return; // cap analog stick updates at ~22 a second
  if (sig !== lastSent || dashQueued || now - lastSendT > 250) {
    ws.send(JSON.stringify({ t: 'in', x, z, d: dashQueued ? 1 : 0 }));
    lastSent = sig; lastSendT = now; dashQueued = false;
  }
}

// ---------- join screen ----------
const nameInput = $('name');
let modeSize = linkMode || (isHost && store.get('ba-mode') === '1' ? 1 : 2);
function setMode(n) { // host only: the choice travels in the link, so guests get the same game
  modeSize = n; store.set('ba-mode', String(n));
  $('mode1').classList.toggle('on', n === 1); $('mode2').classList.toggle('on', n === 2);
  params.set('mode', String(n));
  history.replaceState(null, '', `${location.pathname}?${params}`);
  $('sharelink').textContent = location.href;
}
$('mode1').onclick = () => setMode(1);
$('mode2').onclick = () => setMode(2);
if (isHost) { setMode(modeSize); $('fresh').style.display = 'inline'; }
else { $('hostopts').style.display = 'none'; $('sharelabel').textContent = 'You were invited to this game. Its link:'; }

// Tell people what the link leads to before they press Play.
async function refreshJoinInfo() {
  if (joined) return;
  let info = null;
  try { info = await (await fetch(`/api/room?room=${encodeURIComponent(roomName)}`, { cache: 'no-store' })).json(); } catch { /* offline */ }
  if (joined) return;
  const el = $('joininfo');
  if (info && info.exists && info.humans.length) {
    const who = info.humans.join(', '), full = info.humans.length >= info.size * 2;
    el.textContent = full
      ? `${who} are playing ${info.size} v ${info.size} here. The game is full, so you will watch.`
      : `${isHost ? 'Already in your game' : 'You are joining'}: ${who} — ${info.size} v ${info.size}.`;
    if (!isHost) modeSize = info.size;
  } else if (isHost) el.textContent = 'New game — nobody else is here yet.';
  else el.textContent = `Nobody is in this game yet. It is set to ${modeSize} v ${modeSize}; press Play and the others will join you.`;
  setTimeout(refreshJoinInfo, 2000);
}
refreshJoinInfo();
nameInput.value = store.get('ba-name') || '';
function start() {
  if (joined) return;
  joined = true;
  const name = nameInput.value.trim() || 'Player';
  store.set('ba-name', name);
  $('join').style.display = 'none';
  document.body.classList.add('playing');
  nameInput.blur();
  if (isTouch) { // best effort: go full screen and sideways where the phone allows it
    try { const p = document.documentElement.requestFullscreen?.(); p?.then(() => screen.orientation?.lock?.('landscape')?.catch(() => {})).catch(() => {}); } catch { /* not supported */ }
  }
  initAudio();
  connect(name);
}
$('play').onclick = start;
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') start(); });
nameInput.focus();

// ---------- frame loop ----------
let lastFrame = performance.now();
const camTarget = new THREE.Vector3();
let time = 0;
function frame() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastFrame) / 1000); lastFrame = now; time += dt;
  sendInput(now);
  const k = 1 - Math.exp(-dt * 20);
  if (cfg) {
    for (const v of players.values()) {
      v.x += (v.tx + v.vx * 0.03 - v.x) * k; v.z += (v.tz + v.vz * 0.03 - v.z) * k;
      v.g.position.set(v.x, 0, v.z);
      if (v.th != null) {
        const da = Math.atan2(Math.sin(v.th - v.heading), Math.cos(v.th - v.heading));
        v.heading += da * (1 - Math.exp(-dt * 25));
      }
      v.car.rotation.y = v.heading;
      v.car.rotation.z = Math.sin(time * 40) * 0.04 * v.dash;
      v.dash = Math.max(0, v.dash - dt * 2.5);
      const s = 1 + v.dash * 0.5; v.ring.scale.set(s, s, 1);
      v.ringMat.emissiveIntensity = 1.5 + v.dash * 4;
      if (v.marker) { v.marker.position.y = 6.6 + Math.sin(time * 5) * 0.25; v.marker.rotation.y = time * 2; }
      if (v.isMe) $('dashfill').style.width = (100 * (1 - Math.min(1, v.dashCd / cfg.DASH_CD))) + '%';
    }
    const b = ballView;
    if (b) {
      b.x += (b.tx + b.vx * 0.03 - b.x) * k; b.z += (b.tz + b.vz * 0.03 - b.z) * k;
      b.g.position.set(b.x, 0, b.z);
      b.mesh.rotation.y += Math.hypot(b.vx, b.vz) * dt * 0.4;
      b.tpos.copyWithin(3, 0, (b.N - 1) * 3); b.tpos.set([b.x, 0.35, b.z], 0);
      b.trail.geometry.attributes.position.needsUpdate = true;
    }
    for (const bm of bumperMeshes) { bm.pulse = Math.max(0, bm.pulse - dt * 3); bm.ringMat.emissiveIntensity = 1.4 + bm.pulse * 5; const s = 1 + bm.pulse * 0.25; bm.g.scale.set(s, 1, s); }
    for (const gg of goalGlow) if (gg) { gg.flash = Math.max(0, gg.flash - dt * 0.7); gg.mat.emissiveIntensity = 1.6 + gg.flash * 5 * (0.5 + 0.5 * Math.sin(time * 30)); gg.floorMat.opacity = 0.22 + gg.flash * 0.5; }
  }
  stepParticles(dt);
  // camera: fixed three-quarter view that leans a little toward the ball
  const bx = ballView ? ballView.x : 0, bz = ballView ? ballView.z : 0;
  camTarget.set(bx * 0.12, 0, -1.5 + bz * 0.08);
  shake = Math.max(0, shake - dt * 2.2);
  const idle = joined ? 0 : Math.sin(time * 0.2) * 6;
  camera.position.set(CAM_BASE.x * camScale + bx * 0.1 + idle + (Math.random() - 0.5) * shake, CAM_BASE.y * camScale + (Math.random() - 0.5) * shake, CAM_BASE.z * camScale + bz * 0.05);
  camera.lookAt(camTarget);
  skyParts.sky.material.uniforms.t.value = time;
  stepSnow(dt, time);
  arena.position.y = 0;
  if (innerWidth > 0 && innerHeight > 0) composer.render();
  requestAnimationFrame(frame);
}
frame();

window.__baReady = true;
// small hook for automated checks
window.__ba = { net, players, camera, touchIn, render: () => composer.render(), get ball() { return ballView; }, get roster() { return roster; }, get id() { return myId; }, keys };

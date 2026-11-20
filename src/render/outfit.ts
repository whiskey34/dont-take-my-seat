import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Look } from '../core/types';
import { accessory, COLORS, hairColor, type Accessory, type Model } from '../shop/catalog';
import type { Figure } from './figure';

/**
 * Shop accessories on a chibi figure: simple low-poly shapes, no textures.
 * Hats and hair sit on the head (a sphere of radius 0.26 with the face on +z
 * and the eyes at y = 0), face pieces on its front, back pieces on the upper
 * body. Without a shirt the figure keeps its own colour (the player's colour);
 * without a back piece it keeps its small pack; without a hairstyle it keeps
 * its own short hair.
 *
 * A hat and a hairstyle are worn together: every hat is wide enough to fit
 * over the thin layer of hair on the scalp, and the hairstyle leaves out its
 * volume on top when a hat is on, so only the hair below the hat shows.
 */
const hoodGeo = new THREE.SphereGeometry(0.2, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.6);
const maskGeo = new THREE.SphereGeometry(0.13, 18, 10);
const lensGeo = new THREE.SphereGeometry(0.058, 14, 8);
const rimGeo = new THREE.TorusGeometry(0.052, 0.011, 6, 18);
const bridgeGeo = new THREE.BoxGeometry(0.07, 0.014, 0.014);
const backpackGeo = new THREE.CapsuleGeometry(0.14, 0.14, 6, 12);
const strapGeo = new THREE.TorusGeometry(0.22, 0.016, 6, 28);
const pouchGeo = new THREE.BoxGeometry(0.15, 0.12, 0.07);
const toteGeo = new THREE.BoxGeometry(0.2, 0.22, 0.06);
const handleGeo = new THREE.TorusGeometry(0.07, 0.012, 6, 14, Math.PI);

const mats = new Map<string, THREE.MeshLambertMaterial>();
function mat(color: string, side: THREE.Side = THREE.FrontSide): THREE.MeshLambertMaterial {
  const key = `${color}/${side}`;
  let m = mats.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color, side });
    mats.set(key, m);
  }
  return m;
}
const darker = (color: string, k = 0.7) => `#${new THREE.Color(color).multiplyScalar(k).getHexString()}`;

const TAG = 'outfit';

/** How much of the hair a hat covers. */
type Cover = 'none' | 'hat' | 'helmet';

/** Puts the look on the figure (replacing whatever it wore before). */
export function dress(fig: Figure, look: Look, ownColor: string): void {
  // Take off the previous outfit.
  const old: THREE.Object3D[] = [];
  fig.root.traverse((o) => {
    if (o.userData[TAG]) old.push(o);
  });
  for (const o of old) o.removeFromParent();

  const shirt = accessory(look.body);
  const bodyColor = shirt ? COLORS[shirt.color] : ownColor;
  fig.body.material = mat(bodyColor);
  // Hoodies have sleeves; shirts leave the arms bare.
  const sleeves = shirt?.model === 'hoodie';
  for (const arm of fig.arms) {
    const a = arm.children[0] as THREE.Mesh;
    if (!a.userData.skin) a.userData.skin = a.material;
    a.material = sleeves ? mat(bodyColor) : (a.userData.skin as THREE.Material);
  }
  if (sleeves) add(fig.upper, hoodGeo, darker(bodyColor, 0.85), [0, 0.42, -0.13], [1.1, 0.8, 0.9], [-0.5, 0, 0]);

  const head = accessory(look.head);
  const hair = accessory(look.hair);
  const cover: Cover = !head ? 'none' : head.model === 'helmet' ? 'helmet' : 'hat';
  // A bought hairstyle replaces the figure's own short hair (which fits under every hat).
  if (fig.hair) fig.hair.visible = !hair;
  if (hair && hair.model !== 'bald') wear(fig.head, `hair/${hair.model}/${hair.color}/${cover}`, () => buildHair(hair.model, hairColor(hair.color), cover));
  if (head) wear(fig.head, `hat/${head.model}/${head.color}`, () => buildHat(head.model, COLORS[head.color]));
  const face = accessory(look.face);
  if (face) addFace(fig, face);
  const back = accessory(look.back);
  if (fig.pack) {
    fig.pack.userData.covered = !!back;
    fig.pack.visible = !back && !fig.seated;
  }
  if (back) addBack(fig, back);
}

/** Models are built once and then shared: every figure gets a light copy (same geometry and materials). */
const templates = new Map<string, THREE.Group>();
function wear(parent: THREE.Object3D, key: string, build: () => THREE.Group): void {
  let tpl = templates.get(key);
  if (!tpl) {
    tpl = build();
    templates.set(key, tpl);
  }
  const copy = tpl.clone();
  copy.userData[TAG] = true;
  parent.add(copy);
}

function add(
  parent: THREE.Object3D,
  geo: THREE.BufferGeometry,
  color: string,
  pos: [number, number, number],
  scale: [number, number, number] = [1, 1, 1],
  rot: [number, number, number] = [0, 0, 0],
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat(color));
  m.position.set(...pos);
  m.scale.set(...scale);
  m.rotation.set(...rot);
  m.userData[TAG] = true;
  parent.add(m);
  return m;
}

// ------------------------------------------------------------- hats and hair

const R_HEAD = 0.26;
/** Thin hair layer on the scalp. */
const R_SCALP = 0.275;
/** Inside radius of every hat: fits over the scalp layer. */
const R_HAT = 0.292;

function mesh(geo: THREE.BufferGeometry, material: THREE.Material, pos: [number, number, number] = [0, 0, 0], rot: [number, number, number] = [0, 0, 0], scale: [number, number, number] = [1, 1, 1]): THREE.Mesh {
  const m = new THREE.Mesh(geo, material);
  m.position.set(...pos);
  m.rotation.set(...rot);
  m.scale.set(...scale);
  return m;
}

const lathe = (pts: Array<[number, number]>, segments = 40) =>
  new THREE.LatheGeometry(
    pts.map(([r, y]) => new THREE.Vector2(r, y)),
    segments,
  );

// ------------------------------------------------------------------- hats

/** Shell radius of the motorcycle helmet: covers the ears. */
const R_HELM = 0.328;

/** Baseball cap visor: a crescent that hugs the crown and droops at the sides. */
function visorGeo(): THREE.BufferGeometry {
  const r = R_HAT - 0.012;
  const a = (58 * Math.PI) / 180;
  const ex = r * Math.sin(a);
  const ey = r * Math.cos(a);
  const tip = 0.475;
  const s = new THREE.Shape();
  s.moveTo(ex, ey);
  s.bezierCurveTo(ex + 0.035, ey + 0.2, 0.17, tip, 0, tip);
  s.bezierCurveTo(-0.17, tip, -ex - 0.035, ey + 0.2, -ex, ey);
  s.absarc(0, 0, r, Math.PI / 2 + a, Math.PI / 2 - a, true);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.014, bevelEnabled: true, bevelSize: 0.005, bevelThickness: 0.004, bevelSegments: 2, curveSegments: 18 });
  g.rotateX(Math.PI / 2); // shape y -> forward, thickness -> down
  const p = g.attributes.position!;
  for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) - 0.75 * p.getX(i) ** 2); // curved like a real visor
  g.translate(0, 0, -r); // pivot where it meets the crown
  g.computeVertexNormals();
  return g;
}

function buildHat(model: Model, color: string): THREE.Group {
  const g = new THREE.Group();
  const main = mat(color);
  const dark = mat(darker(color, 0.72));
  switch (model) {
    case 'cap': {
      // Six-panel baseball cap: structured crown, sweatband, seams, top button, curved visor.
      const base = 0.07;
      const crown = mesh(new THREE.SphereGeometry(R_HAT, 32, 14, 0, Math.PI * 2, 0, Math.PI / 2), main, [0, base, 0], [0, 0, 0], [1, 0.84, 1.03]);
      const band = mesh(new THREE.CylinderGeometry(R_HAT, R_HAT - 0.004, 0.05, 32, 1, true), main, [0, base - 0.025, 0], [0, 0, 0], [1, 1, 1.03]);
      const seamGeo = new THREE.TorusGeometry(R_HAT + 0.0015, 0.0035, 4, 28, Math.PI);
      for (let i = 0; i < 3; i++) g.add(mesh(seamGeo, dark, [0, base, 0], [0, (i * Math.PI) / 3 + Math.PI / 2, 0], [1, 0.84, 1.03]));
      const button = mesh(new THREE.SphereGeometry(0.026, 12, 8), dark, [0, base + R_HAT * 0.84, 0], [0, 0, 0], [1, 0.45, 1]);
      const visor = mesh(visorGeo(), dark, [0, base - 0.03, (R_HAT - 0.012) * 1.03], [0.2, 0, 0]);
      // Closes the small gap between head and hat when seen from below.
      const inner = mesh(new THREE.RingGeometry(R_HEAD - 0.02, R_HAT, 32), dark, [0, base - 0.05, 0], [Math.PI / 2, 0, 0], [1, 1.03, 1]);
      g.add(crown, band, button, visor, inner);
      g.rotation.x = -0.14; // sits back a little: forehead shows, back comes down
      g.position.set(0, 0.035, 0.004);
      break;
    }
    case 'bucket': {
      // Soft bucket hat: flat-ish top, rounded shoulder, brim sloping down.
      const body = mesh(
        lathe([
          [0, 0.2],
          [0.12, 0.2],
          [0.19, 0.19],
          [0.235, 0.165],
          [0.262, 0.12],
          [R_HAT, 0.0],
          [0.33, -0.03],
          [0.415, -0.105],
          [0.43, -0.125],
        ]),
        mat(color, THREE.DoubleSide),
      );
      const underBrim = mesh(
        lathe([
          [R_HAT - 0.03, -0.008],
          [0.33, -0.04],
          [0.415, -0.113],
          [0.43, -0.127],
        ]),
        mat(darker(color, 0.8), THREE.DoubleSide),
      );
      // Stitched band where the brim meets the crown.
      const band = mesh(
        lathe([
          [R_HAT + 0.003, 0.0],
          [R_HAT - 0.004, 0.035],
        ]),
        dark,
      );
      const stitch = [0.345, 0.385].map((r) => {
        const y = -0.03 - ((r - 0.33) / 0.085) * 0.075;
        return mesh(new THREE.TorusGeometry(r, 0.003, 4, 48), dark, [0, y + 0.004, 0], [Math.PI / 2, 0, 0]);
      });
      g.add(body, underBrim, band, ...stitch);
      g.position.set(0, 0.115, 0);
      g.rotation.x = -0.16;
      break;
    }
    case 'beanie': {
      // Knit beanie: ribbed folded cuff, soft slouchy top, pompom.
      const top = lathe(
        [
          [R_HAT + 0.002, 0.03],
          [R_HAT + 0.006, 0.1],
          [0.285, 0.17],
          [0.25, 0.235],
          [0.19, 0.285],
          [0.11, 0.315],
          [0, 0.325],
        ],
        48,
      );
      const cuff = lathe(
        [
          [R_HAT - 0.006, -0.012],
          [R_HAT + 0.014, -0.006],
          [R_HAT + 0.02, 0.04],
          [R_HAT + 0.018, 0.078],
          [R_HAT + 0.004, 0.088],
        ],
        72,
      );
      rib(cuff, 24, 0.012);
      rib(top, 24, 0.006);
      const pom = new THREE.SphereGeometry(0.068, 16, 12);
      fuzz(pom, 0.012);
      g.add(mesh(top, main), mesh(cuff, mat(darker(color, 0.86))), mesh(pom, mat('#f4f1ea'), [0, 0.35, 0]));
      g.position.set(0, 0.07, -0.005);
      g.rotation.x = -0.2;
      break;
    }
    case 'peci': {
      // Songkok / peci: oval, straight velvet sides, flat top with a folded edge.
      const side = lathe(
        [
          [0.262, 0.0],
          [0.262, 0.012],
          [0.256, 0.17],
          [0.25, 0.186],
          [0.236, 0.192],
          [0, 0.192],
        ],
        48,
      );
      const edge = mesh(new THREE.TorusGeometry(0.249, 0.006, 6, 48), mat(darker(color, 1.9)), [0, 0.187, 0], [Math.PI / 2, 0, 0]);
      const trim = mesh(
        lathe(
          [
            [0.2635, 0.0],
            [0.2632, 0.022],
          ],
          48,
        ),
        mat(darker(color, 1.9)),
      );
      const grp = new THREE.Group();
      grp.add(mesh(side, main), edge, trim);
      grp.scale.set(0.97, 1, 1.1); // longer front to back, like the real thing
      g.add(grp);
      g.position.set(0, 0.1, -0.012);
      g.rotation.x = -0.1;
      break;
    }
    case 'helmet': {
      // Open-face motorcycle helmet: glossy shell down to the jaw, dark padding
      // around the face opening, smoked visor on two bolts, stripe, chin strap.
      const patch = (r: number, phi: [number, number], theta: [number, number]) =>
        new THREE.SphereGeometry(r, 40, 20, Math.PI * phi[0], Math.PI * (phi[1] - phi[0]), Math.PI * theta[0], Math.PI * (theta[1] - theta[0]));
      const shellMat = new THREE.MeshPhongMaterial({ color, shininess: 90, specular: '#666666' });
      const pad = mat('#22262c', THREE.DoubleSide);
      const sh = new THREE.Group();
      // Outside: dome + sides and back (the front is open for the face).
      sh.add(mesh(patch(R_HELM, [0, 2], [0, 0.385]), shellMat));
      sh.add(mesh(patch(R_HELM, [0.85, 2.15], [0.385, 0.73]), shellMat));
      // Padding: a little smaller, reaching a little further into the opening.
      sh.add(mesh(patch(R_HELM - 0.014, [0, 2], [0, 0.41]), pad));
      sh.add(mesh(patch(R_HELM - 0.014, [0.82, 2.18], [0.385, 0.745]), pad));
      // Rubber edge along the bottom.
      sh.add(mesh(new THREE.TorusGeometry(R_HELM * Math.sin(Math.PI * 0.73), 0.012, 6, 40, Math.PI * 1.3), pad, [0, R_HELM * Math.cos(Math.PI * 0.73), 0], [Math.PI / 2, 0, -Math.PI * 0.15]));
      // Stripe over the top, front to back.
      const light = new THREE.Color(color).getHSL({ h: 0, s: 0, l: 0 }).l > 0.6;
      const stripe = mat(light ? '#24272c' : '#f4f1ea');
      sh.add(mesh(new THREE.TorusGeometry(R_HELM - 0.02, 0.0262, 8, 40, 3.52), stripe, [0, 0, 0], [0, -Math.PI / 2, 0.36]));
      // Visor: smoked, see-through, hinged at the temples.
      const glass = new THREE.MeshPhongMaterial({ color: '#9fd4ee', transparent: true, opacity: 0.26, shininess: 120, depthWrite: false });
      const visor = new THREE.Group();
      visor.add(mesh(patch(R_HELM + 0.006, [0.13, 0.87], [0.355, 0.64]), glass));
      visor.add(mesh(patch(R_HELM + 0.008, [0.13, 0.87], [0.34, 0.37]), pad));
      for (const side of [-1, 1]) {
        visor.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.016, 14), mat('#c9ced6'), [side * (R_HELM + 0.004) * 0.93, 0.04, R_HELM * 0.36], [0, 0, Math.PI / 2]));
      }
      sh.add(visor);
      sh.scale.set(1, 1, 1.05);
      g.add(sh);
      // Chin strap.
      const strap = mesh(new THREE.TorusGeometry(0.262, 0.009, 4, 32, Math.PI * 0.9), mat('#15181c'), [0, -0.02, 0.03], [0, 0, Math.PI * 1.05]);
      strap.scale.set(1, 1.06, 1);
      g.add(strap);
      g.position.set(0, 0.012, -0.006);
      break;
    }
    case 'caping': {
      // Farmer's hat: wide woven cone, darker rim, woven rings, chin string.
      const cone = lathe(
        [
          [0, 0.24],
          [0.03, 0.232],
          [0.5, 0.0],
          [0.508, -0.012],
        ],
        40,
      );
      const inside = lathe(
        [
          [0.02, 0.222],
          [0.5, -0.012],
        ],
        40,
      );
      g.add(mesh(cone, mat(color, THREE.DoubleSide)), mesh(inside, mat(darker(color, 0.62), THREE.BackSide)));
      for (const r of [0.14, 0.26, 0.38]) {
        g.add(mesh(new THREE.TorusGeometry(r, 0.004, 4, 40), dark, [0, 0.24 - (r / 0.5) * 0.24 + 0.002, 0], [Math.PI / 2, 0, 0]));
      }
      g.add(mesh(new THREE.TorusGeometry(0.5, 0.008, 6, 48), dark, [0, -0.004, 0], [Math.PI / 2, 0, 0]));
      // Chin string, tied under the chin.
      const str = mesh(new THREE.TorusGeometry(0.27, 0.005, 4, 40, Math.PI * 1.25), mat('#5b4631'), [0, -0.085, 0.02], [0, 0, Math.PI * 0.875]);
      str.scale.set(1, 1.28, 1);
      g.add(str);
      g.position.set(0, 0.125, 0);
      g.rotation.x = -0.1;
      break;
    }
    default:
      break;
  }
  return g;
}

/** Knit ribs: push the surface in and out around the axis. */
function rib(geo: THREE.BufferGeometry, count: number, depth: number): void {
  const p = geo.attributes.position!;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    const r = Math.hypot(x, z);
    if (r < 1e-4) continue;
    const k = 1 + (depth * Math.cos(Math.atan2(z, x) * count)) / r;
    p.setX(i, x * k);
    p.setZ(i, z * k);
  }
  geo.computeVertexNormals();
}

/** Small bumps so a pompom reads as wool. */
function fuzz(geo: THREE.BufferGeometry, depth: number): void {
  const p = geo.attributes.position!;
  for (let i = 0; i < p.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(p, i);
    const n = Math.sin(v.x * 190) * Math.sin(v.y * 170 + 1) * Math.sin(v.z * 210 + 2);
    v.multiplyScalar(1 + (n * depth) / v.length());
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
}

// ------------------------------------------------------------------- hair

/** Thin layer on the scalp: `drop` = how far down it reaches (in turns of pi from the top). */
function scalp(mat: THREE.Material, drop = 0.52, tilt = -0.32): THREE.Mesh {
  return mesh(new THREE.SphereGeometry(R_SCALP, 32, 16, 0, Math.PI * 2, 0, Math.PI * drop), mat, [0, 0.012, 0], [tilt, 0, 0]);
}

/** An ellipsoid lock of hair. */
function lock(mat: THREE.Material, pos: [number, number, number], size: [number, number, number], rot: [number, number, number] = [0, 0, 0]): THREE.Mesh {
  return mesh(LOCK, mat, pos, rot, size);
}
const LOCK = new THREE.SphereGeometry(1, 16, 12);
/** A pointed tuft (tip towards +y before rotation). */
function spike(mat: THREE.Material, pos: [number, number, number], size: [number, number, number], rot: [number, number, number]): THREE.Mesh {
  return mesh(SPIKE, mat, pos, rot, size);
}
const SPIKE = (() => {
  const g = new THREE.ConeGeometry(1, 2, 10, 4);
  // Round the base so tufts blend into the head.
  const p = g.attributes.position!;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const k = 1 - 0.35 * Math.max(0, -y) ** 2;
    p.setX(i, p.getX(i) * k);
    p.setZ(i, p.getZ(i) * k);
  }
  g.computeVertexNormals();
  return g;
})();

/** Afro puffs: little balls spread evenly over the hair area (not the face). */
function afroGeo(underHat: boolean): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const n = 170;
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const rr = Math.sqrt(1 - y * y);
    const phi = i * 2.399963;
    const d = new THREE.Vector3(Math.cos(phi) * rr, y, Math.sin(phi) * rr);
    if (d.z > 0.08 && d.y < 0.6) continue; // keep the face clear: hairline above the forehead, in front of the ears
    if (d.y < -0.6) continue; // nothing under the chin / neck
    if (underHat && d.y > -0.05) continue;
    const size = 0.105 + 0.014 * Math.sin(i * 12.9898);
    const dist = underHat ? 0.25 : 0.285 + 0.012 * Math.cos(i * 4.1);
    const s = new THREE.SphereGeometry(size, 10, 8);
    s.translate(d.x * dist, d.y * dist + (underHat ? -0.01 : 0.045), d.z * dist - 0.02);
    parts.push(s);
  }
  return mergeGeometries(parts)!;
}

/** A piece of a shell just above the scalp (fringes, bangs). */
function shell(mat: THREE.Material, radius: number, phi: [number, number], theta: [number, number], rot: [number, number, number]): THREE.Mesh {
  return mesh(new THREE.SphereGeometry(radius, 24, 14, Math.PI * phi[0], Math.PI * (phi[1] - phi[0]), Math.PI * theta[0], Math.PI * (theta[1] - theta[0])), mat, [0, 0, 0.003], rot);
}

/**
 * Builds a hairstyle. With a hat on, the volume on top is left out so the hat
 * fits, and only the hair that would stick out below it stays.
 */
function buildHair(style: Model, color: string, cover: Cover, accent = '#e23d7c'): THREE.Group {
  const underHat = cover !== 'none';
  const g = new THREE.Group();
  const m = mat(color);
  const top = new THREE.Group(); // hidden under a hat
  g.add(top);
  top.visible = !underHat;
  switch (style) {
    case 'afro': {
      // A helmet squashes the afro completely; other hats leave the sides out.
      if (cover !== 'helmet') g.add(mesh(afroGeo(underHat), m));
      if (underHat) g.add(scalp(m, 0.5, -0.3));
      break;
    }
    case 'emo': {
      g.add(scalp(m, 0.56, -0.42));
      // Long fringe swept across the forehead and over one eye.
      g.add(shell(m, R_SCALP + 0.012, [0.04, 0.63], [0.08, 0.5], [0, 0, 0.5]));
      g.add(shell(mat(accent), R_SCALP + 0.015, [0.43, 0.49], [0.1, 0.5], [0, 0, 0.5]));
      // Pointed tips of the fringe.
      g.add(spike(m, [-0.19, -0.08, 0.195], [0.05, 0.07, 0.03], [0.1, 0.7, Math.PI + 0.5]));
      g.add(spike(m, [-0.125, -0.055, 0.245], [0.05, 0.065, 0.026], [0.05, 0.45, Math.PI + 0.45]));
      g.add(spike(m, [-0.055, -0.02, 0.272], [0.045, 0.06, 0.024], [0, 0.2, Math.PI + 0.4]));
      g.add(spike(m, [0.02, 0.03, 0.278], [0.045, 0.055, 0.024], [0, 0, Math.PI + 0.3]));
      g.add(spike(m, [0.09, 0.085, 0.262], [0.04, 0.05, 0.022], [0, -0.3, Math.PI + 0.2]));
      // Side pieces in front of the ears, choppy ends at the nape.
      g.add(spike(m, [-0.262, -0.1, 0.04], [0.045, 0.14, 0.07], [0, 0, Math.PI - 0.08]));
      g.add(spike(m, [0.262, -0.08, 0.03], [0.04, 0.12, 0.065], [0, 0, Math.PI + 0.08]));
      for (let i = -2; i <= 2; i++) {
        const a = i * 0.42;
        g.add(spike(m, [Math.sin(a) * 0.235, -0.15, -Math.cos(a) * 0.235], [0.055, 0.1, 0.045], [-0.45 * Math.cos(a), 0, Math.PI - 0.45 * Math.sin(a)]));
      }
      // A little volume at the crown.
      top.add(lock(m, [0, 0.07, -0.07], [0.275, 0.24, 0.25]));
      break;
    }
    case 'long': {
      g.add(scalp(m, 0.5, -0.22));
      // Curtain down the back, over the shoulders.
      g.add(mesh(new THREE.CapsuleGeometry(0.255, 0.13, 8, 20), m, [0, -0.085, cover === 'helmet' ? -0.085 : -0.115], [cover === 'helmet' ? 0.02 : 0.14, 0, 0], [1.07, 1, 0.6]));
      for (const s of [-1, 1]) {
        // Parted in the middle: each side sweeps down to the temple.
        g.add(shell(m, R_SCALP + 0.011, s < 0 ? [0.08, 0.5] : [0.5, 0.92], [0.06, 0.4], [0, 0, s * -0.42]));
        // Strands in front of the ears, down to the chest.
        g.add(lock(m, [s * 0.258, -0.14, 0.03], [0.04, 0.21, 0.075], [0, 0, s * 0.04]));
      }
      break;
    }
    case 'mullet': {
      g.add(scalp(m, 0.5, -0.3));
      // Party in the back: long, flared out at the bottom, ending in points.
      g.add(mesh(new THREE.CapsuleGeometry(0.2, 0.16, 8, 16), m, [0, -0.11, cover === 'helmet' ? -0.13 : -0.175], [cover === 'helmet' ? 0.05 : 0.22, 0, 0], [1, 1, 0.5]));
      for (let i = -2; i <= 2; i++) {
        g.add(spike(m, [i * 0.085, -0.34 + Math.abs(i) * 0.03, (cover === 'helmet' ? -0.16 : -0.25) + Math.abs(i) * 0.012], [0.055, 0.085, 0.04], [0.5, 0, Math.PI - i * 0.12]));
      }
      // Short straight fringe with a few choppy tips.
      g.add(shell(m, R_SCALP + 0.008, [0.2, 0.8], [0.12, 0.36], [0, 0, 0]));
      for (let i = -1; i <= 1; i++) {
        const a = i * 0.36;
        g.add(spike(m, [Math.sin(a) * 0.268, 0.1, Math.cos(a) * 0.262], [0.05, 0.03, 0.016], [0.1, a, Math.PI]));
      }
      // Business in the front: short brushed-up top.
      top.add(mesh(new THREE.SphereGeometry(R_SCALP + 0.014, 28, 12, 0, Math.PI * 2, 0, Math.PI * 0.4), m, [0, 0.016, -0.004], [-0.3, 0, 0], [1, 1.07, 1]));
      break;
    }
    default:
      break;
  }
  return g;
}

// ------------------------------------------------------------- face and back

function addFace(fig: Figure, a: Accessory): void {
  const c = COLORS[a.color];
  const h = fig.head;
  switch (a.model) {
    case 'mask':
      add(h, maskGeo, c, [0, -0.1, 0.18], [1.25, 0.75, 0.62]);
      break;
    case 'shades':
      for (const side of [-1, 1]) add(h, lensGeo, '#15181c', [side * 0.09, 0.005, 0.236], [1.15, 0.85, 0.35]);
      add(h, bridgeGeo, '#15181c', [0, 0.02, 0.258]);
      break;
    case 'glasses':
      for (const side of [-1, 1]) add(h, rimGeo, c, [side * 0.09, 0.0, 0.25]);
      add(h, bridgeGeo, c, [0, 0.01, 0.262]);
      break;
    default:
      break;
  }
}

function addBack(fig: Figure, a: Accessory): void {
  const c = COLORS[a.color];
  const u = new THREE.Group();
  u.userData[TAG] = true;
  u.userData.onBack = true;
  u.visible = !fig.seated;
  fig.upper.add(u);
  switch (a.model) {
    case 'backpack': {
      const bag = add(u, backpackGeo, c, [0, 0.22, -0.23], [1.15, 1, 0.65]);
      bag.userData.pack = true;
      break;
    }
    case 'sling':
      add(u, strapGeo, darker(c, 0.8), [0, 0.2, 0], [0.95, 1, 0.75], [0, 0, 0.75]);
      add(u, pouchGeo, c, [0.17, 0.06, 0.12], [1, 1, 1], [0, -0.5, 0]);
      break;
    case 'tote': {
      const bag = add(u, toteGeo, c, [0.24, 0.08, 0.0]);
      add(bag, handleGeo, darker(c, 0.75), [0, 0.11, 0], [1, 1, 1]);
      break;
    }
    default:
      break;
  }
}

/** Jumbo backpack ready (shop item): the bag on the back grows. */
export function setJumbo(fig: Figure, on: boolean): void {
  const s = on ? 1.6 : 1;
  if (fig.pack) fig.pack.scale.set(1.1 * s, s, 0.6 * s);
  fig.upper.traverse((o) => {
    if (o.userData.pack) o.scale.set(1.15 * s, s, 0.65 * s);
  });
}

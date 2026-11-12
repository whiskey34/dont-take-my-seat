import * as THREE from 'three';
import type { Look } from '../core/types';
import { accessory, COLORS, type Accessory } from '../shop/catalog';
import type { Figure } from './figure';

/**
 * Shop accessories on a chibi figure: simple low-poly shapes, no textures.
 * Head pieces sit on the head (radius 0.26), face pieces on its front (+z),
 * back pieces on the upper body. Without a shirt the figure keeps its own
 * colour (the player's colour); without a back piece it keeps its small pack.
 */
const capCrownGeo = new THREE.SphereGeometry(0.285, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.5);
const capBrimGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.022, 24);
const bucketTopGeo = new THREE.CylinderGeometry(0.2, 0.25, 0.15, 24);
const bucketBrimGeo = new THREE.CylinderGeometry(0.37, 0.37, 0.02, 28);
const beanieGeo = new THREE.SphereGeometry(0.29, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.52);
const pompomGeo = new THREE.SphereGeometry(0.06, 12, 8);
const peciGeo = new THREE.CylinderGeometry(0.205, 0.215, 0.14, 24);
const capingGeo = new THREE.ConeGeometry(0.52, 0.24, 28, 1, true);
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
function mat(color: string): THREE.MeshLambertMaterial {
  let m = mats.get(color);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color });
    mats.set(color, m);
  }
  return m;
}
const darker = (color: string, k = 0.7) => `#${new THREE.Color(color).multiplyScalar(k).getHexString()}`;

const TAG = 'outfit';

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
  // Hats that cover the top of the head hide the hair (it would poke through).
  if (fig.hair) fig.hair.visible = !head || head.model === 'peci' || head.model === 'caping';
  if (head) addHead(fig, head);
  const face = accessory(look.face);
  if (face) addFace(fig, face);
  const back = accessory(look.back);
  if (fig.pack) {
    fig.pack.userData.covered = !!back;
    fig.pack.visible = !back && !fig.seated;
  }
  if (back) addBack(fig, back);
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

function addHead(fig: Figure, a: Accessory): void {
  const c = COLORS[a.color];
  const h = fig.head;
  switch (a.model) {
    case 'cap':
      add(h, capCrownGeo, c, [0, 0.02, -0.01], [1, 0.9, 1], [-0.18, 0, 0]);
      add(h, capBrimGeo, darker(c, 0.85), [0, 0.04, 0.22], [1, 1, 0.75], [0.12, 0, 0]);
      break;
    case 'bucket':
      add(h, bucketTopGeo, c, [0, 0.19, 0]);
      add(h, bucketBrimGeo, darker(c, 0.9), [0, 0.12, 0], [1, 1, 1], [-0.06, 0, 0]);
      break;
    case 'beanie':
      add(h, beanieGeo, c, [0, 0.0, -0.01], [1, 0.95, 1], [-0.12, 0, 0]);
      add(h, pompomGeo, darker(c, 0.8), [0, 0.29, -0.04]);
      break;
    case 'peci':
      add(h, peciGeo, c, [0, 0.2, -0.01], [1, 1, 0.95], [-0.1, 0, 0]);
      break;
    case 'caping':
      (add(h, capingGeo, c, [0, 0.28, 0]).material as THREE.Material).side = THREE.DoubleSide;
      break;
    default:
      break;
  }
}

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

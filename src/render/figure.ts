import * as THREE from 'three';

/**
 * Chibi passengers: a big round head with a simple face, a small body, and
 * arms and legs that swing when walking (and kick). Low-poly and procedural:
 * no model files to download.
 */

// Everything round and soft: smooth spheres and capsules with plenty of segments.
const headGeo = new THREE.SphereGeometry(0.26, 28, 20);
const hairGeo = new THREE.SphereGeometry(0.274, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.52);
const hairBackGeo = new THREE.SphereGeometry(0.27, 20, 10, Math.PI * 0.62, Math.PI * 0.76, Math.PI * 0.4, Math.PI * 0.32);
const eyeGeo = new THREE.SphereGeometry(0.032, 12, 8);
const browGeo = new THREE.CapsuleGeometry(0.011, 0.05, 2, 6);
const earGeo = new THREE.SphereGeometry(0.058, 12, 8);
const torsoGeo = new THREE.SphereGeometry(0.2, 24, 18); // a round little belly
const armGeo = new THREE.CapsuleGeometry(0.058, 0.15, 6, 12);
const handGeo = new THREE.SphereGeometry(0.064, 12, 10);
const legGeo = new THREE.CapsuleGeometry(0.086, 0.1, 6, 14);
const shoeGeo = new THREE.SphereGeometry(0.1, 14, 10);
const packGeo = new THREE.CapsuleGeometry(0.12, 0.1, 6, 12);
const shadowGeo = new THREE.CircleGeometry(0.34, 20);
const shadowMat = new THREE.MeshBasicMaterial({ color: '#1d2733', transparent: true, opacity: 0.22, depthWrite: false });
const eyeMat = new THREE.MeshBasicMaterial({ color: '#1b1f24' });
const browMat = new THREE.MeshBasicMaterial({ color: '#2a2320' });
const shoeMat = new THREE.MeshLambertMaterial({ color: '#23282f' });

const HAIR = ['#2b211c', '#3b2a20', '#1d1a18', '#5b3b26', '#151515'];
const PANTS = ['#2f4a6d', '#3a3f4a', '#2c3e50', '#4b3f36', '#25304a'];

/** Standing hip height; legs hang from here. */
const HIP_Y = 0.34;
/** On a bench the hips rest on the cushion. */
const SEAT_HIP_Y = 0.56;

export interface Figure {
  root: THREE.Group;
  /** Everything above the hips (moves up when seated). */
  upper: THREE.Group;
  body: THREE.Mesh;
  head: THREE.Mesh; // skin colour lives here
  hair: THREE.Mesh | null;
  pack: THREE.Mesh | null;
  shadow: THREE.Mesh;
  arms: [THREE.Group, THREE.Group]; // shoulder pivots (left, right)
  legs: [THREE.Group, THREE.Group]; // hip pivots (left, right)
  seated: boolean;
}

/**
 * @param bodyColor shirt colour
 * @param skinColor head and arms
 * @param withPack  small backpack
 * @param look      a number that picks hair and trousers, so crowds vary
 */
export function createFigure(bodyColor: string, skinColor: string, withPack: boolean, look = 0): Figure {
  const root = new THREE.Group();
  const lambert = (c: string) => new THREE.MeshLambertMaterial({ color: c });
  const skin = lambert(skinColor);

  // Legs from the hips.
  const pants = lambert(PANTS[look % PANTS.length]!);
  const legs = [-1, 1].map((side) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.085, HIP_Y, 0);
    const leg = new THREE.Mesh(legGeo, pants);
    leg.position.y = -0.14;
    const shoe = new THREE.Mesh(shoeGeo, shoeMat);
    shoe.position.set(0, -0.29, 0.035);
    shoe.scale.set(0.85, 0.55, 1.25);
    pivot.add(leg, shoe);
    root.add(pivot);
    return pivot;
  }) as [THREE.Group, THREE.Group];

  // Upper body sits on the hips.
  const upper = new THREE.Group();
  upper.position.y = HIP_Y;
  root.add(upper);
  const body = new THREE.Mesh(torsoGeo, lambert(bodyColor));
  body.position.y = 0.19;
  body.scale.set(1, 1.08, 0.86);
  upper.add(body);

  const arms = [-1, 1].map((side) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.19, 0.31, 0);
    pivot.rotation.z = side * 0.22; // hang slightly away from the body
    const arm = new THREE.Mesh(armGeo, skin);
    arm.position.y = -0.11;
    const hand = new THREE.Mesh(handGeo, skin);
    hand.position.y = -0.22;
    pivot.add(arm, hand);
    upper.add(pivot);
    return pivot;
  }) as [THREE.Group, THREE.Group];

  const head = new THREE.Mesh(headGeo, skin);
  head.position.y = 0.62;
  upper.add(head);
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.position.set(side * 0.09, 0.0, 0.235);
    eye.scale.set(1, 1.3, 0.6);
    const brow = new THREE.Mesh(browGeo, browMat);
    brow.position.set(side * 0.09, 0.085, 0.235);
    brow.rotation.z = Math.PI / 2 + side * -0.12;
    const ear = new THREE.Mesh(earGeo, skin);
    ear.position.set(side * 0.255, -0.01, 0);
    head.add(eye, brow, ear);
  }

  // Some passengers are bald; the rest have short hair in a few colours.
  let hair: THREE.Mesh | null = null;
  if (look % 5 !== 3) {
    const hairMat = lambert(HAIR[look % HAIR.length]!);
    hair = new THREE.Mesh(hairGeo, hairMat);
    hair.rotation.x = -0.32; // sits back on the head, forehead shows
    hair.position.y = 0.012;
    const back = new THREE.Mesh(hairBackGeo, hairMat);
    hair.add(back);
    head.add(hair);
  }

  let pack: THREE.Mesh | null = null;
  if (withPack) {
    const c = new THREE.Color(bodyColor).multiplyScalar(0.6);
    pack = new THREE.Mesh(packGeo, new THREE.MeshLambertMaterial({ color: c }));
    pack.position.set(0, 0.22, -0.2);
    pack.scale.set(1.1, 1, 0.6);
    upper.add(pack);
  }

  const shadow = new THREE.Mesh(shadowGeo, shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.012;
  root.add(shadow);

  return { root, upper, body, head, hair, pack, shadow, arms, legs, seated: false };
}

/** Seated pose: hips on the cushion, legs forward, hands on the knees. */
export function setSeated(f: Figure, seated: boolean): void {
  f.seated = seated;
  const hip = seated ? SEAT_HIP_Y : HIP_Y;
  f.upper.position.y = hip;
  for (const leg of f.legs) {
    leg.position.y = hip;
    if (seated) leg.rotation.x = -1.25;
  }
  for (const arm of f.arms) if (seated) arm.rotation.x = -0.55;
  if (f.pack) f.pack.visible = !seated && !f.pack.userData.covered;
  // Bags on the back come off while sitting (they would poke through the bench).
  f.upper.traverse((o) => {
    if (o.userData.onBack) o.visible = !seated;
  });
  f.shadow.visible = !seated;
}

/** Walking: legs and arms swing with the stride (0 = standing still). */
export function setStride(f: Figure, phase: number, amount: number): void {
  if (f.seated) return;
  const s = Math.sin(phase) * amount;
  f.legs[0].rotation.x = s * 0.75;
  f.legs[1].rotation.x = -s * 0.75;
  f.arms[0].rotation.x = -s * 0.6;
  f.arms[1].rotation.x = s * 0.6;
}

/** Hair colour (e.g. grey for the elderly passenger who wants a priority seat). */
export function setHair(f: Figure, color: string): void {
  if (f.hair) (f.hair.material as THREE.MeshLambertMaterial).color.set(color);
}

// ----------------------------------------------------------------- officer

const vestGeo = new THREE.SphereGeometry(0.21, 26, 16, 0, Math.PI * 2, Math.PI * 0.24, Math.PI * 0.58);
/** Reflective bands: thin slices of a slightly bigger shell. */
const bandGeo = new THREE.SphereGeometry(0.216, 26, 2, 0, Math.PI * 2, Math.PI * 0.6, Math.PI * 0.07);
const strapGeo = new THREE.SphereGeometry(0.216, 3, 12, 0, Math.PI * 0.075, Math.PI * 0.25, Math.PI * 0.36);
const capGeo = new THREE.CylinderGeometry(0.2, 0.235, 0.13, 24);
const capTopGeo = new THREE.SphereGeometry(0.2, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2);
const brimGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.02, 20, 1, false, -Math.PI / 2, Math.PI);
const badgeGeo = new THREE.CircleGeometry(0.03, 12);
const maskGeo = new THREE.SphereGeometry(0.262, 20, 8, Math.PI * 0.18, Math.PI * 0.64, Math.PI * 0.55, Math.PI * 0.22);

export const OFFICER = {
  shirt: '#cdb877', // khaki, a little yellow
  vest: '#ff6a13',
  stripe: '#f4f24a',
  cap: '#1a1c20',
  trousers: '#22262e',
  mask: '#f2f7ff',
  skin: '#e0ad84',
};

/**
 * A KRL station officer: khaki shirt, orange safety vest with yellow
 * reflective stripes, dark trousers, black cap with a small badge, and a mask.
 */
export function createOfficer(): Figure {
  const f = createFigure(OFFICER.shirt, OFFICER.skin, false, 3); // look 3 = no hair (the cap covers it)
  const lambert = (c: string) => new THREE.MeshLambertMaterial({ color: c });
  // Khaki sleeves, skin-coloured hands.
  const shirt = lambert(OFFICER.shirt);
  for (const arm of f.arms) (arm.children[0] as THREE.Mesh).material = shirt;
  const trousers = lambert(OFFICER.trousers);
  for (const leg of f.legs) (leg.children[0] as THREE.Mesh).material = trousers;

  const vest = new THREE.Mesh(vestGeo, lambert(OFFICER.vest));
  vest.position.copy(f.body.position);
  vest.scale.copy(f.body.scale);
  const stripe = new THREE.MeshBasicMaterial({ color: OFFICER.stripe }); // bright, like reflective tape
  const band = new THREE.Mesh(bandGeo, stripe);
  vest.add(band);
  const band2 = new THREE.Mesh(bandGeo, stripe);
  band2.rotation.x = 0; // a second band higher up
  band2.position.y = 0.055;
  band2.scale.setScalar(0.985);
  vest.add(band2);
  // Vertical stripes over the shoulders, front and back.
  for (const phi of [Math.PI * 0.32, Math.PI * 0.6, Math.PI * 1.32, Math.PI * 1.6]) {
    const strap = new THREE.Mesh(strapGeo, stripe);
    strap.rotation.y = -phi;
    vest.add(strap);
  }
  f.upper.add(vest);

  const capMat = lambert(OFFICER.cap);
  const cap = new THREE.Group();
  const crown = new THREE.Mesh(capGeo, capMat);
  const top = new THREE.Mesh(capTopGeo, capMat);
  top.scale.y = 0.35;
  top.position.y = 0.06;
  const brim = new THREE.Mesh(brimGeo, capMat);
  brim.position.set(0, -0.05, 0.17);
  brim.rotation.x = 0.12;
  const badge = new THREE.Mesh(badgeGeo, new THREE.MeshBasicMaterial({ color: '#e8c547' }));
  badge.position.set(0, 0.0, 0.226);
  badge.rotation.x = -0.15;
  cap.add(crown, top, brim, badge);
  cap.position.y = 0.2;
  cap.rotation.x = -0.08;
  f.head.add(cap);

  const mask = new THREE.Mesh(maskGeo, new THREE.MeshLambertMaterial({ color: OFFICER.mask, emissive: '#5a6b7d', emissiveIntensity: 0.35 }));
  mask.rotation.y = 0; // centred on the face (+z)
  f.head.add(mask);
  return f;
}

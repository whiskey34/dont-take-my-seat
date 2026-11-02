import * as THREE from 'three';

const bodyGeo = new THREE.CylinderGeometry(0.26, 0.31, 0.78, 9);
const headGeo = new THREE.IcosahedronGeometry(0.21, 1);
const packGeo = new THREE.BoxGeometry(0.34, 0.36, 0.16);
const shadowGeo = new THREE.CircleGeometry(0.36, 20);
const shadowMat = new THREE.MeshBasicMaterial({ color: '#1d2733', transparent: true, opacity: 0.22, depthWrite: false });

export interface Figure {
  root: THREE.Group;
  body: THREE.Mesh;
  head: THREE.Mesh;
  pack: THREE.Mesh | null;
  shadow: THREE.Mesh;
}

/** A low-poly passenger: a tapered body, a head and optionally a backpack. */
export function createFigure(bodyColor: string, skinColor: string, withPack: boolean): Figure {
  const root = new THREE.Group();
  const lambert = (c: string) => new THREE.MeshLambertMaterial({ color: c, flatShading: true });

  const body = new THREE.Mesh(bodyGeo, lambert(bodyColor));
  body.position.y = 0.41;
  const head = new THREE.Mesh(headGeo, lambert(skinColor));
  head.position.y = 0.98;
  root.add(body, head);

  let pack: THREE.Mesh | null = null;
  if (withPack) {
    const c = new THREE.Color(bodyColor).multiplyScalar(0.6);
    pack = new THREE.Mesh(packGeo, new THREE.MeshLambertMaterial({ color: c, flatShading: true }));
    pack.position.set(0, 0.52, -0.3);
    root.add(pack);
  }

  const shadow = new THREE.Mesh(shadowGeo, shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.012;
  root.add(shadow);

  return { root, body, head, pack, shadow };
}

/** Seated pose: body sinks onto the bench. */
export function setSeated(f: Figure, seated: boolean): void {
  f.body.scale.y = seated ? 0.72 : 1;
  f.body.position.y = seated ? 0.69 : 0.41;
  f.head.position.y = seated ? 1.14 : 0.98;
  if (f.pack) f.pack.visible = !seated;
  f.shadow.visible = !seated;
}

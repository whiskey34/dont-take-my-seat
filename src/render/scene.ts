import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../core/config';
import { BENCH_SEGMENTS, createSeats, POLES, seatSitPos } from '../core/layout';
import { trainAccel } from '../core/game';
import type { GameEvent, GameState, Seat } from '../core/types';
import { createFigure, setSeated, type Figure } from './figure';
import { PLAYER_COLORS, SCENE } from './palette';

const { car } = CONFIG;
const HALF_X = car.halfLength + 0.6; // outer end walls
const WALL_Z = 2.3;
const WALL_H = 2.2;

const npcSkin = (id: number): string => SCENE.npcSkins[(id * 3) % SCENE.npcSkins.length]!;

interface NpcAnim {
  fig: Figure;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
}

interface PlayerView {
  fig: Figure;
  ring: THREE.Mesh | null;
  visible: number; // 0..1 fade
}

/** Owns everything Three.js. Reads game state; never changes it. */
export class TrainScene {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 2, 0.1, 200);
  private readonly camTarget = new THREE.Vector3(0, 0.3, 0.75);
  private readonly cushions: THREE.Mesh[] = [];
  private readonly seatInfo: Seat[] = [];
  private readonly npcs: Figure[] = [];
  private readonly npcAnims: NpcAnim[] = [];
  private readonly markers: THREE.Mesh[] = [];
  private readonly doors: THREE.Mesh[][] = [];
  private readonly players = new Map<string, PlayerView>();
  private readonly pulses: Array<{ mesh: THREE.Mesh; t: number }> = [];
  private backdrop!: THREE.Texture;
  private trainSpeed = 0;
  private doorOpen = 0;
  private clock = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene.background = new THREE.Color(SCENE.sky);
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#a8a39b', 2.4));
    const sun = new THREE.DirectionalLight('#fff6e8', 1.6);
    sun.position.set(4, 10, 7);
    this.scene.add(sun);
    this.buildCar();
    this.buildSeats();
    this.buildBackdrop();
  }

  // ------------------------------------------------------------ building

  private buildCar(): void {
    const statics: Record<string, THREE.BufferGeometry[]> = {};
    const add = (color: string, geo: THREE.BufferGeometry, x: number, y: number, z: number) => {
      geo.translate(x, y, z);
      (statics[color] ??= []).push(geo);
    };

    // Floor with door strips.
    add(SCENE.floor, new THREE.BoxGeometry(HALF_X * 2, 0.1, WALL_Z * 2), 0, -0.05, 0);
    for (const dx of car.doorsX) {
      for (const side of [-1, 1]) add(SCENE.doorStrip, new THREE.BoxGeometry(car.doorHalfWidth * 2 - 0.3, 0.012, 0.35), dx, 0.006, side * (WALL_Z - 0.2));
    }
    add(SCENE.floorLine, new THREE.BoxGeometry(HALF_X * 2, 0.01, 0.06), 0, 0.005, 0);

    // Far wall (-z): tall, with window band. Near wall (+z): cut away low.
    const doorEdges = car.doorsX.flatMap((d) => [d - car.doorHalfWidth, d + car.doorHalfWidth]);
    const spans: Array<[number, number]> = [];
    const edges = [-HALF_X, ...doorEdges, HALF_X];
    for (let i = 0; i < edges.length; i += 2) spans.push([edges[i]!, edges[i + 1]!]);
    for (const [a, b] of spans) {
      const w = b - a;
      const cx = (a + b) / 2;
      add(SCENE.wall, new THREE.BoxGeometry(w, 0.95, 0.12), cx, 0.475, -WALL_Z);
      add(SCENE.wall, new THREE.BoxGeometry(w, 0.35, 0.12), cx, WALL_H - 0.175, -WALL_Z);
      add(SCENE.wallTrim, new THREE.BoxGeometry(w, 0.05, 0.14), cx, 0.95, -WALL_Z);
      // window piers
      const panes = Math.max(1, Math.round(w / 2.6));
      for (let i = 0; i <= panes; i++) add(SCENE.wall, new THREE.BoxGeometry(0.16, 0.9, 0.12), a + (w * i) / panes, 1.4, -WALL_Z);
      add(SCENE.wall, new THREE.BoxGeometry(w, 0.32, 0.12), cx, 0.16, WALL_Z);
      add(SCENE.wallTrim, new THREE.BoxGeometry(w, 0.04, 0.14), cx, 0.32, WALL_Z);
    }
    // Door frames above the far doors.
    for (const dx of car.doorsX) add(SCENE.wallTrim, new THREE.BoxGeometry(car.doorHalfWidth * 2, 0.35, 0.14), dx, WALL_H - 0.175, -WALL_Z);
    // End walls.
    for (const sx of [-1, 1]) add(SCENE.wall, new THREE.BoxGeometry(0.14, WALL_H, WALL_Z * 2), sx * HALF_X, WALL_H / 2, 0);

    // Benches and backrests.
    for (const [a, b] of BENCH_SEGMENTS) {
      for (const side of [-1, 1]) {
        add(SCENE.bench, new THREE.BoxGeometry(b - a, 0.4, 0.62), (a + b) / 2, 0.2, side * 1.9);
        if (side < 0) add(SCENE.seat, new THREE.BoxGeometry(b - a, 0.5, 0.1), (a + b) / 2, 0.82, side * 2.18);
      }
    }

    // Poles.
    for (const p of POLES) add(SCENE.pole, new THREE.CylinderGeometry(car.poleRadius, car.poleRadius, WALL_H, 8), p.x, WALL_H / 2, p.z);

    for (const [color, geos] of Object.entries(statics)) {
      const merged = mergeGeometries(geos);
      if (!merged) continue;
      this.scene.add(new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ color, flatShading: true })));
      geos.forEach((g) => g.dispose());
    }

    // Sliding doors on the far wall.
    const doorGeo = new THREE.BoxGeometry(car.doorHalfWidth, WALL_H - 0.4, 0.08);
    const doorMat = new THREE.MeshLambertMaterial({ color: SCENE.door });
    const glassGeo = new THREE.BoxGeometry(car.doorHalfWidth * 0.6, 0.8, 0.1);
    const glassMat = new THREE.MeshLambertMaterial({ color: SCENE.doorGlass });
    for (const dx of car.doorsX) {
      const pair: THREE.Mesh[] = [];
      for (const s of [-1, 1]) {
        const leaf = new THREE.Mesh(doorGeo, doorMat);
        const glass = new THREE.Mesh(glassGeo, glassMat);
        glass.position.y = 0.35;
        leaf.add(glass);
        leaf.position.set(dx + (s * car.doorHalfWidth) / 2, (WALL_H - 0.4) / 2, -WALL_Z);
        leaf.userData.baseX = leaf.position.x;
        leaf.userData.dir = s;
        this.scene.add(leaf);
        pair.push(leaf);
      }
      this.doors.push(pair);
    }
  }

  private buildSeats(): void {
    const cushionGeo = new THREE.BoxGeometry(car.seatWidth - 0.08, 0.12, 0.56);
    const markerGeo = new THREE.ConeGeometry(0.24, 0.42, 4);
    markerGeo.rotateX(Math.PI);
    const markerMat = new THREE.MeshBasicMaterial({ color: SCENE.freeMarker });
    for (const seat of createSeats()) {
      const { id, x, side } = seat;
      const cushion = new THREE.Mesh(cushionGeo, new THREE.MeshLambertMaterial({ color: seat.priority ? SCENE.prioritySeat : SCENE.seat }));
      cushion.position.set(x, 0.46, side * 1.88);
      this.scene.add(cushion);
      this.cushions[id] = cushion;
      this.seatInfo[id] = seat;

      const fig = createFigure(SCENE.npcBodies[id % SCENE.npcBodies.length]!, npcSkin(id), false);
      this.scene.add(fig.root);
      this.npcs[id] = fig;

      const marker = new THREE.Mesh(markerGeo, markerMat);
      marker.position.set(x, 1.35, side * 1.6);
      marker.visible = false;
      this.scene.add(marker);
      this.markers[id] = marker;
    }
    this.resetNpcs();
  }

  private buildBackdrop(): void {
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 256;
    const g = c.getContext('2d');
    if (g) {
      g.fillStyle = SCENE.backdropSky;
      g.fillRect(0, 0, c.width, c.height);
      let x = 0;
      let i = 0;
      while (x < c.width) {
        const w = 40 + ((i * 37) % 70);
        const h = 60 + ((i * 53) % 150);
        g.fillStyle = SCENE.backdropCity[i % SCENE.backdropCity.length]!;
        g.fillRect(x, c.height - h, w, h);
        x += w + ((i * 11) % 18);
        i++;
      }
      g.fillStyle = '#7f949f';
      g.fillRect(0, c.height - 24, c.width, 24);
    }
    this.backdrop = new THREE.CanvasTexture(c);
    this.backdrop.colorSpace = THREE.SRGBColorSpace;
    this.backdrop.wrapS = THREE.RepeatWrapping;
    this.backdrop.repeat.set(3, 1);
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(HALF_X * 2 + 8, 3.2), new THREE.MeshBasicMaterial({ map: this.backdrop }));
    plane.position.set(0, 1.35, -WALL_Z - 1.2);
    this.scene.add(plane);
  }

  // ------------------------------------------------------------ players

  setPlayers(state: GameState, humanId: string | null): void {
    for (const v of this.players.values()) this.scene.remove(v.fig.root);
    this.players.clear();
    for (const p of state.players) {
      const fig = createFigure(PLAYER_COLORS[p.colorIndex % PLAYER_COLORS.length]!, '#f0c9a4', true);
      let ring: THREE.Mesh | null = null;
      if (p.id === humanId) {
        ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.52, 28), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, depthWrite: false }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.02;
        fig.root.add(ring);
      }
      fig.root.position.set(p.pos.x, 0, p.pos.z);
      fig.root.rotation.order = 'YXZ'; // lean follows the facing direction
      this.scene.add(fig.root);
      this.players.set(p.id, { fig, ring, visible: 1 });
    }
  }

  // ------------------------------------------------------------ per frame

  handleEvents(state: GameState, events: readonly GameEvent[]): void {
    for (const e of events) {
      if (e.type === 'phase' && e.phase === 'riding') this.resetNpcs();
      if (e.type === 'doorsOpen') for (const id of e.seatIds) this.npcLeaves(state.seats[id]);
      if (e.type === 'kicked') {
        const fig = this.npcs[e.seatId];
        if (fig) {
          fig.root.visible = true;
          fig.root.scale.setScalar(1);
          (fig.head.material as THREE.MeshLambertMaterial).color.set(SCENE.elderHair);
        }
      }
      if (e.type === 'pushed') {
        const target = state.players.find((p) => p.id === e.target);
        if (target) this.pulse(target.pos.x, target.pos.z, '#ffffff');
      }
      if (e.type === 'sat') {
        const p = state.players.find((q) => q.id === e.playerId);
        if (p) this.pulse(p.pos.x, p.pos.z, SCENE.freeMarker);
      }
    }
  }

  private resetNpcs(): void {
    this.npcAnims.length = 0;
    this.npcs.forEach((fig, id) => {
      const seat = this.seatInfo[id]!;
      const sit = seatSitPos(seat);
      fig.root.visible = true;
      fig.root.scale.setScalar(1);
      fig.root.position.set(sit.x, 0, sit.z);
      fig.root.rotation.y = seat.side > 0 ? Math.PI : 0;
      (fig.head.material as THREE.MeshLambertMaterial).color.set(npcSkin(id));
      setSeated(fig, true);
    });
  }

  private npcLeaves(seat: Seat | undefined): void {
    if (!seat) return;
    const fig = this.npcs[seat.id];
    if (!fig) return;
    setSeated(fig, false);
    const door = car.doorsX.reduce((best, d) => (Math.abs(d - seat.x) < Math.abs(best - seat.x) ? d : best), car.doorsX[0]);
    const from = fig.root.position.clone();
    from.z = seat.side * 1.35;
    this.npcAnims.push({ fig, from, to: new THREE.Vector3(door, 0, -WALL_Z - 0.2), t: 0 });
  }

  private pulse(x: number, z: number, color: string): void {
    const mesh = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.4, 24), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.05, z);
    this.scene.add(mesh);
    this.pulses.push({ mesh, t: 0 });
  }

  render(state: GameState, dt: number): void {
    this.clock += dt;
    // Positions arrive already smoothed by the session; only turning is eased here.
    const turn = 1 - Math.exp(-14 * dt);

    // Players.
    for (const p of state.players) {
      const v = this.players.get(p.id);
      if (!v) continue;
      const r = v.fig.root;
      v.visible += ((p.eliminated ? 0 : 1) - v.visible) * Math.min(1, dt * 4);
      r.visible = v.visible > 0.02;
      r.scale.setScalar((0.6 + 0.4 * v.visible) * 1.18);
      const speed = p.seatId === null ? Math.hypot(p.vel.x, p.vel.z) : 0;
      const stride = Math.min(1, speed / CONFIG.player.speed);
      r.position.set(p.pos.x, Math.abs(Math.sin(this.clock * 13)) * 0.05 * stride, p.pos.z);
      r.rotation.x = 0.12 * stride;
      let dy = p.facing - r.rotation.y;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      r.rotation.y += dy * turn;
      setSeated(v.fig, p.seatId !== null);
      const stunned = state.time < p.stunnedUntil;
      r.rotation.z = stunned ? Math.sin(this.clock * 40) * 0.15 : 0;
      if (v.ring) v.ring.visible = p.seatId === null;
    }

    // Free seats glow while they are free.
    const scramble = state.phase === 'scramble';
    state.seats.forEach((seat, id) => {
      const free = scramble && !seat.npc && seat.playerId === null;
      const marker = this.markers[id];
      if (marker) {
        marker.visible = free;
        marker.position.y = 1.55 + Math.sin(this.clock * 6 + id) * 0.08;
        marker.rotation.y += dt * 2;
      }
      const mat = this.cushions[id]?.material as THREE.MeshLambertMaterial | undefined;
      mat?.emissive.set(free ? SCENE.freeMarker : '#000000').multiplyScalar(free ? 0.35 + 0.25 * Math.sin(this.clock * 8) : 0);
      const npc = this.npcs[id];
      if (npc && seat.playerId !== null) npc.root.visible = false;
    });

    // NPCs walking out.
    for (let i = this.npcAnims.length - 1; i >= 0; i--) {
      const a = this.npcAnims[i]!;
      a.t += dt / 0.9;
      const t = Math.min(1, a.t);
      a.fig.root.position.lerpVectors(a.from, a.to, t);
      a.fig.root.rotation.y = Math.atan2(a.to.x - a.from.x, a.to.z - a.from.z);
      a.fig.root.scale.setScalar(t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1);
      if (t >= 1) {
        a.fig.root.visible = false;
        this.npcAnims.splice(i, 1);
      }
    }

    // Doors slide open at the station.
    const open = state.phase === 'scramble' ? 1 : 0;
    this.doorOpen += (open - this.doorOpen) * Math.min(1, dt * 6);
    for (const pair of this.doors) for (const leaf of pair) leaf.position.x = leaf.userData.baseX + leaf.userData.dir * this.doorOpen * (car.doorHalfWidth - 0.1);

    // Scenery moves while the train runs, slows when braking.
    const accel = trainAccel(state);
    const targetSpeed = state.phase === 'riding' ? (accel.x > 0 ? 0.15 : 1) : state.phase === 'intro' ? 0.6 : 0;
    this.trainSpeed += (targetSpeed - this.trainSpeed) * Math.min(1, dt * 2);
    this.backdrop.offset.x += this.trainSpeed * dt * 0.9;

    // Pulses.
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const p = this.pulses[i]!;
      p.t += dt / 0.45;
      p.mesh.scale.setScalar(1 + p.t * 2);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - p.t);
      if (p.t >= 1) {
        this.scene.remove(p.mesh);
        p.mesh.geometry.dispose();
        (p.mesh.material as THREE.Material).dispose();
        this.pulses.splice(i, 1);
      }
    }

    // Camera rolls a little with the sway.
    this.camera.rotation.z = (-accel.z / CONFIG.sway.amp) * 0.006;
    this.renderer.render(this.scene, this.camera);
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    const aspect = width / Math.max(1, height);
    this.camera.aspect = aspect;
    // Fit the whole car horizontally, looking down at ~56 degrees.
    const halfW = HALF_X + 0.9;
    const vHalf = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const hHalf = Math.atan(Math.tan(vHalf) * aspect);
    const fitW = halfW / Math.tan(hHalf);
    const fitH = 4.6 / Math.tan(vHalf); // keep the car depth on screen on squarer screens
    const dist = Math.max(fitW, fitH);
    const angle = THREE.MathUtils.degToRad(52);
    this.camera.position.set(0, this.camTarget.y + Math.sin(angle) * dist, this.camTarget.z + Math.cos(angle) * dist);
    this.camera.lookAt(this.camTarget);
    this.camera.updateProjectionMatrix();
  }

  /** Screen position (CSS px) of a point above a player's head, or null. */
  labelPos(state: GameState, playerId: string, width: number, height: number): { x: number; y: number } | null {
    const v = this.players.get(playerId);
    const p = state.players.find((q) => q.id === playerId);
    if (!v || !p || !v.fig.root.visible) return null;
    const head = new THREE.Vector3(v.fig.root.position.x, p.seatId !== null ? 1.5 : 1.38, v.fig.root.position.z).project(this.camera);
    return { x: ((head.x + 1) / 2) * width, y: ((1 - head.y) / 2) * height };
  }
}

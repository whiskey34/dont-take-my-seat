import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../core/config';
import { BENCH_SEGMENTS, createSeats, POLES, seatSitPos } from '../core/layout';
import { trainAccel } from '../core/game';
import type { GameEvent, GameState, PowerUpKind, Seat } from '../core/types';
import { createFigure, setHair, setSeated, setStride, type Figure } from './figure';
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
  shield: THREE.Mesh;
  visible: number; // 0..1 fade
  kick: { at: number; dir: THREE.Vector3 } | null; // kicking someone
  flight: { at: number; from: THREE.Vector3; until: number } | null; // kicked off a seat
}

/** Seat-kick animation timings (seconds, render clock). */
const KICK_POSE = 0.42;
const KICK_FLIGHT = 0.38;


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
  /** Red impact flashes from seat kicks. */
  private kickGlow: THREE.Texture | null = null;
  private readonly bursts: Array<{ obj: THREE.Object3D; t: number; vel?: THREE.Vector3; spin?: number; life: number }> = [];
  private backdrop!: THREE.Texture;
  private readonly standers = new Map<number, Figure>();
  private readonly items = new Map<number, THREE.Group>();
  private readonly puddles = new THREE.Group();
  private puddleKey = '';
  private readonly doorGlow: Array<{ mesh: THREE.Mesh; side: 1 | -1 }> = [];
  private readonly camBase = new THREE.Vector3();
  private shake = 0;
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
    this.buildDoorGlow();
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

      const fig = createFigure(SCENE.npcBodies[id % SCENE.npcBodies.length]!, npcSkin(id), false, id * 7 + 1);
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

  /** Bright strips that mark which side's doors are open. */
  private buildDoorGlow(): void {
    const geo = new THREE.PlaneGeometry(car.doorHalfWidth * 2 - 0.2, 0.8);
    for (const dx of car.doorsX) {
      for (const side of [-1, 1] as const) {
        const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: '#fff7c2', transparent: true, opacity: 0, depthWrite: false }));
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(dx, 0.015, side * (WALL_Z - 0.3));
        this.scene.add(mesh);
        this.doorGlow.push({ mesh, side });
      }
    }
  }

  private makeItem(kind: PowerUpKind): THREE.Group {
    const g = new THREE.Group();
    const mat = (c: string) => new THREE.MeshLambertMaterial({ color: c, emissive: c, emissiveIntensity: 0.35, flatShading: true });
    if (kind === 'earphones') {
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.035, 6, 16, Math.PI), mat(SCENE.earphones));
      band.position.y = 0.05;
      const cupGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.07, 12);
      for (const sx of [-1, 1]) {
        const cup = new THREE.Mesh(cupGeo, mat(SCENE.earphones));
        cup.rotation.z = Math.PI / 2;
        cup.position.set(sx * 0.17, 0.03, 0);
        g.add(cup);
      }
      g.add(band);
    } else if (kind === 'coffee') {
      // Iced coffee in a clear plastic cup: milky coffee, a dark layer at the
      // bottom and ice cubes floating on top.
      const h = 0.3;
      const cup = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.09, h, 18, 1, true),
        new THREE.MeshLambertMaterial({ color: '#ffffff', transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }),
      );
      cup.position.y = h / 2;
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.008, 6, 24), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
      rim.rotation.x = Math.PI / 2;
      rim.position.y = h;
      const dark = new THREE.Mesh(new THREE.CylinderGeometry(0.093, 0.088, 0.05, 18), mat(SCENE.coffeeDark));
      dark.position.y = 0.028;
      const milk = new THREE.Mesh(new THREE.CylinderGeometry(0.113, 0.094, 0.2, 18), mat(SCENE.coffee));
      milk.position.y = 0.153;
      g.add(dark, milk);
      const iceMat = new THREE.MeshLambertMaterial({ color: SCENE.ice, transparent: true, opacity: 0.85, flatShading: true });
      [[-0.04, 0.03, 0.3], [0.045, -0.02, -0.4], [0.0, -0.05, 0.9]].forEach(([x, z, r]) => {
        const cube = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.06), iceMat);
        cube.position.set(x!, 0.255, z!);
        cube.rotation.set(r!, r! * 2, r! * 0.5);
        g.add(cube);
      });
      g.add(cup, rim);
    } else {
      const pillow = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.12, 0.26), mat(SCENE.pillow));
      const moon = new THREE.Mesh(new THREE.IcosahedronGeometry(0.07, 1), mat('#fde68a'));
      moon.position.set(0.12, 0.16, 0);
      g.add(pillow, moon);
    }
    const glow = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.32, 24), new THREE.MeshBasicMaterial({ color: kind === 'earphones' ? SCENE.earphones : kind === 'coffee' ? SCENE.coffee : SCENE.pillow, transparent: true, opacity: 0.6, depthWrite: false }));
    glow.rotation.x = -Math.PI / 2;
    glow.userData.floor = true;
    g.add(glow);
    g.scale.setScalar(kind === 'coffee' ? 2.2 : 1.8);
    return g;
  }

  // ------------------------------------------------------------ players

  setPlayers(state: GameState, humanId: string | null): void {
    for (const v of this.players.values()) this.scene.remove(v.fig.root);
    this.players.clear();
    for (const p of state.players) {
      const fig = createFigure(PLAYER_COLORS[p.colorIndex % PLAYER_COLORS.length]!, '#f0c9a4', true, p.colorIndex * 2);
      let ring: THREE.Mesh | null = null;
      if (p.id === humanId) {
        ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.52, 28), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, depthWrite: false }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.02;
        fig.root.add(ring);
      }
      const shield = new THREE.Mesh(
        new THREE.TorusGeometry(0.42, 0.03, 6, 28),
        new THREE.MeshBasicMaterial({ color: SCENE.earphones, transparent: true, opacity: 0.8, depthWrite: false }),
      );
      shield.rotation.x = Math.PI / 2;
      shield.position.y = 0.62;
      shield.visible = false;
      fig.root.add(shield);
      fig.root.position.set(p.pos.x, 0, p.pos.z);
      fig.root.rotation.order = 'YXZ'; // lean follows the facing direction
      this.scene.add(fig.root);
      this.players.set(p.id, { fig, ring, shield, visible: 1, kick: null, flight: null });
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
          setHair(fig, SCENE.elderHair);
        }
      }
      if (e.type === 'pushed') {
        const target = state.players.find((p) => p.id === e.target);
        if (target) this.pulse(target.pos.x, target.pos.z, '#ffffff');
      }
      if (e.type === 'slipped') {
        const who = state.players.find((p) => p.id === e.playerId);
        if (who) this.pulse(who.pos.x, who.pos.z, SCENE.puddle);
      }
      if (e.type === 'seatKick') this.seatKick(state, e.by, e.target, e.seatId);
      if (e.type === 'sat') {
        const p = state.players.find((q) => q.id === e.playerId);
        if (p) this.pulse(p.pos.x, p.pos.z, SCENE.freeMarker);
      }
      if (e.type === 'suddenBrake') this.shake = 0.6;
      if (e.type === 'powerUp' || e.type === 'shielded') {
        const p = state.players.find((q) => q.id === e.playerId);
        if (p) this.pulse(p.pos.x, p.pos.z, SCENE.earphones);
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

  /**
   * Seat kick: the kicker swings a leg at the seat, a red flash pops where it
   * lands, and the victim is knocked out of the seat into the aisle.
   */
  private seatKick(state: GameState, by: string, target: string, seatId: number): void {
    const seat = state.seats[seatId];
    const kicker = this.players.get(by);
    const victim = this.players.get(target);
    if (!seat) return;
    const sit = seatSitPos(seat);
    const at = new THREE.Vector3(sit.x, 0.7, sit.z - seat.side * 0.3);
    if (kicker) {
      const dir = at.clone().sub(kicker.fig.root.position).setY(0);
      kicker.kick = { at: this.clock, dir: dir.lengthSq() > 0 ? dir.normalize() : new THREE.Vector3(0, 0, seat.side) };
    }
    if (victim) {
      victim.flight = { at: this.clock, from: new THREE.Vector3(sit.x, 0.2, sit.z), until: this.clock + KICK_FLIGHT };
      victim.fig.root.position.set(sit.x, 0.2, sit.z);
    }
    this.burst(at);
    this.pulse(sit.x, sit.z - seat.side * 0.4, SCENE.kick);
    this.shake = Math.max(this.shake, 0.3);
  }

  /** A soft red glow that pops and fades behind the hit. */
  private burst(at: THREE.Vector3): void {
    if (!this.kickGlow) {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const g = c.getContext('2d');
      if (g) {
        const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
        grad.addColorStop(0, 'rgba(255,90,78,0.95)');
        grad.addColorStop(0.45, 'rgba(255,60,50,0.55)');
        grad.addColorStop(1, 'rgba(255,40,40,0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, 128, 128);
      }
      this.kickGlow = new THREE.CanvasTexture(c);
      this.kickGlow.colorSpace = THREE.SRGBColorSpace;
    }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.kickGlow, transparent: true, depthWrite: false, blending: THREE.NormalBlending }));
    sprite.position.copy(at);
    sprite.renderOrder = 5;
    this.scene.add(sprite);
    this.bursts.push({ obj: sprite, t: 0, life: 0.4 });
  }

  private updateBursts(dt: number): void {
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i]!;
      b.t += dt;
      const u = b.t / b.life;
      if (b.vel) {
        b.vel.y -= 9 * dt;
        b.obj.position.addScaledVector(b.vel, dt);
        b.obj.rotation.x += (b.spin ?? 0) * dt;
        b.obj.rotation.y += (b.spin ?? 0) * dt;
        b.obj.scale.setScalar(Math.max(0.01, 1 - u));
      } else {
        // Pops out fast, then fades.
        const size = 0.6 + 1.6 * Math.min(1, u / 0.3);
        b.obj.scale.set(size, size, 1);
        ((b.obj as THREE.Sprite).material as THREE.SpriteMaterial).opacity = u < 0.35 ? 1 : 1 - (u - 0.35) / 0.65;
      }
      if (u >= 1) {
        this.scene.remove(b.obj);
        if (b.obj instanceof THREE.Mesh) b.obj.geometry.dispose();
        if (b.obj instanceof THREE.Sprite) b.obj.material.dispose();
        this.bursts.splice(i, 1);
      }
    }
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
      r.rotation.x = 0.08 * stride;
      setStride(v.fig, this.clock * 13, stride);
      let dy = p.facing - r.rotation.y;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      r.rotation.y += dy * turn;
      setSeated(v.fig, p.seatId !== null);
      const stunned = state.time < p.stunnedUntil;
      r.rotation.z = stunned ? Math.sin(this.clock * 40) * 0.15 : 0;
      this.animateKick(v, p);
      if (v.ring) v.ring.visible = p.seatId === null;
      v.shield.visible = state.time < p.shieldUntil && !p.eliminated;
      if (v.shield.visible) v.shield.rotation.z += dt * 3;
    }

    this.updateBursts(dt);
    this.syncStanders(state, dt);
    this.syncItems(state);
    this.syncPuddles(state);

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
      if (npc && !this.npcAnims.some((a) => a.fig === npc)) {
        // Match the state even if we missed the events (e.g. joined mid-game):
        // a seated NPC shows only where the seat is still taken by one.
        const shouldShow = seat.npc && seat.playerId === null;
        if (shouldShow && !npc.root.visible) {
          const sit = seatSitPos(seat);
          npc.root.position.set(sit.x, 0, sit.z);
          npc.root.rotation.y = seat.side > 0 ? Math.PI : 0;
          npc.root.scale.setScalar(1);
          setSeated(npc, true);
        }
        npc.root.visible = shouldShow;
      }
    });

    // NPCs walking out.
    for (let i = this.npcAnims.length - 1; i >= 0; i--) {
      const a = this.npcAnims[i]!;
      a.t += dt / 0.9;
      const t = Math.min(1, a.t);
      a.fig.root.position.lerpVectors(a.from, a.to, t);
      setStride(a.fig, this.clock * 12, 1);
      a.fig.root.rotation.y = Math.atan2(a.to.x - a.from.x, a.to.z - a.from.z);
      a.fig.root.scale.setScalar(t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1);
      if (t >= 1) {
        a.fig.root.visible = false;
        this.npcAnims.splice(i, 1);
      }
    }

    // Doors slide open at the station.
    // The modelled doors are on the far wall (side -1); the near wall is cut away.
    const open = state.phase === 'scramble' && state.doorSide !== 1 ? 1 : 0;
    this.doorOpen += (open - this.doorOpen) * Math.min(1, dt * 6);
    for (const g of this.doorGlow) {
      const lit = state.phase === 'scramble' && (state.doorSide === 0 || state.doorSide === g.side);
      const mat = g.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity += ((lit ? 0.75 + 0.25 * Math.sin(this.clock * 7) : 0) - mat.opacity) * Math.min(1, dt * 8);
    }
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
    this.shake = Math.max(0, this.shake - dt);
    const jolt = this.shake * 0.25;
    this.camera.position.set(this.camBase.x + Math.sin(this.clock * 55) * jolt, this.camBase.y + Math.sin(this.clock * 43) * jolt * 0.5, this.camBase.z);
    this.renderer.render(this.scene, this.camera);
  }

  /** Standing passengers: create, move and remove figures to match the state. */
  private syncStanders(state: GameState, dt: number): void {
    const k = 1 - Math.exp(-12 * dt);
    const seen = new Set<number>();
    for (const st of state.standers) {
      seen.add(st.id);
      let fig = this.standers.get(st.id);
      if (!fig) {
        fig = createFigure(SCENE.npcBodies[st.id % SCENE.npcBodies.length]!, npcSkin(st.id + 3), st.id % 2 === 0, st.id * 3 + 2);
        fig.root.position.set(st.pos.x, 0, st.pos.z);
        this.scene.add(fig.root);
        this.standers.set(st.id, fig);
      }
      const r = fig.root;
      const dx = st.pos.x - r.position.x;
      const dz = st.pos.z - r.position.z;
      if (Math.hypot(dx, dz) > 0.002) r.rotation.y = Math.atan2(dx, dz);
      r.position.x += dx * k;
      r.position.z += dz * k;
      setStride(fig, this.clock * 11 + st.id, Math.min(1, (Math.hypot(dx, dz) * k) / (dt * 1.2 || 1)));
    }
    for (const [id, fig] of this.standers) {
      if (seen.has(id)) continue;
      this.scene.remove(fig.root);
      this.standers.delete(id);
    }
  }

  /** Wet floor: flat glossy patches, rebuilt when the puddles change. */
  private syncPuddles(state: GameState): void {
    const key = state.puddles.map((d) => `${d.x},${d.z},${d.r}`).join(';');
    if (key === this.puddleKey) return;
    this.puddleKey = key;
    if (!this.puddles.parent) this.scene.add(this.puddles);
    for (const c of [...this.puddles.children]) {
      this.puddles.remove(c);
      if (c instanceof THREE.Mesh) c.geometry.dispose();
    }
    const water = new THREE.MeshLambertMaterial({ color: SCENE.puddle, transparent: true, opacity: 0.7 });
    const shine = new THREE.MeshBasicMaterial({ color: SCENE.puddleShine, transparent: true, opacity: 0.55 });
    state.puddles.forEach((d, i) => {
      // Slightly irregular: an ellipse plus a smaller blob, and a highlight.
      const main = new THREE.Mesh(new THREE.CircleGeometry(d.r, 28), water);
      main.rotation.x = -Math.PI / 2;
      main.scale.set(1.1, 0.9, 1);
      main.position.set(d.x, 0.012, d.z);
      const blob = new THREE.Mesh(new THREE.CircleGeometry(d.r * 0.45, 20), water);
      blob.rotation.x = -Math.PI / 2;
      blob.position.set(d.x + (i % 2 ? -1 : 1) * d.r * 0.6, 0.013, d.z + d.r * 0.3);
      const hi = new THREE.Mesh(new THREE.CircleGeometry(d.r * 0.22, 12), shine);
      hi.rotation.x = -Math.PI / 2;
      hi.scale.set(1.8, 0.5, 1);
      hi.position.set(d.x - d.r * 0.35, 0.014, d.z - d.r * 0.25);
      this.puddles.add(main, blob, hi);
    });
  }

  private syncItems(state: GameState): void {
    const seen = new Set<number>();
    for (const u of state.powerUps) {
      seen.add(u.id);
      let g = this.items.get(u.id);
      if (!g) {
        g = this.makeItem(u.kind);
        this.scene.add(g);
        this.items.set(u.id, g);
      }
      g.position.set(u.pos.x, 0.45 + Math.sin(this.clock * 3 + u.id) * 0.1, u.pos.z);
      g.rotation.y = this.clock * 1.8;
      for (const c of g.children) if (c.userData.floor) c.position.y = (-g.position.y + 0.02) / g.scale.y;
    }
    for (const [id, g] of this.items) {
      if (seen.has(id)) continue;
      this.scene.remove(g);
      this.items.delete(id);
    }
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
    this.camBase.copy(this.camera.position);
    this.camera.updateProjectionMatrix();
  }

  /** Kicker swings the right leg; the victim hops out of the seat. */
  private animateKick(v: PlayerView, p: GameState['players'][number]): void {
    const r = v.fig.root;
    if (v.kick) {
      const u = (this.clock - v.kick.at) / KICK_POSE;
      if (u >= 1) v.kick = null;
      else {
        // Quick wind-up back, then a big swing forward and up.
        const swing = u < 0.25 ? -0.5 * (u / 0.25) : -0.5 + 2.2 * Math.sin(((u - 0.25) / 0.75) * Math.PI);
        r.position.addScaledVector(v.kick.dir, 0.18 * Math.max(0, Math.sin(Math.PI * u)));
        r.rotation.x = -0.25 * Math.max(0, swing / 1.7); // lean back as the leg goes up
        r.rotation.y += 0.7 * Math.sin(Math.PI * u); // turn side-on so the kick reads from the camera
        v.fig.legs[1].rotation.x = -Math.max(-0.5, swing);
        v.fig.legs[0].rotation.x = 0.15;
        v.fig.arms[0].rotation.x = -0.6 * Math.max(0, swing / 1.7);
        v.fig.arms[1].rotation.x = 0.5 * Math.max(0, swing / 1.7);
      }
    }
    if (v.flight) {
      const u = (this.clock - v.flight.at) / KICK_FLIGHT;
      if (u >= 1) v.flight = null;
      else {
        const to = new THREE.Vector3(p.pos.x, 0, p.pos.z);
        r.position.lerpVectors(v.flight.from, to, 1 - (1 - u) * (1 - u));
        r.position.y = v.flight.from.y * (1 - u) + Math.sin(Math.PI * u) * 0.35;
        setSeated(v.fig, false);
        setStride(v.fig, 0, 0);
        v.fig.arms[0].rotation.x = v.fig.arms[1].rotation.x = -1.4 * Math.sin(Math.PI * u); // arms flung up
      }
    }
  }

  /** Screen position (CSS px) of a point in the car. */
  project(x: number, y: number, z: number, width: number, height: number): { x: number; y: number } {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return { x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height };
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

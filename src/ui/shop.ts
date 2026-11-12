import * as THREE from 'three';
import { ITEM_KINDS, type ItemKind, type Look } from '../core/types';
import { t, type TextKey } from '../i18n';
import { createFigure, type Figure } from '../render/figure';
import { dress } from '../render/outfit';
import { PLAYER_COLORS } from '../render/palette';
import { ACCESSORIES, COLORS, ITEM_ICON, ITEM_PRICE, SLOTS, type Accessory, type Slot } from '../shop/catalog';
import { buyAccessory, buyItem, toggleCarry, toggleWear, type ShopData } from '../shop/wallet';

/**
 * TokopaEdi, the shop popup: accessories (try on, buy, wear) and items (buy,
 * choose the one to bring). A small turning 3D preview shows the outfit.
 */
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const MODEL_ICON: Record<Accessory['model'], string> = {
  cap: '🧢',
  bucket: '👒',
  beanie: '🧶',
  peci: '🎩',
  caping: '👒',
  shirt: '👕',
  hoodie: '🧥',
  mask: '😷',
  shades: '🕶️',
  glasses: '👓',
  backpack: '🎒',
  sling: '👝',
  tote: '👜',
};

export function accessoryName(a: Accessory): string {
  return t('accName', { model: t(`model_${a.model}` as TextKey), color: t(`color_${a.color}` as TextKey) });
}

export class ShopUI {
  private tab: 'acc' | 'items' = 'acc';
  private slot: Slot = 'head';
  /** Accessory being tried on (not bought yet). */
  private trying: Accessory | null = null;
  private preview: Preview | null = null;

  constructor(
    private readonly data: ShopData,
    private readonly changed: () => void,
  ) {
    $('shopTabs').addEventListener('click', (e) => {
      const v = (e.target as HTMLElement).closest<HTMLElement>('button')?.dataset.v;
      if (v === 'acc' || v === 'items') {
        this.tab = v;
        this.trying = null;
        this.render();
        $('shopGrid').scrollTop = 0;
      }
    });
    $('shopSlots').addEventListener('click', (e) => {
      const v = (e.target as HTMLElement).closest<HTMLElement>('button')?.dataset.v as Slot | undefined;
      if (v && SLOTS.includes(v)) {
        this.slot = v;
        this.render();
        $('shopGrid').scrollTop = 0;
      }
    });
    $('shopGrid').addEventListener('click', (e) => this.onGridClick(e));
  }

  open(): void {
    this.trying = null;
    this.render();
    $('shopGrid').scrollTop = 0;
    this.preview ??= new Preview($<HTMLCanvasElement>('shopPreview'));
    this.preview.start();
    this.updatePreview();
  }

  close(): void {
    this.trying = null;
    this.preview?.stop();
  }

  /** Text changed language. */
  refresh(): void {
    if (!$('shopScreen').hidden) this.render();
  }

  private render(): void {
    $('shopCoins').textContent = `🪙 ${this.data.coins}`;
    for (const b of $('shopTabs').querySelectorAll<HTMLElement>('button')) b.classList.toggle('on', b.dataset.v === this.tab);
    const slots = $('shopSlots');
    slots.hidden = this.tab !== 'acc';
    slots.replaceChildren(
      ...SLOTS.map((s) => {
        const b = el('button', s === this.slot ? 'slot-chip on' : 'slot-chip', t(`slot_${s}` as TextKey));
        b.dataset.v = s;
        b.type = 'button';
        return b;
      }),
    );
    $('shopHint').textContent = this.tab === 'acc' ? t('shopHint') : t('itemsHint');
    $('shopGrid').replaceChildren(...(this.tab === 'acc' ? this.accessoryCards() : this.itemCards()));
    this.updatePreview();
  }

  private accessoryCards(): HTMLElement[] {
    return ACCESSORIES.filter((a) => a.slot === this.slot).map((a) => {
      const owned = this.data.owned.includes(a.id);
      const worn = this.data.look[a.slot] === a.id;
      const li = el('li', `card${this.trying?.id === a.id ? ' trying' : ''}${worn ? ' worn' : ''}`);
      li.dataset.acc = a.id;
      const icon = el('span', 'card-icon', MODEL_ICON[a.model]);
      icon.style.setProperty('--swatch', COLORS[a.color]);
      const btn = el('button', 'btn small', '');
      btn.type = 'button';
      btn.dataset.do = owned ? 'wear' : 'buy';
      if (owned) {
        btn.textContent = worn ? `✓ ${t('wearing')}` : t('wear');
        btn.classList.toggle('primary', !worn);
      } else {
        const afford = this.data.coins >= a.price;
        btn.textContent = afford ? `${t('buy')} 🪙${a.price}` : `🪙${a.price}`;
        btn.classList.add(afford ? 'primary' : 'disabled');
        btn.disabled = !afford;
        if (!afford) btn.title = t('notEnough');
      }
      li.append(icon, el('b', 'card-name', accessoryName(a)), btn);
      return li;
    });
  }

  private itemCards(): HTMLElement[] {
    return ITEM_KINDS.map((kind) => {
      const have = this.data.bag[kind] ?? 0;
      const carried = this.data.carry === kind;
      const li = el('li', `card item${carried ? ' worn' : ''}`);
      const price = ITEM_PRICE[kind];
      const afford = this.data.coins >= price;
      const buy = el('button', `btn small ${afford ? '' : 'disabled'}`, afford ? `${t('buy')} 🪙${price}` : `🪙${price}`);
      buy.type = 'button';
      buy.dataset.do = 'buyItem';
      buy.dataset.item = kind;
      buy.disabled = !afford;
      const bring = el('button', `btn small ${carried ? '' : 'primary'}`, carried ? `✓ ${t('bringing')}` : t('bring'));
      bring.type = 'button';
      bring.dataset.do = 'carry';
      bring.dataset.item = kind;
      bring.hidden = have === 0;
      const row = el('div', 'card-actions');
      row.append(buy, bring);
      li.append(
        el('span', 'card-icon', ITEM_ICON[kind]),
        el('b', 'card-name', t(`item_${kind}` as TextKey)),
        el('span', 'card-desc', t(`itemDesc_${kind}` as TextKey)),
        el('span', 'card-have', have > 0 ? t('owned', { n: have }) : ''),
        row,
      );
      return li;
    });
  }

  private onGridClick(e: Event): void {
    const target = e.target as HTMLElement;
    const btn = target.closest<HTMLButtonElement>('button');
    const card = target.closest<HTMLElement>('li');
    if (btn?.dataset.do === 'buyItem' || btn?.dataset.do === 'carry') {
      const kind = btn.dataset.item as ItemKind;
      if (btn.dataset.do === 'buyItem') buyItem(this.data, kind);
      else toggleCarry(this.data, kind);
      this.changed();
      return this.render();
    }
    const a = ACCESSORIES.find((x) => x.id === card?.dataset.acc);
    if (!a) return;
    if (btn?.dataset.do === 'buy') {
      if (buyAccessory(this.data, a.id)) {
        this.trying = null;
        this.changed();
      }
    } else if (btn?.dataset.do === 'wear') {
      toggleWear(this.data, a.id);
      this.trying = null;
      this.changed();
    } else {
      // Tap the card: try it on (tap again to stop).
      this.trying = this.trying?.id === a.id ? null : a;
    }
    this.render();
  }

  private updatePreview(): void {
    const look: Look = { ...this.data.look };
    if (this.trying) look[this.trying.slot] = this.trying.id;
    this.preview?.show(look);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  e.textContent = text;
  return e;
}

/** A small turning figure wearing the outfit. Renders only while the shop is open. */
class Preview {
  private readonly renderer: THREE.WebGLRenderer | null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  private readonly fig: Figure;
  private raf = 0;
  private last = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    let r: THREE.WebGLRenderer | null = null;
    try {
      r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    } catch {
      // No WebGL: the list still works without the preview.
    }
    this.renderer = r;
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#8796a6', 2.2));
    const sun = new THREE.DirectionalLight('#ffffff', 1.4);
    sun.position.set(2, 4, 3);
    this.scene.add(sun);
    this.fig = createFigure(PLAYER_COLORS[0], '#f0c9a4', true, 0);
    this.fig.root.scale.setScalar(1.6);
    this.scene.add(this.fig.root);
    this.camera.position.set(0, 1.45, 4.4);
    this.camera.lookAt(0, 0.95, 0);
  }

  show(look: Look): void {
    dress(this.fig, look, PLAYER_COLORS[0]);
  }

  start(): void {
    if (!this.renderer || this.raf) return;
    this.last = performance.now();
    const frame = (now: number) => {
      this.raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.fig.root.rotation.y += dt * 0.9;
      this.resize();
      this.renderer!.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h || !this.renderer) return;
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x === w && size.y === h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}

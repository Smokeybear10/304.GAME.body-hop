import {
  EMPTY_INPUT,
  getPlayer,
  getNearbyBody,
  canSwitchBody,
  hasLineOfSight,
} from "../shared/engine";
import { BODY_SWITCH_RANGE, LEAP_DISTANCE, TICK_MS, WORLD_HEIGHT, WORLD_WIDTH } from "../shared/content";
import type { Corpse, InputFrame, Run, Vec2 } from "../shared/types";

type Drag = {
  id: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
};
const SWITCH_BUFFER_MS = 220;
const SWITCH_APPROACH_RANGE = BODY_SWITCH_RANGE + 36;

export class GameInput {
  private keys = new Set<string>();
  private moveDrag: Drag | null = null;
  private actionDrag: Drag | null = null;
  private aim: Vec2 = { x: 0, y: -1 };
  private targetDistance = LEAP_DISTANCE;
  private mouse: Vec2 | null = null;
  private abilityQueuedUntil = 0;
  private pendingSwitch: { id: number; until: number; source: "mouse" | "keyboard" | "button" } | null = null;
  private switchPointerId: number | null = null;
  private queuedAbilitySource: "mouse" | "keyboard" | "pad" | null = null;
  private queuedAim: Vec2 | null = null;
  private queuedAimDistance: number | null = null;
  private specialBlocked = false;
  private hostId: number;
  private phase: Run["phase"];
  private attack = false;
  private mouseButtons = 0;
  private mousePointerId: number | null = null;
  private bounds = { left: 0, top: 0, width: 1, height: 1 };
  private observer: ResizeObserver;
  private controller = new AbortController();
  actionAiming = false;
  constructor(
    private canvas: HTMLCanvasElement,
    private getRun: () => Run,
    private onPause: () => void
  ) {
    this.hostId = getPlayer(this.getRun()).id;
    this.phase = this.getRun().phase;
    const options = { signal: this.controller.signal };
    const updateBounds = () => {
      const r = canvas.getBoundingClientRect();
      this.bounds = {
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
      };
    };
    updateBounds();
    this.observer = new ResizeObserver(updateBounds);
    this.observer.observe(canvas);
    window.addEventListener("resize", updateBounds, options);
    window.addEventListener("scroll", updateBounds, options);
    window.addEventListener("blur", () => this.clear(), options);
    window.addEventListener(
      "keydown",
      (event) => {
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          /INPUT|TEXTAREA|SELECT/.test(target.tagName)
        )
          return;
        if (
          target instanceof HTMLButtonElement &&
          ["Space", "Enter"].includes(event.code)
        )
          return;
        if (event.code === "Escape") {
          this.clear();
          this.onPause();
          return;
        }
        if (!["playing", "cleared"].includes(this.getRun().phase)) return;
        if (
          [
            "ArrowUp",
            "ArrowDown",
            "ArrowLeft",
            "ArrowRight",
            "Space",
            "KeyE",
          ].includes(event.code)
        )
          event.preventDefault();
        const wasDown = this.keys.has(event.code);
        this.keys.add(event.code);
        if (event.code === "KeyE" && !event.repeat && !wasDown)
          this.queueSwitch("keyboard");
        if (event.code === "Space" && !event.repeat) {
          this.aimAtPointerOrEnemy();
          this.queueAbility("keyboard");
        }
      },
      options
    );
    window.addEventListener(
      "keyup",
      (event) => {
        this.keys.delete(event.code);
      },
      options
    );
    canvas.addEventListener(
      "contextmenu",
      (event) => event.preventDefault(),
      options
    );
    canvas.addEventListener(
      "pointermove",
      (event) => {
        if (event.pointerType !== "mouse") return;
        this.mouse = this.toWorld(event.clientX, event.clientY);
        this.aimAtPointerOrEnemy();
        this.updateMouseButtons(event);
      },
      options
    );
    window.addEventListener(
      "pointermove",
      (event) => {
        if (
          event.pointerType !== "mouse" ||
          this.mousePointerId !== event.pointerId
        )
          return;
        this.mouse = this.toWorld(event.clientX, event.clientY);
        this.aimAtPointerOrEnemy();
        this.updateMouseButtons(event);
      },
      options
    );
    canvas.addEventListener(
      "pointerleave",
      () => {
        if (!this.attack) this.mouse = null;
      },
      options
    );
    canvas.addEventListener(
      "pointerdown",
      (event) => {
        if (
          event.pointerType !== "mouse" ||
          !["playing", "cleared"].includes(this.getRun().phase)
        )
          return;
        this.mouse = this.toWorld(event.clientX, event.clientY);
        this.aimAtPointerOrEnemy();
        this.mousePointerId = event.pointerId;
        canvas.setPointerCapture(event.pointerId);
        this.updateMouseButtons(event);
      },
      options
    );
    window.addEventListener(
      "pointerup",
      (event) => {
        if (event.pointerType !== "mouse" || event.pointerId !== this.mousePointerId) return;
        this.mouse = this.toWorld(event.clientX, event.clientY);
        this.updateMouseButtons(event);
      },
      options
    );
    canvas.addEventListener("pointercancel", () => this.clear(), options);
    canvas.addEventListener(
      "lostpointercapture",
      (event) => {
        if (event.pointerId !== this.mousePointerId) return;
        this.mouseButtons = 0;
        this.mousePointerId = null;
        this.attack = false;
        if (this.pendingSwitch?.source === "mouse") this.pendingSwitch = null;
        if (this.queuedAbilitySource === "mouse") {
          this.abilityQueuedUntil = 0;
          this.queuedAbilitySource = null;
          this.queuedAim = null;
          this.queuedAimDistance = null;
        }
      },
      options
    );
    this.bindPad("move-pad", "move");
    this.bindPad("ability-button", "action");
    const switchButton = document.getElementById("switch-button");
    if (!switchButton) throw new Error("Missing game control switch-button");
    switchButton.addEventListener("keydown", (event) => {
      if (event.repeat && ["Space", "Enter"].includes(event.code))
        event.preventDefault();
    }, options);
    switchButton.addEventListener("pointerdown", (event) => {
      if (
        this.switchPointerId !== null ||
        (event.pointerType === "mouse" && event.button !== 0) ||
        !["playing", "cleared"].includes(this.getRun().phase)
      ) return;
      event.preventDefault();
      this.switchPointerId = event.pointerId;
      switchButton.setPointerCapture(event.pointerId);
      switchButton.classList.add("held");
      this.queueSwitch("button");
      this.canvas.focus({ preventScroll: true });
    }, options);
    const releaseSwitch = (event: PointerEvent, cancelled: boolean) => {
      if (event.pointerId !== this.switchPointerId) return;
      this.switchPointerId = null;
      switchButton.classList.remove("held");
      if (cancelled && this.pendingSwitch?.source === "button")
        this.pendingSwitch = null;
    };
    switchButton.addEventListener("pointerup", (event) => releaseSwitch(event, false), options);
    switchButton.addEventListener("pointercancel", (event) => releaseSwitch(event, true), options);
    switchButton.addEventListener("lostpointercapture", (event) => releaseSwitch(event, true), options);
    switchButton.addEventListener("click", (event) => {
      if (event.detail !== 0) return;
      this.queueSwitch("keyboard");
      this.canvas.focus({ preventScroll: true });
    }, options);
  }
  private updateMouseButtons(event: PointerEvent) {
    if (event.pointerId !== this.mousePointerId) return;
    const previous = this.mouseButtons;
    this.mouseButtons = event.buttons;
    if ((event.buttons & 1) && !(previous & 1)) {
      this.queueAbility("mouse");
      this.attack = true;
    }
    if (!(event.buttons & 1) && (previous & 1)) this.attack = false;
    if ((event.buttons & 2) && !(previous & 2)) this.queueSwitch("mouse");
    if (event.buttons === 0) this.mousePointerId = null;
  }
  private toWorld(x: number, y: number): Vec2 {
    return {
      x: ((x - this.bounds.left) / this.bounds.width) * WORLD_WIDTH,
      y: ((y - this.bounds.top) / this.bounds.height) * WORLD_HEIGHT,
    };
  }
  private bindPad(id: string, kind: "move" | "action") {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing game control ${id}`);
    const options = { signal: this.controller.signal };
    element.addEventListener(
      "pointerdown",
      (event) => {
        if (!["playing", "cleared"].includes(this.getRun().phase)) return;
        if (
          (kind === "move" && this.moveDrag) ||
          (kind === "action" && this.actionDrag)
        )
          return;
        event.preventDefault();
        element.setPointerCapture(event.pointerId);
        const drag = {
          id: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          x: event.clientX,
          y: event.clientY,
        };
        if (kind === "move") this.moveDrag = drag;
        if (kind === "action") {
          this.syncHost();
          this.specialBlocked = false;
          this.actionDrag = drag;
          this.actionAiming = true;
          this.mouse = null;
          this.aimAtPointerOrEnemy();
        }
        element.classList.add("held");
      },
      options
    );
    element.addEventListener(
      "pointermove",
      (event) => {
        const drag = kind === "move" ? this.moveDrag : this.actionDrag;
        if (!drag || drag.id !== event.pointerId) return;
        drag.x = event.clientX;
        drag.y = event.clientY;
        const dx = drag.x - drag.startX,
          dy = drag.y - drag.startY,
          len = Math.hypot(dx, dy);
        if (kind === "move") {
          element.style.setProperty(
            "--stick-x",
            `${dx / Math.max(1, len / 26)}px`
          );
          element.style.setProperty(
            "--stick-y",
            `${dy / Math.max(1, len / 26)}px`
          );
        }
        if (kind === "action" && len > 8) {
          this.aim = { x: dx / len, y: dy / len };
          this.targetDistance = Math.min(1, len / 28) * LEAP_DISTANCE;
        }
      },
      options
    );
    const release = (event: PointerEvent, cancelled: boolean) => {
      const drag = kind === "move" ? this.moveDrag : this.actionDrag;
      if (!drag || drag.id !== event.pointerId) return;
      this.syncHost();
      if (kind === "move") {
        this.moveDrag = null;
        element.style.setProperty("--stick-x", "0px");
        element.style.setProperty("--stick-y", "0px");
      }
      if (kind === "action") {
        if (!cancelled && !this.specialBlocked) {
          const aimed = Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > 8;
          this.queueAbility("pad", aimed ? this.aim : null);
        }
        this.actionDrag = null;
        this.actionAiming = false;
      }
      element.classList.remove("held");
    };
    element.addEventListener("pointerup", (event) => release(event, false), options);
    element.addEventListener("pointercancel", (event) => release(event, true), options);
    element.addEventListener("lostpointercapture", (event) => release(event, true), options);
    element.addEventListener(
      "click",
      (event) => {
        if (
          event.detail !== 0 ||
          !["playing", "cleared"].includes(this.getRun().phase)
        )
          return;
        if (kind === "action") {
          this.aimAtPointerOrEnemy();
          this.queueAbility("keyboard");
        }
      },
      options
    );
  }
  private aimAtPointerOrEnemy() {
    if (this.actionDrag && Math.hypot(this.actionDrag.x - this.actionDrag.startX, this.actionDrag.y - this.actionDrag.startY) > 8)
      return;
    const run = this.getRun(),
      player = getPlayer(run);
    let target = this.mouse;
    if (!target) {
      const enemy = run.actors
        .filter((a) => a.faction === "enemy" && a.hp > 0 && hasLineOfSight(run, player, a))
        .sort(
          (a, b) =>
            Math.hypot(a.x - player.x, a.y - player.y) -
            Math.hypot(b.x - player.x, b.y - player.y)
        )[0];
      target = enemy ?? null;
    }
    if (!target) {
      const movement = this.movement();
      const length = Math.hypot(movement.x, movement.y);
      if (length > 0) this.aim = { x: movement.x / length, y: movement.y / length };
      this.targetDistance = LEAP_DISTANCE;
      return;
    }
    const dx = target.x - player.x,
      dy = target.y - player.y,
      len = Math.hypot(dx, dy);
    this.targetDistance = len;
    if (len > 1) this.aim = { x: dx / len, y: dy / len };
  }
  private queueAbility(source: "mouse" | "keyboard" | "pad", aim: Vec2 | null = null) {
    this.syncHost();
    this.specialBlocked = false;
    this.abilityQueuedUntil = performance.now() + 160;
    this.queuedAbilitySource = source;
    this.queuedAim = aim ? { ...aim } : null;
    this.queuedAimDistance = aim ? this.targetDistance : null;
  }
  private queueSwitch(source: "mouse" | "keyboard" | "button") {
    this.syncHost();
    const body = this.switchTarget;
    if (!body) return;
    this.pendingSwitch = { id: body.id, until: performance.now() + SWITCH_BUFFER_MS, source };
    this.abilityQueuedUntil = 0;
    this.queuedAbilitySource = null;
    this.queuedAim = null;
    this.queuedAimDistance = null;
  }
  private syncHost() {
    const run = this.getRun(), player = getPlayer(run);
    if (run.phase !== this.phase) {
      this.phase = run.phase;
      this.pendingSwitch = null;
    }
    if (player.id === this.hostId) return;
    this.hostId = player.id;
    this.pendingSwitch = null;
    this.abilityQueuedUntil = 0;
    this.queuedAbilitySource = null;
    this.queuedAim = null;
    this.queuedAimDistance = null;
    this.specialBlocked = this.attack || this.keys.has("Space") || this.actionDrag !== null;
  }
  private movement(): Vec2 {
    if (this.moveDrag) {
      const dx = this.moveDrag.x - this.moveDrag.startX,
        dy = this.moveDrag.y - this.moveDrag.startY,
        distance = Math.hypot(dx, dy),
        strength = Math.min(1, Math.max(0, (distance - 4) / 24));
      return distance > 0 ? { x: dx / distance * strength, y: dy / distance * strength } : { x: 0, y: 0 };
    }
    const x = Number(this.keys.has("KeyD") || this.keys.has("ArrowRight")) -
      Number(this.keys.has("KeyA") || this.keys.has("ArrowLeft"));
    const y = Number(this.keys.has("KeyS") || this.keys.has("ArrowDown")) -
      Number(this.keys.has("KeyW") || this.keys.has("ArrowUp"));
    const length = Math.max(1, Math.hypot(x, y));
    return { x: x / length, y: y / length };
  }
  read(): InputFrame {
    this.syncHost();
    if (!this.attack && !this.keys.has("Space") && !this.actionDrag)
      this.specialBlocked = false;
    const now = performance.now();
    if (now > this.abilityQueuedUntil) {
      this.queuedAbilitySource = null;
      this.queuedAim = null;
      this.queuedAimDistance = null;
    }
    const manualDrag = this.actionDrag &&
      Math.hypot(this.actionDrag.x - this.actionDrag.startX, this.actionDrag.y - this.actionDrag.startY) > 8;
    if (this.queuedAim) {
      this.aim = this.queuedAim;
      this.targetDistance = this.queuedAimDistance ?? LEAP_DISTANCE;
    }
    else if (!manualDrag) this.aimAtPointerOrEnemy();
    const movement = this.movement();
    const run = this.getRun(), player = getPlayer(run);
    const pending = this.pendingSwitch;
    const body = pending ? run.corpses.find((corpse) => corpse.id === pending.id) : null;
    if (pending && (
      now > pending.until ||
      !["playing", "cleared"].includes(run.phase) ||
      run.core <= 0 || player.hp <= 0 ||
      !body || body.spent || body.consumed ||
      Math.hypot(body.x - player.x, body.y - player.y) > SWITCH_APPROACH_RANGE ||
      !hasLineOfSight(run, player, body)
    )) this.pendingSwitch = null;
    const switching = this.pendingSwitch !== null;
    const hopCommitId = this.pendingSwitch && canSwitchBody(run, this.pendingSwitch.id)
      ? this.pendingSwitch.id : null;
    if (hopCommitId !== null) this.pendingSwitch = null;
    const abilityPressed = !switching && !this.specialBlocked &&
      !player.action && player.stunMs <= TICK_MS && player.specialCooldownMs <= TICK_MS &&
      (now <= this.abilityQueuedUntil ||
        (player.species === "spitter" && (this.attack || this.keys.has("Space"))));
    const result = {
      ...EMPTY_INPUT,
      moveX: movement.x,
      moveY: movement.y,
      aimX: this.aim.x,
      aimY: this.aim.y,
      aimDistance: this.targetDistance,
      attackHeld: false,
      abilityPressed,
      assistedBasic: false,
      hopHeld: false,
      hopCommitId,
    };
    if (abilityPressed) {
      this.abilityQueuedUntil = 0;
      this.queuedAbilitySource = null;
      this.queuedAim = null;
      this.queuedAimDistance = null;
    }
    return result;
  }
  get switchTarget(): Corpse | null {
    const run = this.getRun(), player = getPlayer(run);
    if (!["playing", "cleared"].includes(run.phase) || run.core <= 0 || player.hp <= 0) return null;
    const eligible = (corpse: Corpse) => !corpse.spent && !corpse.consumed &&
      Math.hypot(corpse.x - player.x, corpse.y - player.y) <= SWITCH_APPROACH_RANGE &&
      hasLineOfSight(run, player, corpse);
    if (this.pendingSwitch && performance.now() <= this.pendingSwitch.until) {
      const pending = run.corpses.find(corpse => corpse.id === this.pendingSwitch?.id);
      if (pending && eligible(pending)) return pending;
    }
    return getNearbyBody(run) ?? run.corpses
      .filter(eligible)
      .sort((a, b) => Math.hypot(a.x - player.x, a.y - player.y) -
        Math.hypot(b.x - player.x, b.y - player.y) || a.id - b.id)[0] ?? null;
  }
  get aimDirection() {
    return this.aim;
  }
  get aimDistance() {
    return this.targetDistance;
  }
  get hasExplicitAim() {
    return this.actionAiming || this.mouse !== null;
  }
  clear() {
    this.keys.clear();
    this.moveDrag = null;
    this.actionDrag = null;
    this.abilityQueuedUntil = 0;
    this.pendingSwitch = null;
    this.switchPointerId = null;
    this.queuedAbilitySource = null;
    this.queuedAim = null;
    this.queuedAimDistance = null;
    this.specialBlocked = false;
    this.hostId = getPlayer(this.getRun()).id;
    this.phase = this.getRun().phase;
    this.targetDistance = LEAP_DISTANCE;
    this.attack = false;
    this.mouseButtons = 0;
    this.mousePointerId = null;
    this.mouse = null;
    this.actionAiming = false;
    document
      .querySelectorAll(".held")
      .forEach((el) => el.classList.remove("held"));
    const pad = document.getElementById("move-pad");
    pad?.style.setProperty("--stick-x", "0px");
    pad?.style.setProperty("--stick-y", "0px");
  }
  destroy() {
    this.clear();
    this.observer.disconnect();
    this.controller.abort();
  }
}

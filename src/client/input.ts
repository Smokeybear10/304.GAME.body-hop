import {
  EMPTY_INPUT,
  getPlayer,
  canSwitchBody,
  hasLineOfSight,
  previewCharge,
} from "../shared/engine";
import { BODY_SWITCH_RANGE, CHARGE_SPEED, ENEMY_WALK_SPEED_SCALE, LEAP_DISTANCE, PLAYER_LEAP_BASE_MS, PLAYER_LEAP_RANGE_MS, PLAYER_MELEE_WINDUP_MS, PLAYER_SPIT_SPEED, PLAYER_SPIT_WINDUP_MS, SPECIES, TICK_MS, WORLD_HEIGHT, WORLD_WIDTH } from "../shared/content";
import type { Actor, Corpse, InputFrame, Run, Vec2 } from "../shared/types";

type Drag = {
  id: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
};
export class GameInput {
  private keys = new Set<string>();
  private moveDrag: Drag | null = null;
  private actionDrag: Drag | null = null;
  private aim: Vec2 = { x: 0, y: -1 };
  private targetDistance = LEAP_DISTANCE;
  private mouse: Vec2 | null = null;
  private targetSample: { id: number; x: number; y: number; timeMs: number; vx: number; vy: number } | null = null;
  private abilityQueuedUntil = 0;
  private blockedBodies = new Set<number>();
  private queuedAbilitySource: "mouse" | "keyboard" | "pad" | null = null;
  private queuedAim: Vec2 | null = null;
  private queuedAimDistance: number | null = null;
  private specialBlocked = false;
  private hostId: number;
  private hostSpecies: Actor["species"];
  private runId: string;
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
    this.hostSpecies = getPlayer(this.getRun()).species;
    this.runId = this.getRun().runId;
    this.blockNearbyBodies();
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
        if (event.code === "Escape") {
          if (event.repeat) return;
          event.preventDefault();
          this.clear();
          this.onPause();
          return;
        }
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
        if (!["playing", "cleared"].includes(this.getRun().phase)) return;
        if (
          [
            "ArrowUp",
            "ArrowDown",
            "ArrowLeft",
            "ArrowRight",
            "Space",
          ].includes(event.code)
        )
          event.preventDefault();
        this.keys.add(event.code);
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
          event.pointerType !== "mouse" || event.button !== 0 ||
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
  private assistedTarget(run: Run, enemy: Actor): Vec2 {
    const player = getPlayer(run), previous = this.targetSample;
    const elapsed = previous ? (run.activeTimeMs - previous.timeMs) / 1000 : 0;
    let vx = 0, vy = 0;
    if (previous?.id === enemy.id && elapsed === 0) {
      vx = previous.vx;
      vy = previous.vy;
    } else if (previous?.id === enemy.id && elapsed > 0 && elapsed <= 0.1) {
      vx = (enemy.x - previous.x) / elapsed;
      vy = (enemy.y - previous.y) / elapsed;
    }
    this.targetSample = { id: enemy.id, x: enemy.x, y: enemy.y, timeMs: run.activeTimeMs, vx, vy };
    const speed = Math.hypot(vx, vy);
    if (player.species !== "spitter" || enemy.action || enemy.stunMs > 0 || speed === 0 ||
      speed > SPECIES[enemy.species].speed * ENEMY_WALK_SPEED_SCALE + 1) return enemy;

    const movement = this.movement(), windup = PLAYER_SPIT_WINDUP_MS / 1000;
    const origin = previewCharge(run, player, movement.x, movement.y,
      Math.min(1, Math.hypot(movement.x, movement.y)) * SPECIES[player.species].speed * windup);
    const muzzle = player.radius + 7;
    let flight = Math.max(0, (Math.hypot(enemy.x - origin.x, enemy.y - origin.y) - muzzle) / PLAYER_SPIT_SPEED);
    for (let index = 0; index < 3; index++) {
      flight = Math.max(0, (Math.hypot(enemy.x + vx * (windup + flight) - origin.x,
        enemy.y + vy * (windup + flight) - origin.y) - muzzle) / PLAYER_SPIT_SPEED);
    }
    const forecast = previewCharge(run, enemy, vx, vy, Math.min(120, speed * Math.min(1, windup + flight)));
    if (!hasLineOfSight(run, origin, forecast, 8)) return enemy;
    return { x: forecast.x + player.x - origin.x, y: forecast.y + player.y - origin.y };
  }
  private airborneAtContact(run: Run, enemy: Actor): boolean {
    const action = enemy.action;
    if (action?.kind !== "leap" || action.stage !== "active") return false;
    const player = getPlayer(run);
    const distance = Math.hypot(enemy.x - player.x, enemy.y - player.y);
    const contactMs = player.species === "spitter"
      ? PLAYER_SPIT_WINDUP_MS + Math.max(0, distance - player.radius - 7 - enemy.radius - 8) / PLAYER_SPIT_SPEED * 1000
      : player.species === "beetle"
      ? PLAYER_MELEE_WINDUP_MS + Math.max(0, distance - player.radius - enemy.radius) / CHARGE_SPEED * 1000
      : PLAYER_MELEE_WINDUP_MS + PLAYER_LEAP_BASE_MS + Math.min(1, distance / LEAP_DISTANCE) * PLAYER_LEAP_RANGE_MS;
    const readyMs = Math.max(player.specialCooldownMs, player.stunMs, 0);
    return action.durationMs - action.timeMs > readyMs + contactMs + TICK_MS;
  }
  private aimAtPointerOrEnemy() {
    if (this.actionDrag && Math.hypot(this.actionDrag.x - this.actionDrag.startX, this.actionDrag.y - this.actionDrag.startY) > 8)
      return;
    const run = this.getRun(),
      player = getPlayer(run);
    let target = this.mouse;
    if (target) this.targetSample = null;
    if (!target) {
      const enemies = run.actors
        .filter((a) => a.faction === "enemy" && a.hp > 0 && hasLineOfSight(run, player, a));
      const available = enemies.filter(enemy => !this.airborneAtContact(run, enemy));
      const enemy = (available.length ? available : enemies)
        .sort(
          (a, b) =>
            Math.hypot(a.x - player.x, a.y - player.y) -
            Math.hypot(b.x - player.x, b.y - player.y)
        )[0];
      target = enemy ? this.assistedTarget(run, enemy) : null;
      if (!enemy) this.targetSample = null;
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
    if (!aim) this.aimAtPointerOrEnemy();
    const committedAim = aim ?? (this.mouse ? null : this.aim);
    this.specialBlocked = false;
    this.abilityQueuedUntil = performance.now() + 160;
    this.queuedAbilitySource = source;
    this.queuedAim = committedAim ? { ...committedAim } : null;
    this.queuedAimDistance = committedAim ? this.targetDistance : null;
  }
  private blockNearbyBodies() {
    const run = this.getRun(), player = getPlayer(run);
    this.blockedBodies = new Set(run.corpses.filter(corpse =>
      !corpse.spent && !corpse.consumed &&
      Math.hypot(corpse.x - player.x, corpse.y - player.y) <= BODY_SWITCH_RANGE
    ).map(corpse => corpse.id));
  }
  private syncHost() {
    const run = this.getRun(), player = getPlayer(run);
    if (player.id !== this.hostId || run.runId !== this.runId) {
      const continuingSpit = run.runId === this.runId &&
        this.hostSpecies === "spitter" && player.species === "spitter";
      this.hostId = player.id;
      this.hostSpecies = player.species;
      this.runId = run.runId;
      this.blockNearbyBodies();
      this.abilityQueuedUntil = 0;
      this.queuedAbilitySource = null;
      this.queuedAim = null;
      this.queuedAimDistance = null;
      this.targetSample = null;
      if (!continuingSpit)
        this.specialBlocked = this.attack || this.keys.has("Space") || this.actionDrag !== null;
    }
    for (const id of this.blockedBodies) {
      const corpse = run.corpses.find(body => body.id === id);
      if (!corpse || corpse.spent || corpse.consumed ||
        Math.hypot(corpse.x - player.x, corpse.y - player.y) > BODY_SWITCH_RANGE)
        this.blockedBodies.delete(id);
    }
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
    const body = this.switchTarget;
    const hopCommitId = (movement.x || movement.y) && !player.action &&
      body && canSwitchBody(run, body.id) ? body.id : null;
    if (hopCommitId !== null) {
      this.abilityQueuedUntil = 0;
      this.queuedAbilitySource = null;
      this.queuedAim = null;
      this.queuedAimDistance = null;
    }
    const abilityPressed = hopCommitId === null && !this.specialBlocked &&
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
    return this.nearestBody(BODY_SWITCH_RANGE);
  }
  get approachingBody(): Corpse | null {
    return this.nearestBody(110);
  }
  private nearestBody(range: number): Corpse | null {
    const run = this.getRun(), player = getPlayer(run);
    if (!["playing", "cleared"].includes(run.phase) || run.core <= 0 || player.hp <= 0) return null;
    const movement = this.movement();
    return run.corpses.filter(corpse => {
      const dx = corpse.x - player.x, dy = corpse.y - player.y;
      const gap = Math.hypot(dx, dy);
      return !corpse.spent && !corpse.consumed && !this.blockedBodies.has(corpse.id) &&
        gap <= range && hasLineOfSight(run, player, corpse) &&
        ((!movement.x && !movement.y) || gap <= 12 || movement.x * dx + movement.y * dy > 0);
    })
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
    this.syncHost();
    this.keys.clear();
    this.moveDrag = null;
    this.actionDrag = null;
    this.abilityQueuedUntil = 0;
    this.queuedAbilitySource = null;
    this.queuedAim = null;
    this.queuedAimDistance = null;
    this.specialBlocked = false;
    this.targetDistance = LEAP_DISTANCE;
    this.attack = false;
    this.mouseButtons = 0;
    this.mousePointerId = null;
    this.mouse = null;
    this.targetSample = null;
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

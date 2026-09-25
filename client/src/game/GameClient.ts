import * as THREE from "three";
import { COLLIDERS, movePlayer } from "../../../shared/src/movement";
import { calculateWeaponAccuracy } from "../../../shared/src/accuracy";
import { EMPTY_INPUT, type DroppedWeapon, type GameState, type PlayerInput, type PlayerPosition, type PublicPlayer, type ServerEvent, type WeaponId } from "../../../shared/src/protocol";

interface Avatar {
  root: THREE.Group;
  target: THREE.Vector3;
  body: THREE.Mesh;
  name: string;
}

interface Tracer {
  line: THREE.Line;
  expires: number;
}

type SendFunction = (message: object) => void;
type GraphicsQuality = "LOW" | "BALANCED" | "HIGH";

const TEAM_COLORS = { ALPHA: 0xe6a536, BRAVO: 0x52a6c9 };

export class GameClient {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(90, window.innerWidth / window.innerHeight, 0.08, 120);
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  private readonly clock = new THREE.Clock();
  private readonly avatars = new Map<string, Avatar>();
  private readonly droppedWeaponMarkers = new Map<string, THREE.Group>();
  private readonly tracers: Tracer[] = [];
  private readonly pressed = new Set<string>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly gunRoot = new THREE.Group();
  private deviceMarker: THREE.Group | null = null;
  private readonly pointLights: THREE.PointLight[] = [];
  private readonly flashMesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private keyLight: THREE.DirectionalLight | null = null;
  private localId = "";
  private spectatingId: string | null = null;
  private sendFn: SendFunction = () => undefined;
  private currentState: GameState | null = null;
  private predicted = new THREE.Vector3();
  private predictedReady = false;
  private yaw = Math.PI;
  private pitch = 0;
  private firing = false;
  private nextShotAt = 0;
  private lastInputAt = 0;
  private jumpPulse = false;
  private movementInput: PlayerInput = { ...EMPTY_INPUT };
  private weaponId: WeaponId = "AR12";
  private scoreBoardVisible = false;
  private pauseMenuOpen = false;
  private buyMenuOpen = false;
  private pauseOpenedAt = 0;
  private localVelocityX = 0;
  private localVelocityZ = 0;
  private localMaxSpeed = 4.13;
  private jumpBufferSeconds = 0;
  private dynamicCrosshair = true;
  private movementDebugEnabled = false;
  private performanceOverlayEnabled = false;
  private lastOverlayUpdateAt = 0;
  private smoothedFps = 60;
  private localBurstShots = 0;
  private lastLocalShotAt = 0;
  private mouseSensitivity = 1;
  private invertY = false;
  private gunKick = 0;
  private mouseSwayX = 0;
  private mouseSwayY = 0;
  private scoreboardCallback: (visible: boolean) => void = () => undefined;
  private buyMenuCallback: (visible: boolean) => void = () => undefined;
  private toastCallback: (message: string) => void = () => undefined;
  private pauseCallback: (paused: boolean) => void = () => undefined;
  private telemetryCallback: (movement: string | null, performance: string | null) => void = () => undefined;
  private context: AudioContext | null = null;
  private localName = "JOGADOR";

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.2));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.14;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.background = new THREE.Color(0x10161a);
    this.scene.fog = new THREE.Fog(0x10161a, 26, 68);
    this.camera.rotation.order = "YXZ";
    this.camera.add(this.gunRoot);
    this.scene.add(this.camera);
    this.createWorld();
    const flashMat = new THREE.MeshBasicMaterial({ color: 0xffd67d, transparent: true, opacity: 0, depthWrite: false });
    this.flashMesh = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), flashMat);
    this.flashMesh.position.set(0.42, -0.18, -0.92);
    this.camera.add(this.flashMesh);
    this.buildWeapon("AR12");
    window.addEventListener("resize", this.onResize);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    document.addEventListener("mousemove", this.onMouseMove);
    document.addEventListener("pointerlockchange", this.onPointerLockChange);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.canvas.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("mouseup", this.onMouseUp);
    this.renderer.setAnimationLoop(this.animate);
  }

  setSender(sender: SendFunction): void {
    this.sendFn = sender;
  }

  setCallbacks(callbacks: { scoreboard?: (visible: boolean) => void; buyMenu?: (visible: boolean) => void; toast?: (message: string) => void; pause?: (paused: boolean) => void; telemetry?: (movement: string | null, performance: string | null) => void }): void {
    this.scoreboardCallback = callbacks.scoreboard || (() => undefined);
    this.buyMenuCallback = callbacks.buyMenu || (() => undefined);
    this.toastCallback = callbacks.toast || (() => undefined);
    this.pauseCallback = callbacks.pause || (() => undefined);
    this.telemetryCallback = callbacks.telemetry || (() => undefined);
  }

  setFieldOfView(value: number): void {
    this.camera.fov = THREE.MathUtils.clamp(Number.isFinite(value) ? value : 90, 70, 110);
    this.camera.updateProjectionMatrix();
  }

  setHudSettings(dynamicCrosshair: boolean, movementDebug: boolean, performanceOverlay: boolean): void {
    this.dynamicCrosshair = dynamicCrosshair;
    this.movementDebugEnabled = movementDebug;
    this.performanceOverlayEnabled = performanceOverlay;
    this.telemetryCallback(null, null);
  }

  setMouseSettings(sensitivity: number, invertY: boolean): void {
    this.mouseSensitivity = Math.min(5, Math.max(0.1, Number.isFinite(sensitivity) ? sensitivity : 1));
    this.invertY = invertY;
  }

  setGraphicsQuality(quality: GraphicsQuality): void {
    const scale = quality === "LOW" ? 0.8 : quality === "HIGH" ? 1.35 : 1;
    this.renderer.setPixelRatio(Math.min((window.devicePixelRatio || 1) * scale, 1.6));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    const shadows = quality !== "LOW";
    this.renderer.shadowMap.enabled = shadows;
    for (const light of this.pointLights) light.visible = quality !== "LOW";
    if (this.keyLight) {
      this.keyLight.castShadow = shadows;
      const mapSize = quality === "HIGH" ? 1536 : 1024;
      this.keyLight.shadow.mapSize.set(mapSize, mapSize);
      this.keyLight.shadow.needsUpdate = true;
    }
  }

  resume(): void {
    if (!this.pauseMenuOpen) return;
    this.pauseMenuOpen = false;
    this.pauseCallback(false);
    const local = this.currentState?.players.find((player) => player.id === this.localId);
    if (local?.alive) this.captureMouse();
  }

  setPaused(paused: boolean): void {
    if (this.pauseMenuOpen === paused) return;
    this.pauseMenuOpen = paused;
    if (paused) this.pauseOpenedAt = performance.now();
    this.firing = false;
    this.pressed.clear();
    this.jumpPulse = false;
    if (paused) this.sendFn({ type: "input", input: { ...EMPTY_INPUT, yaw: this.yaw, pitch: this.pitch } });
    this.scoreBoardVisible = false;
    this.scoreboardCallback(false);
    if (paused && document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.pauseCallback(paused);
  }

  private setBuyMenu(open: boolean): void {
    if (open && this.currentState?.phase !== "FREEZE_TIME") return;
    if (this.buyMenuOpen === open) return;
    this.buyMenuOpen = open;
    if (open) {
      this.firing = false;
      this.pressed.clear();
      this.jumpPulse = false;
    }
    this.buyMenuCallback(open);
  }

  closeBuyMenu(): void {
    this.setBuyMenu(false);
  }

  setIdentity(playerId: string, name: string): void {
    this.localId = playerId;
    this.localName = name;
  }

  setState(state: GameState): void {
    this.currentState = state;
    const playable = ["WARMUP", "FREEZE_TIME", "ROUND_ACTIVE", "DEVICE_PLANTED"].includes(state.phase);
    if (!playable && this.pauseMenuOpen) this.setPaused(false);
    if (!playable && document.pointerLockElement === this.canvas) document.exitPointerLock();
    if (state.phase !== "FREEZE_TIME" && this.buyMenuOpen) this.setBuyMenu(false);
    if (state.phase !== "ROUND_ACTIVE" && state.phase !== "DEVICE_PLANTED") this.firing = false;
    this.updateDeviceMarker(state);
    this.updateDroppedWeapons(state.droppedWeapons);
    const local = state.players.find((player) => player.id === this.localId);
    if (!local?.alive && document.pointerLockElement === this.canvas) document.exitPointerLock();
    if (local?.alive) this.spectatingId = null;
    if (local) {
      if (!this.predictedReady) {
        this.predicted.set(local.x, local.y, local.z);
        this.predictedReady = true;
      } else {
        const errorX = local.x - this.predicted.x;
        const errorY = local.y - this.predicted.y;
        const errorZ = local.z - this.predicted.z;
        if (errorX * errorX + errorY * errorY + errorZ * errorZ > 4) {
          this.predicted.set(local.x, local.y, local.z);
        } else {
          this.predicted.x += errorX * 0.24;
          this.predicted.y += errorY * 0.24;
          this.predicted.z += errorZ * 0.24;
        }
      }
      this.localVelocityX += (local.velocityX - this.localVelocityX) * 0.35;
      this.localVelocityZ += (local.velocityZ - this.localVelocityZ) * 0.35;
      this.localVerticalVelocity += (local.velocityY - this.localVerticalVelocity) * 0.35;
      this.localGrounded = local.grounded;
      if (!this.pressed.has("MouseLocked")) {
        this.yaw = local.yaw;
      }
      if (local.weapon && this.weaponId !== local.weapon) {
        this.weaponId = local.weapon;
        this.buildWeapon(local.weapon);
      } else if (local.weapon) this.updateWeaponName(local.weapon);
    }
    const livingIds = new Set(state.players.filter((player) => player.id !== this.localId).map((player) => player.id));
    for (const [id, avatar] of this.avatars) {
      if (!livingIds.has(id)) {
        this.scene.remove(avatar.root);
        this.avatars.delete(id);
      }
    }
    for (const player of state.players) {
      if (player.id === this.localId) continue;
      let avatar = this.avatars.get(player.id);
      if (!avatar) {
        avatar = this.createAvatar(player);
        this.avatars.set(player.id, avatar);
        this.scene.add(avatar.root);
      }
      avatar.name = player.name;
      avatar.target.set(player.x, player.y, player.z);
      avatar.root.visible = player.alive && player.visibleToViewer;
      avatar.root.rotation.y = -player.yaw;
      avatar.body.scale.y = player.crouching ? 0.72 : 1;
    }
  }

  private updateDeviceMarker(state: GameState): void {
    if (!this.deviceMarker) {
      const marker = new THREE.Group();
      const red = new THREE.MeshStandardMaterial({ color: 0xe65d42, emissive: 0x8f1d12, emissiveIntensity: 1.2, metalness: 0.35, roughness: 0.4 });
      const dark = new THREE.MeshStandardMaterial({ color: 0x202728, metalness: 0.6, roughness: 0.5 });
      const core = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.2, 0.23), dark);
      const beacon = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.1, 0.09), red);
      beacon.position.y = 0.13;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.035, 6, 28), new THREE.MeshBasicMaterial({ color: 0xec7251, transparent: true, opacity: 0.72 }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.035;
      marker.add(core, beacon, ring);
      marker.visible = false;
      this.scene.add(marker);
      this.deviceMarker = marker;
    }
    const device = state.device;
    const visible = (device.status === "dropped" || device.status === "planted") && device.x !== null && device.z !== null;
    this.deviceMarker.visible = visible;
    if (visible) this.deviceMarker.position.set(device.x!, 0.06, device.z!);
  }

  private updateDroppedWeapons(weapons: DroppedWeapon[]): void {
    const liveIds = new Set(weapons.map((weapon) => weapon.id));
    for (const [id, marker] of this.droppedWeaponMarkers) {
      if (liveIds.has(id)) continue;
      this.scene.remove(marker);
      marker.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
      this.droppedWeaponMarkers.delete(id);
    }
    for (const weapon of weapons) {
      let marker = this.droppedWeaponMarkers.get(weapon.id);
      if (!marker) {
        marker = new THREE.Group();
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.1, 0.12), new THREE.MeshStandardMaterial({ color: 0x343c38, metalness: 0.68, roughness: 0.42 }));
        const stock = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.12, 0.18), new THREE.MeshStandardMaterial({ color: 0x806344, roughness: 0.76 }));
        const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.065, 0.065), new THREE.MeshStandardMaterial({ color: 0x222827, metalness: 0.78, roughness: 0.32 }));
        body.position.x = -0.03;
        stock.position.x = -0.38;
        barrel.position.x = 0.39;
        marker.add(body, stock, barrel);
        marker.rotation.x = -Math.PI / 2;
        this.scene.add(marker);
        this.droppedWeaponMarkers.set(weapon.id, marker);
      }
      marker.position.set(weapon.x, weapon.y + 0.16, weapon.z);
    }
  }

  handleEvent(event: ServerEvent): void {
    if (event.type === "shot") {
      this.addTracer(event.start, event.end, event.playerId === this.localId);
      if (event.playerId !== this.localId) this.playShotSound();
      if (event.playerId === this.localId) {
        this.gunKick = Math.min(1, this.gunKick + 0.72);
        this.flashMesh.material.opacity = 0.9;
        window.setTimeout(() => { this.flashMesh.material.opacity = 0; }, 52);
        const crosshair = document.querySelector<HTMLElement>(".crosshair");
        crosshair?.style.setProperty("--server-spread", `${event.spread * 120}px`);
        window.setTimeout(() => crosshair?.style.setProperty("--server-spread", "0px"), 145);
      }
      return;
    }
    if (event.type === "hit" && event.targetId === this.localId) {
      this.toastCallback("VOCÊ FOI ATINGIDO  -" + event.damage + (event.headshot ? "  /  TIRO NA CABEÇA" : ""));
      return;
    }
    if (event.type === "hit" && event.attackerId === this.localId) {
      this.toastCallback(event.headshot ? "TIRO NA CABEÇA" : "ACERTO  -" + event.damage);
      document.querySelector(".crosshair")?.classList.add("confirmed-hit");
      window.setTimeout(() => document.querySelector(".crosshair")?.classList.remove("confirmed-hit"), 135);
      return;
    }
    if (event.type === "weapon-switch" && event.playerId === this.localId) {
      this.weaponId = event.weapon;
      this.buildWeapon(event.weapon);
      return;
    }
    if (event.type === "reload" && event.playerId === this.localId) {
      this.toastCallback("RECARREGANDO");
    }
    if (event.type === "round-start") {
      this.pressed.clear();
      this.movementInput = { ...EMPTY_INPUT, yaw: this.yaw, pitch: this.pitch };
      this.localVerticalVelocity = 0;
      this.localGrounded = true;
      this.localVelocityX = 0;
      this.localVelocityZ = 0;
      this.jumpBufferSeconds = 0;
      this.localBurstShots = 0;
    }
  }

  captureMouse(): void {
    const local = this.currentState?.players.find((player) => player.id === this.localId);
    if (!this.pauseMenuOpen && !this.buyMenuOpen && local?.alive && this.currentState && ["WARMUP", "FREEZE_TIME", "ROUND_ACTIVE", "DEVICE_PLANTED"].includes(this.currentState.phase) && document.pointerLockElement !== this.canvas) {
      void this.canvas.requestPointerLock();
    }
  }

  clearConnection(): void {
    this.setPaused(false);
    this.setBuyMenu(false);
    this.currentState = null;
    this.localId = "";
    this.spectatingId = null;
    this.predictedReady = false;
    this.localVelocityX = 0;
    this.localVelocityZ = 0;
    this.localVerticalVelocity = 0;
    this.jumpBufferSeconds = 0;
    this.firing = false;
    for (const avatar of this.avatars.values()) this.scene.remove(avatar.root);
    this.avatars.clear();
    this.updateDroppedWeapons([]);
    if (this.deviceMarker) this.deviceMarker.visible = false;
  }

  private readonly onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === "Escape") {
      event.preventDefault();
      if (this.buyMenuOpen) {
        this.setBuyMenu(false);
        return;
      }
      if (!event.repeat && ["ROUND_ACTIVE", "DEVICE_PLANTED"].includes(this.currentState?.phase || "")) {
        if (this.pauseMenuOpen && performance.now() - this.pauseOpenedAt > 250) this.resume();
        else this.setPaused(true);
      }
      return;
    }
    if (this.pauseMenuOpen) return;
    if (event.code === "KeyB" && !event.repeat && this.currentState?.phase === "FREEZE_TIME") {
      event.preventDefault();
      this.setBuyMenu(!this.buyMenuOpen);
      return;
    }
    if (event.code === "KeyG" && !event.repeat && this.currentState?.players.find((player) => player.id === this.localId)?.hasDevice) {
      this.sendFn({ type: "drop-device" });
      return;
    }
    if (event.code === "Tab" && this.currentState && !["WAITING", "MATCH_END"].includes(this.currentState.phase)) {
      event.preventDefault();
      this.scoreBoardVisible = true;
      this.scoreboardCallback(true);
      return;
    }
    if (document.pointerLockElement !== this.canvas || !this.currentState) return;
    if (event.code === "Space") {
      event.preventDefault();
      if (!event.repeat) this.jumpPulse = true;
    }
    if (event.code === "Digit1") this.switchWeapon("AR12");
    if (event.code === "Digit2") this.switchWeapon("V9");
    if (event.code === "KeyR") this.sendFn({ type: "reload" });
    this.pressed.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === "Tab" && this.scoreBoardVisible) {
      this.scoreBoardVisible = false;
      this.scoreboardCallback(false);
    }
    this.pressed.delete(event.code);
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (this.pauseMenuOpen || document.pointerLockElement !== this.canvas) return;
    const sensitivity = 0.0021 * this.mouseSensitivity;
    this.yaw += event.movementX * sensitivity;
    const yDirection = this.invertY ? 1 : -1;
    this.pitch = Math.max(-1.42, Math.min(1.42, this.pitch + event.movementY * sensitivity * yDirection));
    this.mouseSwayX = THREE.MathUtils.clamp(this.mouseSwayX + event.movementX * 0.00013, -0.035, 0.035);
    this.mouseSwayY = THREE.MathUtils.clamp(this.mouseSwayY + event.movementY * 0.00012, -0.025, 0.025);
    this.pressed.add("MouseLocked");
  };

  private readonly onPointerLockChange = (): void => {
    if (document.pointerLockElement !== this.canvas) {
      this.pressed.delete("MouseLocked");
      this.firing = false;
      const local = this.currentState?.players.find((player) => player.id === this.localId);
      if (!this.pauseMenuOpen && !document.hidden && local?.alive && ["ROUND_ACTIVE", "DEVICE_PLANTED"].includes(this.currentState?.phase || "")) this.setPaused(true);
    }
  };

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.firing = false;
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    if (this.pauseMenuOpen) return;
    if (document.pointerLockElement !== this.canvas) {
      this.captureMouse();
      return;
    }
    if (this.buyMenuOpen || !["ROUND_ACTIVE", "DEVICE_PLANTED"].includes(this.currentState?.phase || "")) return;
    this.firing = true;
    this.ensureAudio();
    this.fireIfReady();
  };

  private readonly onMouseUp = (event: MouseEvent): void => {
    if (event.button === 0) this.firing = false;
  };

  private switchWeapon(weapon: WeaponId): void {
    if (this.weaponId === weapon) return;
    this.sendFn({ type: "weapon", weapon });
  }

  private readInput(): PlayerInput {
    const locked = document.pointerLockElement === this.canvas;
    const local = this.currentState?.players.find((player) => player.id === this.localId);
    if (this.pauseMenuOpen || this.buyMenuOpen || !locked || !this.currentState || !["WARMUP", "ROUND_ACTIVE", "DEVICE_PLANTED"].includes(this.currentState.phase) || !local?.alive) {
      return { ...EMPTY_INPUT, yaw: this.yaw, pitch: this.pitch };
    }
    return {
      forward: this.pressed.has("KeyW"),
      backward: this.pressed.has("KeyS"),
      left: this.pressed.has("KeyA"),
      right: this.pressed.has("KeyD"),
      walk: this.pressed.has("ShiftLeft") || this.pressed.has("ShiftRight"),
      crouch: this.pressed.has("ControlLeft") || this.pressed.has("ControlRight"),
      jump: this.jumpPulse,
      use: this.pressed.has("KeyE"),
      yaw: this.yaw,
      pitch: this.pitch,
    };
  }

  private fireIfReady(): void {
    const now = performance.now();
    const interval = this.weaponId === "AR12" ? 126 : 272;
    if (now < this.nextShotAt) return;
    this.nextShotAt = now + interval;
    if (now - this.lastLocalShotAt > 520) this.localBurstShots = 0;
    this.localBurstShots = Math.min(10, this.localBurstShots + 1);
    this.lastLocalShotAt = now;
    this.gunKick = Math.min(1, this.gunKick + 0.48);
    this.playShotSound();
    this.sendFn({ type: "shoot" });
  }

  private readonly animate = (): void => {
    const delta = Math.min(this.clock.getDelta(), 0.05);
    const now = performance.now();
    if (this.currentState && ["WARMUP", "FREEZE_TIME", "ROUND_ACTIVE", "DEVICE_PLANTED"].includes(this.currentState.phase) && this.localId) {
      const local = this.currentState.players.find((player) => player.id === this.localId);
      this.movementInput = this.readInput();
      const isMoving = !this.pauseMenuOpen && (this.movementInput.forward || this.movementInput.backward || this.movementInput.left || this.movementInput.right);
      const canMove = ["WARMUP", "ROUND_ACTIVE", "DEVICE_PLANTED"].includes(this.currentState.phase);
      if (canMove && !this.pauseMenuOpen && !this.buyMenuOpen && this.predictedReady && local?.alive) {
        const movement = movePlayer(
          { x: this.predicted.x, y: this.predicted.y, z: this.predicted.z },
          this.localVelocityX,
          this.localVelocityZ,
          this.localVerticalVelocity,
          this.localGrounded,
          this.jumpBufferSeconds,
          this.movementInput,
          delta,
          this.weaponId,
        );
        this.predicted.set(movement.position.x, movement.position.y, movement.position.z);
        this.localVelocityX = movement.velocityX;
        this.localVelocityZ = movement.velocityZ;
        this.localMaxSpeed = movement.maxSpeed;
        this.localVerticalVelocity = movement.velocityY;
        this.localGrounded = movement.grounded;
        this.jumpBufferSeconds = movement.jumpBufferSeconds;
      }
      const bob = isMoving && this.localGrounded ? Math.sin(now * 0.012) * 0.018 : 0;
      this.gunRoot.visible = !!local?.alive;
      if (local?.alive) {
        const targetCameraY = this.predicted.y + (this.movementInput.crouch ? 1.12 : 1.58) + bob;
        this.camera.position.set(this.predicted.x, THREE.MathUtils.damp(this.camera.position.y, targetCameraY, 16, delta), this.predicted.z);
        this.camera.rotation.set(this.pitch, -this.yaw, 0);
      } else if (local) {
        let target = this.currentState.players.find((player) => player.id === this.spectatingId && player.alive && player.team === local.team && player.visibleToViewer);
        if (!target) {
          target = this.currentState.players.find((player) => player.id !== local.id && player.alive && player.team === local.team && player.visibleToViewer);
          this.spectatingId = target?.id || null;
        }
        if (target) {
          this.camera.position.set(target.x, THREE.MathUtils.damp(this.camera.position.y, target.y + 1.58, 14, delta), target.z);
          this.camera.rotation.set(target.pitch, -target.yaw, 0);
        } else {
          this.camera.position.set(local.x, local.y + 1.58, local.z);
        }
      }
      if (!this.pauseMenuOpen && !this.buyMenuOpen && local?.alive && now - this.lastInputAt >= 32) {
        this.sendFn({ type: "input", input: this.movementInput });
        this.lastInputAt = now;
        this.jumpPulse = false;
      }
      if (!this.pauseMenuOpen && !this.buyMenuOpen && this.firing && local?.alive && ["ROUND_ACTIVE", "DEVICE_PLANTED"].includes(this.currentState.phase)) this.fireIfReady();
      this.flashMesh.material.opacity = Math.max(0, this.flashMesh.material.opacity - delta * 9);
    }
    this.gunKick = Math.max(0, this.gunKick - delta * 3.6);
    const movingGun = !this.pauseMenuOpen && (this.movementInput.forward || this.movementInput.backward || this.movementInput.left || this.movementInput.right);
    const bobGun = movingGun ? Math.sin(now * 0.012) * 0.012 : 0;
    this.gunRoot.position.set(this.mouseSwayX, bobGun - this.gunKick * 0.045 + this.mouseSwayY, this.gunKick * 0.12);
    this.mouseSwayX *= Math.exp(-8 * delta);
    this.mouseSwayY *= Math.exp(-8 * delta);
    for (const avatar of this.avatars.values()) {
      avatar.root.position.lerp(avatar.target, 1 - Math.exp(-13 * delta));
    }
    for (let i = this.tracers.length - 1; i >= 0; i -= 1) {
      if (now >= this.tracers[i].expires) {
        this.scene.remove(this.tracers[i].line);
        this.tracers[i].line.geometry.dispose();
        (this.tracers[i].line.material as THREE.Material).dispose();
        this.tracers.splice(i, 1);
      }
    }
    this.renderer.render(this.scene, this.camera);
    const instantaneousFps = delta > 0 ? 1 / delta : this.smoothedFps;
    this.smoothedFps += (instantaneousFps - this.smoothedFps) * 0.08;
    if (now - this.lastOverlayUpdateAt >= 120) {
      this.lastOverlayUpdateAt = now;
      const horizontalSpeed = Math.hypot(this.localVelocityX, this.localVelocityZ);
      const accuracy = calculateWeaponAccuracy({
        horizontalSpeed,
        grounded: this.localGrounded,
        crouching: this.movementInput.crouch,
        weapon: this.weaponId,
        burstShots: this.localBurstShots,
      });
      const crosshair = document.querySelector<HTMLElement>(".crosshair");
      if (crosshair) {
        const motion = this.dynamicCrosshair ? accuracy.movementPenalty * 9 + accuracy.airPenalty * 90 : 0;
        const burst = this.dynamicCrosshair ? accuracy.burstPenalty * 100 : 0;
        crosshair.style.setProperty("--crosshair-gap", `${4 + motion + burst}px`);
      }
      const movementText = this.movementDebugEnabled
        ? `VELOCIDADE ${horizontalSpeed.toFixed(2)} m/s  ·  MÁX ${this.localMaxSpeed.toFixed(2)} m/s\nPENALIDADE ${Math.round(accuracy.movementPenalty * 100)}%  ·  DISPERSÃO BASE ${(accuracy.baseSpread * 57.3).toFixed(2)}°  ·  FINAL ${(accuracy.finalSpread * 57.3).toFixed(2)}°\n${this.localGrounded ? "NO CHÃO" : "NO AR"}  ·  ${this.movementInput.crouch ? "AGACHADO" : "EM PÉ"}`
        : null;
      const memory = this.renderer.info.memory;
      const browserMemory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
      const heapText = browserMemory ? `  ·  MEMÓRIA ${(browserMemory.usedJSHeapSize / 1_048_576).toFixed(0)} MB` : "";
      const performanceText = this.performanceOverlayEnabled
        ? `FPS ${Math.round(this.smoothedFps)}  ·  DESENHOS ${this.renderer.info.render.calls}  ·  TRIÂNGULOS ${this.renderer.info.render.triangles}\nGEOMETRIAS ${memory.geometries}  ·  TEXTURAS ${memory.textures}${heapText}  ·  TICK DO SERVIDOR 20/s`
        : null;
      this.telemetryCallback(movementText, performanceText);
    }
  };

  private localVerticalVelocity = 0;
  private localGrounded = true;

  private createWorld(): void {
    const hemi = new THREE.HemisphereLight(0xbcc8cc, 0x30302a, 2.15);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffdca0, 3.3);
    key.position.set(-10, 22, -8);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -30;
    key.shadow.camera.right = 30;
    key.shadow.camera.top = 30;
    key.shadow.camera.bottom = -30;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 55;
    key.shadow.bias = -0.00035;
    key.shadow.normalBias = 0.025;
    key.shadow.radius = 3;
    this.keyLight = key;
    this.scene.add(key);
    const cool = new THREE.PointLight(0x65a4ad, 65, 48, 1.7);
    cool.position.set(12, 8, 6);
    this.pointLights.push(cool);
    this.scene.add(cool);

    const floorTexture = this.createFloorTexture();
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(54, 54),
      new THREE.MeshStandardMaterial({ color: 0x9aa19a, map: floorTexture, roughness: 0.94, metalness: 0.08 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.035;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(50, 50, 0x53615d, 0x424c49);
    grid.position.y = 0.006;
    const gridMat = grid.material as THREE.Material;
    gridMat.transparent = true;
    gridMat.opacity = 0.24;
    this.scene.add(grid);

    const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x222a2c, roughness: 0.82, metalness: 0.26 });
    this.addBox(52, 5, 1, 0, 2.5, -26, wallMaterial);
    this.addBox(52, 5, 1, 0, 2.5, 26, wallMaterial);
    this.addBox(1, 5, 52, -26, 2.5, 0, wallMaterial);
    this.addBox(1, 5, 52, 26, 2.5, 0, wallMaterial);
    this.addWallStrip(-25.46, -17);
    this.addWallStrip(25.46, 16);
    this.addWallStrip(-9, -25.46, true);
    this.addWallStrip(13, 25.46, true);

    const containerMat = new THREE.MeshStandardMaterial({ color: 0x42524e, roughness: 0.72, metalness: 0.34 });
    const crateMat = new THREE.MeshStandardMaterial({ color: 0x6b5b43, roughness: 0.88, metalness: 0.12 });
    COLLIDERS.forEach((rect, index) => {
      const width = rect.maxX - rect.minX;
      const depth = rect.maxZ - rect.minZ;
      const material = index % 2 === 0 ? containerMat : crateMat;
      const height = index === 0 ? 3.15 : 2.5;
      const x = (rect.minX + rect.maxX) / 2;
      const z = (rect.minZ + rect.maxZ) / 2;
      this.addBox(width, height, depth, x, height / 2, z, material);
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(width, height, depth)),
        new THREE.LineBasicMaterial({ color: index % 2 === 0 ? 0xa99a68 : 0x9b7950, transparent: true, opacity: 0.34 }),
      );
      edges.position.set(x, height / 2, z);
      this.scene.add(edges);
      for (let stripe = 0; stripe < 4; stripe += 1) {
        const line = new THREE.Mesh(
          new THREE.BoxGeometry(0.045, height * 0.84, 0.035),
          new THREE.MeshStandardMaterial({ color: 0xc49b47, emissive: 0x35220b, roughness: 0.45 }),
        );
        line.position.set(rect.minX + 0.42 + stripe * Math.max(0.7, width / 5), height / 2, rect.minZ - 0.025);
        this.scene.add(line);
      }
      if (index % 2 === 0) this.addTopMark(x, z, width, depth);
    });

    for (let i = 0; i < 16; i += 1) {
      const x = -23 + (i % 4) * 15.3;
      const z = -22 + Math.floor(i / 4) * 14.4;
      if (i % 3 === 0) this.addLamp(x, z);
      this.addGroundMark(x, z, i);
    }

    const siteA = this.createSiteMarker(-17, 0x4d9b91, "A");
    siteA.position.set(-17, 0.035, -7);
    const siteB = this.createSiteMarker(17, 0xc38b43, "B");
    siteB.position.set(17, 0.035, 7);

    const lanePaint = new THREE.MeshStandardMaterial({ color: 0x9b7434, roughness: 0.78, metalness: 0.12 });
    for (const x of [-21, 21]) {
      this.addBox(0.07, 0.012, 45, x, 0.014, 0, lanePaint);
      for (let z = -20; z <= 20; z += 4) this.addBox(0.27, 0.014, 0.7, x, 0.016, z, lanePaint);
    }

    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh && !object.material.transparent) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });
  }

  private createFloorTexture(): THREE.CanvasTexture {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext("2d");
    if (context) {
      context.fillStyle = "#555b55";
      context.fillRect(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < 2300; i += 1) {
        const shade = Math.random() > 0.55 ? 115 : 41;
        context.fillStyle = `rgba(${shade},${shade + 4},${shade},${Math.random() * 0.12})`;
        const width = 1 + Math.random() * 5;
        const height = 1 + Math.random() * 3;
        context.fillRect(Math.random() * canvas.width, Math.random() * canvas.height, width, height);
      }
      context.strokeStyle = "rgba(25,31,30,.26)";
      context.lineWidth = 1;
      for (let x = 0; x < 512; x += 64) {
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, 512);
        context.stroke();
      }
      for (let y = 0; y < 512; y += 64) {
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(512, y);
        context.stroke();
      }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(8, 8);
    return texture;
  }

  private addBox(width: number, height: number, depth: number, x: number, y: number, z: number, material: THREE.Material): void {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
    mesh.position.set(x, y, z);
    this.scene.add(mesh);
  }

  private addWallStrip(x: number, z: number, alongX = false): void {
    const mat = new THREE.MeshBasicMaterial({ color: 0xb08439, transparent: true, opacity: 0.52 });
    const strip = new THREE.Mesh(new THREE.BoxGeometry(alongX ? 5 : 0.055, 0.055, alongX ? 0.055 : 5), mat);
    strip.position.set(x, 0.045, z);
    this.scene.add(strip);
  }

  private addTopMark(x: number, z: number, width: number, depth: number): void {
    const labelCanvas = document.createElement("canvas");
    labelCanvas.width = 256;
    labelCanvas.height = 96;
    const ctx = labelCanvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "rgba(8,12,13,.78)";
    ctx.fillRect(0, 0, 256, 96);
    ctx.fillStyle = "#e3ae4d";
    ctx.font = "700 38px monospace";
    ctx.fillText("SP // 0" + (Math.floor(Math.abs(x + z)) % 9 + 1), 22, 61);
    const texture = new THREE.CanvasTexture(labelCanvas);
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(Math.max(1.2, Math.min(width - 0.4, 3)), Math.max(0.65, Math.min(depth - 0.4, 1))),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide }),
    );
    sign.position.set(x, 2.65, z);
    sign.rotation.x = -Math.PI / 2;
    this.scene.add(sign);
  }

  private addLamp(x: number, z: number): void {
    const postMat = new THREE.MeshStandardMaterial({ color: 0x202729, metalness: 0.7, roughness: 0.4 });
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.12, 3.8, 8), postMat);
    post.position.set(x, 1.9, z);
    this.scene.add(post);
    const fixture = new THREE.Mesh(
      new THREE.BoxGeometry(0.62, 0.12, 0.25),
      new THREE.MeshStandardMaterial({ color: 0xc4b879, emissive: 0x82612b, emissiveIntensity: 0.8 }),
    );
    fixture.position.set(x, 3.85, z);
    this.scene.add(fixture);
    const light = new THREE.PointLight(0xbac4a2, 11, 9, 2);
    light.position.set(x, 3.7, z);
    this.pointLights.push(light);
    this.scene.add(light);
  }

  private addGroundMark(x: number, z: number, index: number): void {
    const color = index % 2 ? 0x9b7434 : 0x75827a;
    const mark = new THREE.Mesh(
      new THREE.BoxGeometry(index % 2 ? 1.2 : 2.6, 0.012, 0.055),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45 }),
    );
    mark.position.set(x, 0.015, z);
    mark.rotation.y = index % 2 ? 0.7 : -0.12;
    this.scene.add(mark);
  }

  private createSiteMarker(x: number, color: number, letter: string): THREE.Group {
    const group = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.7, 1.84, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    group.add(ring);
    const c = document.createElement("canvas");
    c.width = 128;
    c.height = 128;
    const ctx = c.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#e8b85c";
      ctx.font = "bold 86px monospace";
      ctx.textAlign = "center";
      ctx.fillText(letter, 64, 91);
    }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
    sprite.scale.set(1.05, 1.05, 1);
    sprite.position.y = 1.9;
    group.add(sprite);
    return group;
  }

  private createAvatar(player: PublicPlayer): Avatar {
    const root = new THREE.Group();
    const primary = new THREE.MeshStandardMaterial({ color: player.team === "ALPHA" ? 0x786039 : 0x395d68, roughness: 0.76, metalness: 0.28 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1a2225, roughness: 0.54, metalness: 0.42 });
    const team = new THREE.MeshStandardMaterial({ color: TEAM_COLORS[player.team], emissive: TEAM_COLORS[player.team], emissiveIntensity: 0.11, roughness: 0.5 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.78, 4, 9), primary);
    body.position.y = 0.9;
    root.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.245, 12, 10), dark);
    head.position.y = 1.54;
    root.add(head);
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.26, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.56), team);
    helmet.position.y = 1.63;
    root.add(helmet);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.29, 0.075, 0.11), dark);
    visor.position.set(0, 1.57, -0.205);
    root.add(visor);
    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.42, 0.21), dark);
    chest.position.set(0, 1.02, -0.13);
    root.add(chest);
    const shoulder = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.12, 0.25), team);
    shoulder.position.set(0, 1.25, -0.11);
    root.add(shoulder);
    const backpack = new THREE.Mesh(new THREE.BoxGeometry(0.43, 0.48, 0.2), dark);
    backpack.position.set(0, 1.03, 0.19);
    root.add(backpack);
    const vestPlate = new THREE.Mesh(new THREE.BoxGeometry(0.49, 0.31, 0.045), primary);
    vestPlate.position.set(0, 1.03, -0.25);
    root.add(vestPlate);
    for (const side of [-1, 1]) {
      const pouch = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.15, 0.09), dark);
      pouch.position.set(side * 0.19, 0.82, -0.255);
      root.add(pouch);
      const shoulderPad = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.16, 0.28), team);
      shoulderPad.position.set(side * 0.39, 1.2, -0.1);
      root.add(shoulderPad);
    }
    const rifle = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.12, 0.82), dark);
    rifle.position.set(0.33, 1.11, -0.35);
    root.add(rifle);
    const name = this.createNameSprite(player.name, player.team);
    name.position.y = 2.13;
    name.scale.set(1.65, 0.31, 1);
    root.add(name);
    root.position.set(player.x, player.y, player.z);
    root.rotation.y = -player.yaw;
    root.traverse((object) => {
      if (object instanceof THREE.Mesh && !object.material.transparent) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });
    return { root, target: new THREE.Vector3(player.x, player.y, player.z), body, name: player.name };
  }

  private createNameSprite(label: string, team: "ALPHA" | "BRAVO"): THREE.Sprite {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 96;
    const ctx = c.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "rgba(7,10,12,.7)";
      ctx.fillRect(28, 13, 456, 70);
      ctx.fillStyle = team === "ALPHA" ? "#e9b452" : "#72c6e2";
      ctx.fillRect(28, 13, 5, 70);
      ctx.font = "600 31px Arial";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#f1f0e9";
      ctx.fillText(label.toUpperCase(), 52, 48);
    }
    const texture = new THREE.CanvasTexture(c);
    texture.colorSpace = THREE.SRGBColorSpace;
    return new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, sizeAttenuation: true }));
  }

  private buildWeapon(weapon: WeaponId): void {
    while (this.gunRoot.children.length) {
      const child = this.gunRoot.children[0];
      if (child) this.gunRoot.remove(child);
    }
    const isRifle = weapon === "AR12";
    const metal = new THREE.MeshStandardMaterial({ color: isRifle ? 0x333c3e : 0x414849, roughness: 0.39, metalness: 0.72 });
    const grip = new THREE.MeshStandardMaterial({ color: 0x171b1c, roughness: 0.78 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xb37e2d, roughness: 0.5, metalness: 0.5 });
    const bodyLength = isRifle ? 0.66 : 0.39;
    const body = new THREE.Mesh(new THREE.BoxGeometry(isRifle ? 0.13 : 0.16, 0.15, bodyLength), metal);
    body.position.set(0.36, -0.28, -0.56);
    this.gunRoot.add(body);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.027, 0.027, isRifle ? 0.34 : 0.15, 8), grip);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0.36, -0.25, -0.99);
    this.gunRoot.add(barrel);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.22, 0.11), grip);
    handle.position.set(0.35, -0.42, -0.51);
    handle.rotation.x = -0.23;
    this.gunRoot.add(handle);
    if (isRifle) {
      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.3), grip);
      stock.position.set(0.36, -0.27, -0.11);
      this.gunRoot.add(stock);
      const magazine = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.22, 0.12), grip);
      magazine.position.set(0.36, -0.44, -0.55);
      this.gunRoot.add(magazine);
    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.055, 0.16), accent);
      sight.position.set(0.36, -0.17, -0.53);
      this.gunRoot.add(sight);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.022, 0.49), grip);
      rail.position.set(0.36, -0.18, -0.61);
      this.gunRoot.add(rail);
      const optic = new THREE.Mesh(new THREE.CylinderGeometry(0.047, 0.047, 0.09, 10), grip);
      optic.rotation.x = Math.PI / 2;
      optic.position.set(0.36, -0.12, -0.54);
      this.gunRoot.add(optic);
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.031, 12), new THREE.MeshBasicMaterial({ color: 0x83b2b2, transparent: true, opacity: 0.8 }));
      lens.position.set(0.36, -0.12, -0.592);
      this.gunRoot.add(lens);
      const foregrip = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.15, 0.09), grip);
      foregrip.position.set(0.36, -0.38, -0.77);
      this.gunRoot.add(foregrip);
    }
    const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.065, 8), accent);
    muzzle.rotation.x = Math.PI / 2;
    muzzle.position.set(0.36, -0.25, isRifle ? -1.17 : -0.97);
    this.gunRoot.add(muzzle);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.16, bodyLength * 0.65), accent);
    stripe.position.set(0.43, -0.27, -0.56);
    this.gunRoot.add(stripe);
    this.updateWeaponName(weapon);
  }

  private updateWeaponName(weapon: WeaponId): void {
    const name = document.getElementById("weapon-name");
    if (name) name.textContent = weapon === "AR12" ? "AR-12 / FUZIL DE ASSALTO" : "V9 / PISTOLA";
  }

  private addTracer(start: PlayerPosition, end: PlayerPosition, local: boolean): void {
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(start.x, start.y, start.z),
      new THREE.Vector3(end.x, end.y, end.z),
    ]);
    const material = new THREE.LineBasicMaterial({
      color: local ? 0xffd071 : 0x8cc7ce,
      transparent: true,
      opacity: local ? 0.78 : 0.56,
      depthWrite: false,
    });
    const line = new THREE.Line(geometry, material);
    this.scene.add(line);
    this.tracers.push({ line, expires: performance.now() + 68 });
  }

  private ensureAudio(): void {
    if (!this.context) {
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioContextClass) this.context = new AudioContextClass();
    }
    if (this.context?.state === "suspended") void this.context.resume();
  }

  private playShotSound(): void {
    if (!this.context) return;
    const osc = this.context.createOscillator();
    const gain = this.context.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(120 + Math.random() * 36, this.context.currentTime);
    osc.frequency.exponentialRampToValueAtTime(44, this.context.currentTime + 0.075);
    gain.gain.setValueAtTime(0.035, this.context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.context.currentTime + 0.09);
    osc.connect(gain).connect(this.context.destination);
    osc.start();
    osc.stop(this.context.currentTime + 0.1);
  }
}

import * as THREE from "three";
import { COLLIDERS, movePlayer } from "../../../shared/src/movement";
import { EMPTY_INPUT, type GameState, type PlayerInput, type PlayerPosition, type PublicPlayer, type ServerEvent, type WeaponId } from "../../../shared/src/protocol";

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

const TEAM_COLORS = { ALPHA: 0xe6a536, BRAVO: 0x52a6c9 };

export class GameClient {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.08, 120);
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  private readonly clock = new THREE.Clock();
  private readonly avatars = new Map<string, Avatar>();
  private readonly tracers: Tracer[] = [];
  private readonly pressed = new Set<string>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly gunRoot = new THREE.Group();
  private readonly flashMesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private localId = "";
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
  private scoreboardCallback: (visible: boolean) => void = () => undefined;
  private toastCallback: (message: string) => void = () => undefined;
  private context: AudioContext | null = null;
  private localName = "PLAYER";

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.14;
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

  setCallbacks(callbacks: { scoreboard?: (visible: boolean) => void; toast?: (message: string) => void }): void {
    this.scoreboardCallback = callbacks.scoreboard || (() => undefined);
    this.toastCallback = callbacks.toast || (() => undefined);
  }

  setIdentity(playerId: string, name: string): void {
    this.localId = playerId;
    this.localName = name;
  }

  setState(state: GameState): void {
    this.currentState = state;
    const local = state.players.find((player) => player.id === this.localId);
    if (local) {
      const authoritative = new THREE.Vector3(local.x, local.y, local.z);
      if (!this.predictedReady) {
        this.predicted.copy(authoritative);
        this.predictedReady = true;
      } else {
        this.predicted.lerp(authoritative, 0.28);
      }
      if (!this.pressed.has("MouseLocked")) {
        this.yaw = local.yaw;
      }
      this.weaponId = local.weapon;
      this.updateWeaponName(local.weapon);
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
      avatar.root.visible = player.alive;
      avatar.root.rotation.y = -player.yaw;
      avatar.body.scale.y = player.crouching ? 0.72 : 1;
    }
  }

  handleEvent(event: ServerEvent): void {
    if (event.type === "shot") {
      this.addTracer(event.start, event.end, event.playerId === this.localId);
      if (event.playerId !== this.localId) this.playShotSound();
      if (event.playerId === this.localId) {
        this.flashMesh.material.opacity = 0.9;
        window.setTimeout(() => { this.flashMesh.material.opacity = 0; }, 52);
      }
      return;
    }
    if (event.type === "hit" && event.targetId === this.localId) {
      this.toastCallback("TAKING FIRE  -" + event.damage + (event.headshot ? "  /  HEADSHOT" : ""));
      return;
    }
    if (event.type === "hit" && event.attackerId === this.localId) {
      this.toastCallback(event.headshot ? "HEADSHOT" : "HIT  -" + event.damage);
      return;
    }
    if (event.type === "weapon-switch" && event.playerId === this.localId) {
      this.weaponId = event.weapon;
      this.buildWeapon(event.weapon);
      return;
    }
    if (event.type === "reload" && event.playerId === this.localId) {
      this.toastCallback("RELOADING");
    }
    if (event.type === "round-start") {
      this.pressed.clear();
      this.movementInput = { ...EMPTY_INPUT, yaw: this.yaw, pitch: this.pitch };
      this.localVerticalVelocity = 0;
      this.localGrounded = true;
    }
  }

  captureMouse(): void {
    if (this.currentState?.phase === "ROUND_ACTIVE" && document.pointerLockElement !== this.canvas) {
      void this.canvas.requestPointerLock();
    }
  }

  clearConnection(): void {
    this.currentState = null;
    this.localId = "";
    this.predictedReady = false;
    this.firing = false;
    for (const avatar of this.avatars.values()) this.scene.remove(avatar.root);
    this.avatars.clear();
  }

  private readonly onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === "Tab" && this.currentState?.phase === "ROUND_ACTIVE") {
      event.preventDefault();
      this.scoreBoardVisible = true;
      this.scoreboardCallback(true);
      return;
    }
    if (event.code === "Escape") {
      this.firing = false;
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
    if (document.pointerLockElement !== this.canvas) return;
    const sensitivity = Number(localStorage.getItem("strikepoint_sensitivity") || "0.0021");
    this.yaw -= event.movementX * sensitivity;
    this.pitch = Math.max(-1.42, Math.min(1.42, this.pitch - event.movementY * sensitivity));
    this.pressed.add("MouseLocked");
  };

  private readonly onPointerLockChange = (): void => {
    if (document.pointerLockElement !== this.canvas) {
      this.pressed.delete("MouseLocked");
      this.firing = false;
    }
  };

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.firing = false;
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    if (document.pointerLockElement !== this.canvas) {
      this.captureMouse();
      return;
    }
    if (this.currentState?.phase !== "ROUND_ACTIVE") return;
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
    if (!locked || !this.currentState || this.currentState.phase !== "ROUND_ACTIVE" || !local?.alive) {
      return { ...EMPTY_INPUT, yaw: this.yaw, pitch: this.pitch };
    }
    return {
      forward: this.pressed.has("KeyW"),
      backward: this.pressed.has("KeyS"),
      left: this.pressed.has("KeyA"),
      right: this.pressed.has("KeyD"),
      sprint: this.pressed.has("ShiftLeft") || this.pressed.has("ShiftRight"),
      crouch: this.pressed.has("ControlLeft") || this.pressed.has("ControlRight"),
      jump: this.jumpPulse,
      yaw: this.yaw,
      pitch: this.pitch,
    };
  }

  private fireIfReady(): void {
    const now = performance.now();
    const interval = this.weaponId === "AR12" ? 126 : 272;
    if (now < this.nextShotAt) return;
    this.nextShotAt = now + interval;
    this.playShotSound();
    this.sendFn({ type: "shoot" });
  }

  private readonly animate = (): void => {
    const delta = Math.min(this.clock.getDelta(), 0.05);
    const now = performance.now();
    if (this.currentState?.phase === "ROUND_ACTIVE" && this.localId) {
      const local = this.currentState.players.find((player) => player.id === this.localId);
      this.movementInput = this.readInput();
      if (this.predictedReady && local?.alive) {
        const movement = movePlayer(
          { x: this.predicted.x, y: this.predicted.y, z: this.predicted.z },
          this.localVerticalVelocity,
          this.localGrounded,
          this.movementInput,
          delta,
        );
        this.predicted.set(movement.position.x, movement.position.y, movement.position.z);
        this.localVerticalVelocity = movement.velocityY;
        this.localGrounded = movement.grounded;
      }
      this.camera.position.set(this.predicted.x, this.predicted.y + (this.movementInput.crouch ? 1.12 : 1.58), this.predicted.z);
      this.camera.rotation.set(this.pitch, -this.yaw, 0);
      if (local?.alive && now - this.lastInputAt >= 32) {
        this.sendFn({ type: "input", input: this.movementInput });
        this.lastInputAt = now;
        this.jumpPulse = false;
      }
      if (this.firing && local?.alive) this.fireIfReady();
      this.flashMesh.material.opacity = Math.max(0, this.flashMesh.material.opacity - delta * 9);
    }
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
  };

  private localVerticalVelocity = 0;
  private localGrounded = true;

  private createWorld(): void {
    const hemi = new THREE.HemisphereLight(0xbcc8cc, 0x30302a, 2.15);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffdca0, 3.3);
    key.position.set(-10, 22, -8);
    this.scene.add(key);
    const cool = new THREE.PointLight(0x65a4ad, 65, 48, 1.7);
    cool.position.set(12, 8, 6);
    this.scene.add(cool);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(54, 54),
      new THREE.MeshStandardMaterial({ color: 0x333a3a, roughness: 0.95, metalness: 0.04 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.035;
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
    const rifle = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.12, 0.82), dark);
    rifle.position.set(0.33, 1.11, -0.35);
    root.add(rifle);
    const name = this.createNameSprite(player.name, player.team);
    name.position.y = 2.13;
    name.scale.set(1.65, 0.31, 1);
    root.add(name);
    root.position.set(player.x, player.y, player.z);
    root.rotation.y = -player.yaw;
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
    }
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.16, bodyLength * 0.65), accent);
    stripe.position.set(0.43, -0.27, -0.56);
    this.gunRoot.add(stripe);
    this.updateWeaponName(weapon);
  }

  private updateWeaponName(weapon: WeaponId): void {
    const name = document.getElementById("weapon-name");
    if (name) name.textContent = weapon === "AR12" ? "AR-12 / ASSAULT RIFLE" : "V9 / SIDEARM";
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

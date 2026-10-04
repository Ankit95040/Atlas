/// <reference lib="dom" />
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { IslandScene } from "./scene.js";
import { diffIslandScenes, TRANSITION_MS, type VisualTransition } from "./transitions.js";

// Client-side 3D projector for the Atlas Island (M25.1). Runs in the browser
// only; consumes an IslandScene descriptor embedded by the server and renders
// it with three.js. No fetching, no sockets, no state writes, no animation
// loops: renders on demand (initial paint, data refresh, user orbit).
// Reduced motion is trivially satisfied — nothing ever moves on its own.

const STATUS_COLORS: Record<string, number> = {
  COMPLETED: 0x2ea043,
  COMPLETED_EMPTY: 0x6e7681,
  FAILED: 0xf85149,
  CLAIMED: 0x2f7cf6,
  IN_PROGRESS: 0x2f7cf6,
  VERIFICATION: 0xd29922,
  READY: 0x3a4556,
  PENDING: 0x3a4556,
  BLOCKED: 0x3a4556,
  CANCELLED: 0x3a4556,
};

function statusColor(status: string): number {
  return STATUS_COLORS[status] ?? 0x8b949e;
}

// M27.5 semantic masses: body color IS the execution state (spec §5).
// Cached per status — one material per state per scene, not per building.
const bodyMats = new Map<string, THREE.Material>();
function bodyMat(status: string): THREE.Material {
  const hit = bodyMats.get(status);
  if (hit !== undefined) {
    return hit;
  }
  let mat: THREE.Material;
  switch (status) {
    case "COMPLETED":
      mat = new THREE.MeshStandardMaterial({ color: 0x2ea043, roughness: 1 });
      break;
    case "IN_PROGRESS":
    case "CLAIMED":
      mat = new THREE.MeshStandardMaterial({ color: 0x2f7cf6, roughness: 0.8 });
      break;
    case "VERIFICATION":
      mat = new THREE.MeshStandardMaterial({ color: 0xd29922, roughness: 0.85 });
      break;
    case "FAILED":
      mat = new THREE.MeshStandardMaterial({ color: 0xf85149, roughness: 0.9 });
      break;
    case "COMPLETED_EMPTY":
      mat = new THREE.MeshStandardMaterial({ color: 0x6e7681, roughness: 1, transparent: true, opacity: 0.28 });
      break;
    default:
      mat = new THREE.MeshStandardMaterial({ color: 0x3a4556, roughness: 0.95 });
      break;
  }
  bodyMats.set(status, mat);
  return mat;
}

// Worker units: color carries worker status (RUNNING blue, FAILED red,
// anything else graphite); opacity carries M23.1 live/historical link.
const workerMats = new Map<string, THREE.Material>();
function workerMat(status: string, live: boolean): THREE.Material {
  const key = `${status}:${live ? "live" : "hist"}`;
  const hit = workerMats.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const color = status === "RUNNING" ? 0x2f7cf6 : status === "FAILED" ? 0xf85149 : 0x3a4556;
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.5,
    metalness: 0.6,
    transparent: !live,
    opacity: live ? 1 : 0.45,
  });
  workerMats.set(key, mat);
  return mat;
}

function makeLabel(text: string, size = 42): THREE.Sprite {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new Error("2d canvas unavailable");
  }
  ctx.font = `600 ${size}px system-ui, sans-serif`;
  const width = Math.ceil(ctx.measureText(text).width) + 28;
  canvas.width = width;
  canvas.height = size + 28;
  const redrawn = canvas.getContext("2d");
  if (redrawn === null) {
    throw new Error("2d canvas unavailable");
  }
  redrawn.font = `600 ${size}px system-ui, sans-serif`;
  redrawn.fillStyle = "rgba(10,14,20,0.78)";
  redrawn.fillRect(0, 0, canvas.width, canvas.height);
  redrawn.fillStyle = "#e6edf3";
  redrawn.textBaseline = "middle";
  redrawn.fillText(text, 14, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(canvas.width / 46, canvas.height / 46, 1);
  return sprite;
}

export interface IslandPick {
  readonly kind: string;
  readonly id?: string;
}

export interface IslandRendererOptions {
  // When provided, clicks report the picked entity instead of navigating to
  // SSR routes (default behavior preserved when omitted). Lets the React
  // workspace implement selection without forking the projector.
  readonly onPick?: (pick: IslandPick | null) => void;
}

export interface IslandRenderer {
  readonly update: (scene: IslandScene) => void;
  readonly play: (transitions: VisualTransition[]) => Promise<void>;
  // Accent outline on one entity (selection feedback only; no state change).
  // Null clears. Survives update() rebuilds; unknown ids clear silently.
  readonly select: (kind: string | null, id?: string) => void;
  // Explicit camera motion only: focus an entity (or null = home framing).
  // Ordinary selection never calls this; the Focus action and Reset do.
  readonly focus: (kind: string | null, id?: string) => void;
  readonly resetView: () => void;
  readonly describe: () => { camera: string; position: string; objects: number; pixelRatio: number };
  readonly dispose: () => void;
}

const reducedMotion =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function tween(ms: number, fn: (k: number) => void, render: () => void): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now();
    const frame = (now: number): void => {
      const raw = Math.min(1, (now - start) / ms);
      const k = raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2;
      fn(k);
      render();
      if (raw < 1) {
        requestAnimationFrame(frame);
      } else {
        resolve();
      }
    };
    requestAnimationFrame(frame);
  });
}

export function createIslandRenderer(canvas: HTMLCanvasElement, opts: IslandRendererOptions = {}): IslandRenderer {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a121c);
  scene.fog = new THREE.Fog(0x0a121c, 90, 220);

  const camera = new THREE.OrthographicCamera(-30, 30, 22, -22, 0.1, 500);
  camera.position.set(34, 34, 34);
  camera.lookAt(0, 0, 4);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  controls.enablePan = true;
  controls.minZoom = 0.4;
  controls.maxZoom = 4;
  // M27.7.3 constrained orbit: the designed view sits at polar ≈0.94 rad.
  // Clamping elevation keeps the island readable at every orbit extreme —
  // no top-down plate, no edge-on sliver (M27.7.2 disappearance defect).
  // rotateSpeed below default trades swing for control-room precision.
  controls.minPolarAngle = 0.7;
  controls.maxPolarAngle = 1.25;
  controls.rotateSpeed = 0.55;
  controls.addEventListener("change", () => {
    renderer.render(scene, camera);
  });

  // Restrained picking (M25.3): click navigates to existing detail routes,
  // hover only changes the cursor. No mutations, no new endpoints, no drag
  // actions — a drag orbits instead of navigating (movement threshold).
  let currentRunId = "";
  const picker = new THREE.Raycaster();
  const pointerClip = new THREE.Vector2();
  const findEntity = (clientX: number, clientY: number): { kind: string; id?: string } | null => {
    const rect = canvas.getBoundingClientRect();
    pointerClip.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    picker.setFromCamera(pointerClip, camera);
    const hits = picker.intersectObjects(world.children, true);
    for (const hit of hits) {
      let node: THREE.Object3D | null = hit.object;
      while (node !== null) {
        const entity = (node.userData as { entity?: { kind: string; id?: string } }).entity;
        if (entity !== undefined) {
          return entity;
        }
        node = node.parent;
      }
    }
    return null;
  };
  const routeFor = (entity: { kind: string; id?: string }): string | null => {
    switch (entity.kind) {
      case "task":
        return `/run?feature=${currentRunId}&view=tasks#task-${entity.id ?? ""}`;
      case "worker":
        return `/run?feature=${currentRunId}&view=workers#worker-${entity.id ?? ""}`;
      case "gate":
        return `/run?feature=${currentRunId}&view=verification`;
      case "car":
      case "halt":
      case "harbor":
        return `/run?feature=${currentRunId}&view=train`;
      default:
        return null;
    }
  };
  let downAt: { x: number; y: number } | null = null;
  // Named handlers so dispose() removes every canvas listener it added:
  // reinitializing the renderer on one canvas must not stack handlers.
  function onPointerDown(event: PointerEvent): void {
    downAt = { x: event.clientX, y: event.clientY };
  }
  canvas.addEventListener("pointerdown", onPointerDown);
  function onPointerUp(event: PointerEvent): void {
    if (downAt === null || Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 6) {
      downAt = null;
      return;
    }
    downAt = null;
    const entity = findEntity(event.clientX, event.clientY);
    if (opts.onPick !== undefined) {
      if (entity === null) {
        opts.onPick(null);
      } else if (entity.id === undefined) {
        opts.onPick({ kind: entity.kind });
      } else {
        opts.onPick({ kind: entity.kind, id: entity.id });
      }
      return;
    }
    const route = routeFor(entity ?? { kind: "" });
    if (route !== null) {
      window.location.assign(route);
    }
  }
  canvas.addEventListener("pointerup", onPointerUp);
  let hoverQueued = false;
  function onPointerMove(event: PointerEvent): void {
    if (hoverQueued) {
      return;
    }
    hoverQueued = true;
    requestAnimationFrame(() => {
      hoverQueued = false;
      // Flush OrbitControls deltas: with damping off nothing applies them
      // until update() runs (previously the per-poll update masked this).
      // Change events from real motion re-render via the controls listener.
      controls.update();
      const entity = findEntity(event.clientX, event.clientY);
      canvas.style.cursor = entity === null ? "" : "pointer";
      refreshHover(entity);
    });
  }
  canvas.addEventListener("pointermove", onPointerMove);
  function onPointerLeave(): void {
    refreshHover(null);
  }
  canvas.addEventListener("pointerleave", onPointerLeave);

  const sun = new THREE.DirectionalLight(0xfff2e0, 2.6);
  sun.position.set(28, 44, 18);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -40;
  sun.shadow.camera.right = 40;
  sun.shadow.camera.top = 40;
  sun.shadow.camera.bottom = -40;
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0x8fb4dd, 0x11161d, 1.05));

  const world = new THREE.Group();
  scene.add(world);
  // Transition targets, rebuilt on every update (M25.2): the player resolves
  // entity ids from the diff layer to live objects. All motion is
  // event-driven and terminates; the scene is always final when idle.
  const refs = new Map<string, THREE.Object3D>();

  // Selection outline: single accent ring positioned over the selected
  // entity. Lives on the scene (not the world group) so update() rebuilds
  // never destroy it; re-resolved after every rebuild from pendingSelection.
  // Appears instantly — no animation, reduced-motion safe by construction.
  const selectionRing = new THREE.Mesh(
    new THREE.RingGeometry(2.3, 2.8, 48),
    new THREE.MeshBasicMaterial({ color: 0x388bfd, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthTest: false }),
  );
  selectionRing.rotation.x = -Math.PI / 2;
  selectionRing.visible = false;
  selectionRing.renderOrder = 10;
  scene.add(selectionRing);
  let pendingSelection: { kind: string; id?: string } | null = null;

  function resolveSelection(): void {
    if (selectSprite !== null) {
      disposeSprite(selectSprite);
      selectSprite = null;
    }
    if (pendingSelection === null) {
      selectionRing.visible = false;
      return;
    }
    const { kind, id } = pendingSelection;
    const key = id === undefined ? kind : `${kind}:${id}`;
    const target = refs.get(key) ?? (kind === "gate" && id !== undefined ? gateBeams.get(id)?.mesh : undefined);
    if (target === undefined) {
      selectionRing.visible = false;
      return;
    }
    const pos = new THREE.Vector3();
    target.getWorldPosition(pos);
    selectionRing.position.set(pos.x, 0.35, pos.z);
    selectionRing.visible = true;
    // Selected entities always label: the one persistent label that is
    // earned by operator attention rather than anomaly status.
    const text = chipText(kind, id);
    if (text !== null) {
      const sprite = makeLabel(text, 34);
      sprite.position.set(pos.x, pos.y + 5.5, pos.z);
      scene.add(sprite);
      selectSprite = sprite;
    }
    render();
  }

  function select(kind: string | null, id?: string): void {
    if (kind === null) {
      pendingSelection = null;
    } else if (id === undefined) {
      pendingSelection = { kind };
    } else {
      pendingSelection = { kind, id };
    }
    resolveSelection();
  }

  // Hover + selection chips (M27.5 anomaly-first labels): exactly one
  // transient chip and one selection chip exist at most. Both read live
  // scene data — never stored strings, never invented rows.
  let currentData: IslandScene | null = null;
  let hoverSprite: THREE.Sprite | null = null;
  let hoverKey: string | null = null;
  let selectSprite: THREE.Sprite | null = null;

  function disposeSprite(sprite: THREE.Sprite): void {
    sprite.material.map?.dispose();
    sprite.material.dispose();
    scene.remove(sprite);
  }

  function entityAnchor(kind: string, id: string | undefined): THREE.Vector3 | null {
    const key = id === undefined ? kind : `${kind}:${id}`;
    const target = refs.get(key) ?? (kind === "gate" && id !== undefined ? gateBeams.get(id)?.mesh : undefined);
    if (target === undefined) {
      return null;
    }
    const pos = new THREE.Vector3();
    target.getWorldPosition(pos);
    return pos;
  }

  function chipText(kind: string, id: string | undefined): string | null {
    const data = currentData;
    if (data === null) {
      return null;
    }
    switch (kind) {
      case "task":
      case "gate": {
        if (id === undefined) {
          return null;
        }
        const b = data.buildings.find((x) => x.taskId === id);
        if (b === undefined) {
          return null;
        }
        if (kind === "gate") {
          const gate = data.gates.find((x) => x.taskId === id);
          const mark = gate !== undefined && gate.verdict === "VERIFIED" ? "✓" : "×";
          return `${mark} ${b.title} ${gate?.verdict ?? "unevaluated"}`;
        }
        return `${b.title} · ${b.status}`;
      }
      case "worker": {
        if (id === undefined) {
          return null;
        }
        const owner = data.buildings.find((x) => x.worker?.id === id);
        const worker = owner?.worker;
        if (worker === undefined || worker === null) {
          return null;
        }
        return `worker ${worker.id.slice(0, 8)} · ${worker.status} (${worker.link})`;
      }
      case "car": {
        if (id === undefined) {
          return null;
        }
        const car = data.cars.find((x) => x.sha === id);
        return car === undefined ? null : `${car.subject === "" ? car.title : car.subject} · ${car.sha.slice(0, 8)}`;
      }
      case "halt":
        return data.halt === null ? null : `! HALTED — ${data.halt.reason.slice(0, 60)}`;
      case "harbor":
        return `HARBOR · MAIN ${data.harbor.branch}`;
      default:
        return null;
    }
  }

  function refreshHover(entity: { kind: string; id?: string } | null): void {
    const key = entity === null ? null : `${entity.kind}:${entity.id ?? ""}`;
    if (key === hoverKey) {
      return;
    }
    hoverKey = key;
    if (hoverSprite !== null) {
      disposeSprite(hoverSprite);
      hoverSprite = null;
    }
    if (entity === null) {
      return;
    }
    const text = chipText(entity.kind, entity.id);
    const anchor = entityAnchor(entity.kind, entity.id);
    if (text === null || anchor === null) {
      return;
    }
    const sprite = makeLabel(text, 34);
    sprite.position.set(anchor.x, anchor.y + 5.5, anchor.z);
    scene.add(sprite);
    hoverSprite = sprite;
    render();
  }

  // Explicit focus (M27.5): the ONLY camera motion besides the operator's
  // own orbit/zoom and the per-update refit. Ordinary selection never moves
  // the camera. Reduced motion snaps; otherwise a single 300ms ease.
  // M27.7 poll-safe camera: the home framing is applied exactly once, on
  // first paint. Later polls never reset position, zoom, or orientation —
  // not for unchanged data, status changes, added tasks, or removals. Only
  // explicit Focus and Reset move the camera afterwards. Projection still
  // refits when the canvas size changes so responsive resizes stay correct.
  let hasFramed = false;
  let lastSize: { w: number; h: number } | null = null;
  let lastBounds: { cols: number; rows: number } | null = null;

  function snapTo(target: THREE.Vector3, pos: THREE.Vector3): void {
    controls.target.copy(target);
    camera.position.copy(pos);
    controls.update();
    render();
  }

  function flyTo(target: THREE.Vector3, pos: THREE.Vector3): void {
    if (reducedMotion) {
      snapTo(target, pos);
      return;
    }
    const fromT = controls.target.clone();
    const fromP = camera.position.clone();
    void tween(300, (k) => {
      controls.target.lerpVectors(fromT, target, k);
      camera.position.lerpVectors(fromP, pos, k);
      controls.update();
    }, render);
  }

  function focus(kind: string | null, id?: string): void {
    if (kind === null) {
      resetView();
      return;
    }
    const anchor = entityAnchor(kind, id);
    if (anchor === null) {
      return;
    }
    const offset = camera.position.clone().sub(controls.target);
    const target = new THREE.Vector3(anchor.x, 0, anchor.z);
    flyTo(target, target.clone().add(offset));
  }

  function applyProjection(bounds: { cols: number; rows: number }): void {
    const spanX = Math.max(24, bounds.cols * 6 + 22);
    const spanZ = Math.max(30, bounds.rows * 7 + 34);
    const halfW = spanX / 2 + 8;
    const halfH = spanZ / 2 + 10;
    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    if (aspect >= 1) {
      camera.left = -halfW * aspect;
      camera.right = halfW * aspect;
      camera.top = halfH;
      camera.bottom = -halfH;
    } else {
      camera.left = -halfW;
      camera.right = halfW;
      camera.top = halfH / aspect;
      camera.bottom = -halfH / aspect;
    }
    camera.updateProjectionMatrix();
  }

  function frameHome(bounds: { cols: number; rows: number }): void {
    applyProjection(bounds);
    camera.position.set(34, 34, 34);
    camera.lookAt(0, 0, bounds.rows * 3.2);
    controls.target.set(0, 0, bounds.rows * 3.2);
    controls.update();
  }

  function resetView(): void {
    // Recomputed from the latest seen bounds: growing runs reframe to fit
    // on explicit Reset instead of drifting on their own.
    if (lastBounds === null) {
      return;
    }
    const bounds = lastBounds;
    if (reducedMotion) {
      frameHome(bounds);
      render();
      return;
    }
    const fromT = controls.target.clone();
    const fromP = camera.position.clone();
    const homeT = new THREE.Vector3(0, 0, bounds.rows * 3.2);
    const homeP = new THREE.Vector3(34, 34, 34);
    applyProjection(bounds);
    void tween(300, (k) => {
      controls.target.lerpVectors(fromT, homeT, k);
      camera.position.lerpVectors(fromP, homeP, k);
      controls.update();
    }, render);
  }
  const gateBeams = new Map<string, { mesh: THREE.Mesh; mat: THREE.MeshStandardMaterial; open: boolean }>();
  const lampMats = new Map<string, THREE.MeshStandardMaterial>();

  const sharedBox = new THREE.BoxGeometry(1, 1, 1);
  const steel = new THREE.MeshStandardMaterial({ color: 0x3a4556, roughness: 0.55, metalness: 0.5 });
  const concreteDark = new THREE.MeshStandardMaterial({ color: 0x1b2330, roughness: 0.95 });
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x11151c, roughness: 1 });
  const bandMatA = new THREE.MeshStandardMaterial({ color: 0x161b24, roughness: 1 });
  const bandMatB = new THREE.MeshStandardMaterial({ color: 0x11151c, roughness: 1 });

  function render(): void {
    renderer.render(scene, camera);
    // Poll-safe debugging hook (same precedent as __atlasIsland3dReady):
    // lets smoke tests assert the camera survives polling. Write-only,
    // no reads, no behavior.
    const cw = window as unknown as { __atlasIslandCamera?: string };
    // Position + target + zoom: orthographic dolly changes zoom, never
    // position, so zoom must be part of the identity for smoke assertions.
    cw.__atlasIslandCamera =
      `${camera.position.x.toFixed(2)},${camera.position.y.toFixed(2)},${camera.position.z.toFixed(2)}` +
      `|${controls.target.x.toFixed(2)},${controls.target.y.toFixed(2)},${controls.target.z.toFixed(2)}` +
      `|z${camera.zoom.toFixed(3)}`;
  }

  function clearWorld(): void {
    refs.clear();
    gateBeams.clear();
    lampMats.clear();
    world.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry !== sharedBox) {
        mesh.geometry.dispose();
      }
      const lines = child as THREE.LineSegments;
      if (lines.isLineSegments) {
        lines.geometry.dispose();
        (lines.material as THREE.Material).dispose();
      }
      const sprite = child as THREE.Sprite;
      if (sprite.isSprite) {
        sprite.material.map?.dispose();
        sprite.material.dispose();
      }
    });
    world.clear();
  }

  function box(w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = world): THREE.Mesh {
    const mesh = new THREE.Mesh(sharedBox, material);
    mesh.scale.set(w, h, d);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  function update(data: IslandScene): void {
    clearWorld();
    currentRunId = data.runId;
    currentData = data;
    // Rebuilt world invalidates hover anchors; the next pointermove
    // re-establishes the chip. Selection re-resolves below.
    if (hoverSprite !== null) {
      disposeSprite(hoverSprite);
      hoverSprite = null;
      hoverKey = null;
    }

    // Ground plate: one matte surface sized to the run bounds. No water,
    // no decorative disc — space outside the plate is simply out of scope.
    // Level bands shade alternate dependency-depth rows (level verified as
    // longest-path depth in layoutLevels): topology you can read, flat.
    const minZ = -4;
    const maxZ = data.bounds.rows * 7 + 32;
    const ground = new THREE.Mesh(sharedBox, groundMat);
    ground.scale.set(Math.max(30, data.bounds.cols * 6 + 16), 0.5, maxZ - minZ);
    ground.position.set(0, -0.25, (minZ + maxZ) / 2);
    ground.receiveShadow = true;
    world.add(ground);
    for (let row = 0; row < data.bounds.rows; row++) {
      const band = new THREE.Mesh(
        sharedBox,
        row % 2 === 0 ? bandMatA : bandMatB,
      );
      band.scale.set(Math.max(30, data.bounds.cols * 6 + 16), 0.06, 6.4);
      band.position.set(0, 0.03, row * 7);
      band.receiveShadow = true;
      world.add(band);
    }

    // Island landmass: deterministic irregular disc from the run seed.
    // (Seeded landmass, pads, and control tower removed in M27.5: the disc
    // communicated nothing about topology and the tower controlled nothing.
    // Ground plate + level bands above replace them.)

    const labelOf = (text: string, x: number, y: number, z: number, size?: number): void => {
      const sprite = makeLabel(text, size);
      sprite.position.set(x, y, z);
      world.add(sprite);
    };

    // Task masses: body color IS the execution state (spec §5 palette).
    // Height still encodes dependency depth. FAILED keeps its squat profile
    // plus a red base ring; BLOCKED gets an amber base ring; COMPLETED_EMPTY
    // is hollow (translucent faces + edge lines): done without contribution.
    for (const b of data.buildings) {
      const g = new THREE.Group();
      g.position.set(b.x, 0, b.z);
      const height = b.status === "FAILED" ? 2.2 : 3 + (b.level % 3);
      const body = new THREE.Mesh(sharedBox, bodyMat(b.status));
      body.scale.set(3.2, height, 3.2);
      body.position.y = height / 2 + 0.5;
      body.castShadow = true;
      body.receiveShadow = true;
      if (b.status === "COMPLETED_EMPTY") {
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(sharedBox),
          new THREE.LineBasicMaterial({ color: 0x6e7681 }),
        );
        edges.scale.set(3.24, height + 0.04, 3.24);
        edges.position.y = height / 2 + 0.5;
        g.add(edges);
      }
      const roof = new THREE.Mesh(sharedBox, steel);
      roof.scale.set(3.5, 0.3, 3.5);
      roof.position.y = height + 0.65;
      const lampMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: statusColor(b.status), emissiveIntensity: 2.4 });
      const lamp = new THREE.Mesh(
        new THREE.SphereGeometry(0.4, 10, 10),
        lampMat,
      );
      lamp.position.y = height + 1.2;
      g.add(body, roof, lamp);
      g.userData.entity = { kind: "task", id: b.taskId };
      refs.set(`task:${b.taskId}`, g);
      lampMats.set(`task:${b.taskId}`, lampMat);
      if (b.status === "FAILED") {
        const marker = new THREE.Mesh(sharedBox, new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xf85149, emissiveIntensity: 1.4 }));
        marker.scale.set(3.4, 0.25, 3.4);
        marker.position.y = 0.75;
        g.add(marker);
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(2.6, 3, 40),
          new THREE.MeshBasicMaterial({ color: 0xf85149, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.08;
        g.add(ring);
      }
      if (b.status === "BLOCKED") {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(2.6, 3, 40),
          new THREE.MeshBasicMaterial({ color: 0xd29922, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.08;
        g.add(ring);
      }
      world.add(g);
      // Anomaly-first labels (M27.5): only failed / verifying tasks carry a
      // permanent label. Everything else labels on hover or selection.
      if (b.status === "FAILED" || b.status === "VERIFICATION") {
        labelOf(`${b.title} · ${b.status}`, b.x, height + 3.4, b.z, 40);
      }
      if (b.worker !== null) {
        const live = b.worker.link === "live";
        const unit = new THREE.Mesh(sharedBox, workerMat(b.worker.status, live));
        unit.scale.set(1.1, 1.5, 1.1);
        unit.position.set(b.x + 2.9, 1.25, b.z + 1.6);
        unit.castShadow = true;
        unit.userData.entity = { kind: "worker", id: b.worker.id };
        world.add(unit);
        refs.set(`worker:${b.worker.id}`, unit);
      }
    }

    // Dependency conduits (rows only): raised rails with direction cones.
    const byId = new Map(data.buildings.map((b) => [b.taskId, b] as const));
    for (const path of data.paths) {
      const a = byId.get(path.fromTaskId);
      const b = byId.get(path.toTaskId);
      if (a === undefined || b === undefined) {
        continue;
      }
      // Satisfied paths read as settled ink; unsatisfied paths ride raised
      // and pale. Blue is reserved for live workers/selection — rails never
      // use it, so a blue glow always means "something is running".
      const railMat = new THREE.MeshStandardMaterial({
        color: path.satisfied ? 0x3a4556 : 0x6b7482,
        roughness: 0.5,
        metalness: 0.3,
        transparent: !path.satisfied,
        opacity: path.satisfied ? 1 : 0.85,
      });
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const length = Math.hypot(dx, dz);
      if (length < 0.01) {
        continue;
      }
      const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, length, 6), railMat);
      rail.position.set((a.x + b.x) / 2, path.satisfied ? 0.7 : 1.3, (a.z + b.z) / 2);
      rail.rotation.z = Math.PI / 2;
      rail.rotation.y = -Math.atan2(dz, dx);
      rail.castShadow = true;
      world.add(rail);
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.1, 8), railMat);
      cone.position.set(b.x - (dx / length) * 2.2, 0.9, b.z - (dz / length) * 2.2);
      cone.rotation.z = -Math.PI / 2;
      cone.rotation.y = -Math.atan2(dz, dx) + Math.PI / 2;
      world.add(cone);
    }

    // Verification gate row south of the last level.
    const gateZ = data.bounds.rows * 7 + 5;
    for (const [gi, gate] of data.gates.entries()) {
      const gx = (gi - (data.gates.length - 1) / 2) * 9;
      const passed = gate.verdict === "VERIFIED";
      const pillarMat = steel;
      const left = new THREE.Mesh(sharedBox, pillarMat);
      left.scale.set(0.7, 4.4, 0.7);
      left.position.set(gx - 2.2, 2.2, gateZ);
      left.castShadow = true;
      const right = left.clone();
      right.position.x = gx + 2.2;
      const beamMat = new THREE.MeshStandardMaterial({
        color: 0x111111,
        emissive: passed ? 0x2ea043 : 0xf85149,
        emissiveIntensity: 1.6,
      });
      const beam = new THREE.Mesh(sharedBox, beamMat);
      beam.scale.set(5.1, 0.5, 0.7);
      beam.position.set(gx, passed ? 4.6 : 1.4, gateZ);
      beam.userData.entity = { kind: "gate", id: gate.taskId };
      world.add(left, right, beam);
      gateBeams.set(gate.taskId, { mesh: beam, mat: beamMat, open: passed });
      // Failed gates stay labeled; passed gates read as open frames.
      if (!passed) {
        labelOf(`× ${gate.title} ${gate.verdict}`, gx, 6.4, gateZ, 36);
      }
    }

    // Merge railyard: one car per integrated commit, in merge order.
    const yardZ = gateZ + 9;
    const railMat2 = new THREE.MeshStandardMaterial({ color: 0x3a4556, roughness: 0.5, metalness: 0.6 });
    for (const [ci, car] of data.cars.entries()) {
      const cx = (ci - (data.cars.length - 1) / 2) * 7;
      const rail = new THREE.Mesh(sharedBox, railMat2);
      rail.scale.set(5.6, 0.25, 1.6);
      rail.position.set(cx, 0.6, yardZ);
      rail.receiveShadow = true;
      const bodyCar = new THREE.Mesh(sharedBox, new THREE.MeshStandardMaterial({ color: 0x46536b, roughness: 0.7 }));
      bodyCar.scale.set(4.4, 1.6, 2);
      bodyCar.position.set(cx, 1.7, yardZ);
      bodyCar.castShadow = true;
      const carGroup = new THREE.Group();
      carGroup.userData.entity = { kind: "car", id: car.sha };
      carGroup.add(bodyCar);
      world.add(rail, carGroup);
      refs.set(`car:${car.sha}`, carGroup);
      // Cars stay unlabeled: order reads left-to-right, identity arrives
      // via hover or selection. Permanent per-car labels overlapped at any
      // real train length.
    }
    if (data.halt !== null) {
      const beaconMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xf85149, emissiveIntensity: 2.5 });
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 5, 8), steel);
      pole.position.set(0, 2.5, yardZ + 5);
      const lampHalt = new THREE.Mesh(new THREE.OctahedronGeometry(0.8), beaconMat);
      lampHalt.position.set(0, 5.6, yardZ + 5);
      lampHalt.userData.entity = { kind: "halt" };
      world.add(pole, lampHalt);
      refs.set("halt", lampHalt);
      labelOf(`! HALTED — ${data.halt.reason.slice(0, 60)}`, 0, 7.4, yardZ + 5, 36);
    }

    // Harbor: pier + beacon post + branch reference (never a SHA).
    const harborZ = yardZ + 12 + (data.cars.length === 0 ? 2 : 0);
    const pier = new THREE.Mesh(sharedBox, concreteDark);
    pier.scale.set(10, 0.4, 4);
    pier.position.set(0, 0.2, harborZ);
    pier.receiveShadow = true;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, 4.4, 10), steel);
    post.position.set(0, 2.4, harborZ);
    post.castShadow = true;
    post.userData.entity = { kind: "harbor" };
    const lampTop = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 12, 12),
      // Neutral marker light: amber is reserved for verification states.
      new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x9aa4b2, emissiveIntensity: 1.2 }),
    );
    lampTop.position.set(0, 5, harborZ);
    world.add(pier, post, lampTop);
    labelOf(`HARBOR · MAIN ${data.harbor.branch}`, 0, 7, harborZ, 38);

    // Frame the run exactly once (first paint). Later polls preserve the
    // operator's camera under all data changes; only Focus/Reset move it.
    // Canvas resizes refit projection alone so responsive layouts stay
    // correct without touching position, zoom, or orientation.
    lastBounds = { cols: data.bounds.cols, rows: data.bounds.rows };
    const size = { w: canvas.clientWidth, h: canvas.clientHeight };
    if (!hasFramed) {
      hasFramed = true;
      frameHome(data.bounds);
      lastSize = size;
    } else if (lastSize === null || lastSize.w !== size.w || lastSize.h !== size.h) {
      lastSize = size;
      applyProjection(data.bounds);
      controls.update();
    }
    // Match the drawing buffer to the laid-out canvas (CSS alone would only
    // upscale the 300x150 default framebuffer into a blur).
    renderer.setSize(Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight), false);
    resolveSelection();
    render();
    const w = window as unknown as { __atlasIsland3dReady?: boolean };
    w.__atlasIsland3dReady = true;
  }

  function dispose(): void {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerleave", onPointerLeave);
    controls.dispose();
    clearWorld();
    scene.remove(selectionRing);
    selectionRing.geometry.dispose();
    (selectionRing.material as THREE.Material).dispose();
    if (hoverSprite !== null) {
      disposeSprite(hoverSprite);
      hoverSprite = null;
    }
    if (selectSprite !== null) {
      disposeSprite(selectSprite);
      selectSprite = null;
    }
    renderer.dispose();
  }

  // Sequential transition player (M25.2): exactly one motion at a time, in
  // diff order. Event-driven rAF bursts that terminate; the scene idles
  // otherwise. Reduced motion skips everything (final state already built).
  async function play(transitions: VisualTransition[]): Promise<void> {
    if (reducedMotion) {
      return;
    }
    for (const t of transitions) {
      const ms = TRANSITION_MS[t.kind];
      if (t.kind === "WORKER_ENTER") {
        const obj = refs.get(`worker:${t.entityId}`);
        if (obj === undefined) {
          continue;
        }
        obj.scale.setScalar(0.01);
        await tween(ms, (k) => {
          obj.scale.setScalar(0.01 + 0.99 * k);
          render();
        }, render);
        obj.scale.setScalar(1);
      } else if (t.kind === "TASK_STATE_CHANGE") {
        const obj = refs.get(`task:${t.entityId}`);
        const lamp = lampMats.get(`task:${t.entityId}`);
        if (obj === undefined) {
          continue;
        }
        await tween(ms, (k) => {
          const pulse = Math.sin(Math.PI * k);
          obj.scale.setScalar(1 + 0.06 * pulse);
          if (lamp !== undefined) {
            lamp.emissiveIntensity = 2.4 * (1 + 2 * pulse);
          }
          render();
        }, render);
        obj.scale.setScalar(1);
        if (lamp !== undefined) {
          lamp.emissiveIntensity = 2.4;
        }
      } else if (t.kind === "VERIFICATION_CHANGE") {
        const gate = gateBeams.get(t.entityId);
        if (gate === undefined) {
          continue;
        }
        if (gate.open) {
          const from = 1.4;
          const to = 4.6;
          gate.mesh.position.y = from;
          await tween(ms, (k) => {
            gate.mesh.position.y = from + (to - from) * k;
            render();
          }, render);
          gate.mesh.position.y = to;
        } else {
          await tween(ms, (k) => {
            gate.mat.emissiveIntensity = 1.6 + 2.4 * Math.sin(Math.PI * k);
            render();
          }, render);
          gate.mat.emissiveIntensity = 1.6;
        }
      } else if (t.kind === "MERGE_CAR_ENTER") {
        const obj = refs.get(`car:${t.entityId}`);
        if (obj === undefined) {
          continue;
        }
        obj.position.x = -8;
        await tween(ms, (k) => {
          obj.position.x = -8 + 8 * k;
          render();
        }, render);
        obj.position.x = 0;
      } else if (t.kind === "HALT_CHANGE") {
        const obj = refs.get("halt");
        const mat = obj instanceof THREE.Mesh ? (obj.material as THREE.MeshStandardMaterial) : undefined;
        if (mat === undefined) {
          continue;
        }
        await tween(ms, (k) => {
          mat.emissiveIntensity = 2.5 + 2.5 * Math.sin(Math.PI * k);
          render();
        }, render);
        mat.emissiveIntensity = 2.5;
      }
      render();
    }
  }

  function describe(): { camera: string; position: string; objects: number; pixelRatio: number } {
    let objects = 0;
    world.traverse(() => {
      objects += 1;
    });
    return {
      camera: camera.isOrthographicCamera ? "orthographic" : "perspective",
      position: [camera.position.x, camera.position.y, camera.position.z].map((v) => v.toFixed(1)).join(","),
      objects,
      pixelRatio: renderer.getPixelRatio(),
    };
  }

  return { update, play, select, focus, resetView, describe, dispose };
}

// Page bootstrap: paint the embedded scene, then re-paint whenever M24.2
// polling swaps <main> (fresh JSON arrives with it). The canvas itself is
// replaced on swaps, so the renderer rebinds when its element changes.
// WebGL failure (or bad payload) reveals the static fallback instead of a
// blank: the text table below always carries the same information.
function currentPayload(): { canvas: HTMLCanvasElement; json: string } | null {
  const canvas = document.getElementById("island3d-canvas");
  const data = document.getElementById("island3d-data");
  if (!(canvas instanceof HTMLCanvasElement) || data?.textContent == null || data.textContent === "") {
    return null;
  }
  return { canvas, json: data.textContent };
}

function boot(): void {
  // Development-only diagnostic surface (no secrets, no Atlas internals —
  // only renderer lifecycle facts). Rendered into the page when ?debug=1 is
  // present so headless/devtools inspection needs no console typing.
  const debugEnabled = typeof window !== "undefined" && window.location.search.includes("debug=1");
  const debugState: Record<string, string | number | boolean> = { booted: false };
  const debugRender = (): void => {
    const w = window as unknown as { __atlasIsland3dDebug?: unknown };
    w.__atlasIsland3dDebug = { ...debugState };
    if (!debugEnabled) {
      return;
    }
    let element = document.getElementById("island3d-debug");
    if (element === null) {
      element = document.createElement("pre");
      element.id = "island3d-debug";
      const root = document.getElementById("island3d-root");
      if (root?.parentElement !== null && root?.parentElement !== undefined) {
        root.parentElement.insertBefore(element, root.nextSibling);
      }
    }
    if (element !== null) {
      element.textContent = JSON.stringify(debugState);
    }
  };
  const debugSet = (key: string, value: string | number | boolean): void => {
    debugState[key] = value;
    debugRender();
  };
  let renderer: IslandRenderer | null = null;
  let boundCanvas: HTMLCanvasElement | null = null;
  let lastJson = "";
  let lastScene: IslandScene | null = null;
  const fallback = (): void => {
    const element = document.getElementById("island3d-fallback");
    if (element instanceof HTMLElement) {
      element.hidden = false;
    }
  };
  const paint = (): void => {
    const current = currentPayload();
    if (current === null || current.json === lastJson) {
      return;
    }
    let scene: IslandScene;
    try {
      scene = JSON.parse(current.json) as IslandScene;
    } catch (error) {
      debugSet("error", `payload: ${error instanceof Error ? error.message : String(error)}`);
      fallback();
      return;
    }
    debugSet("payloadBytes", current.json.length);
    try {
      if (renderer === null || boundCanvas !== current.canvas) {
        debugSet("canvasW", current.canvas.clientWidth);
        debugSet("canvasH", current.canvas.clientHeight);
        renderer?.dispose();
        renderer = createIslandRenderer(current.canvas);
        boundCanvas = current.canvas;
        debugSet("rendererCreated", true);
      }
      renderer.update(scene);
      const info = renderer.describe();
      debugSet("camera", info.camera);
      debugSet("cameraPos", info.position);
      debugSet("sceneObjects", info.objects);
      debugSet("rendered", true);
      // First paint shows final state with no motion; later polls diff the
      // previous browser snapshot and play at most one motion at a time.
      // fire-and-forget is safe: failures leave the final rendered state.
      void renderer
        .play(diffIslandScenes(lastScene, scene))
        .catch(() => undefined);
      lastScene = scene;
      lastJson = current.json;
      debugSet("ready", true);
    } catch (error) {
      renderer = null;
      boundCanvas = null;
      debugSet("error", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      fallback();
    }
  };
  debugSet("booted", true);
  paint();
  const main = document.querySelector("main[data-run]");
  if (main !== null) {
    new MutationObserver(() => paint()).observe(main, { childList: true });
  }
}

boot();

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
  CLAIMED: 0x1f6feb,
  IN_PROGRESS: 0x1f6feb,
  VERIFICATION: 0xd29922,
  READY: 0x6e7681,
  PENDING: 0x6e7681,
  BLOCKED: 0x6e7681,
  CANCELLED: 0x6e7681,
};

function statusColor(status: string): number {
  return STATUS_COLORS[status] ?? 0x8b949e;
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

export interface IslandRenderer {
  readonly update: (scene: IslandScene) => void;
  readonly play: (transitions: VisualTransition[]) => Promise<void>;
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

export function createIslandRenderer(canvas: HTMLCanvasElement): IslandRenderer {
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
  controls.maxPolarAngle = Math.PI / 2.6;
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
      case "tower":
        return `/run?feature=${currentRunId}&view=overview`;
      default:
        return null;
    }
  };
  let downAt: { x: number; y: number } | null = null;
  canvas.addEventListener("pointerdown", (event: PointerEvent) => {
    downAt = { x: event.clientX, y: event.clientY };
  });
  canvas.addEventListener("pointerup", (event: PointerEvent) => {
    if (downAt === null || Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 6) {
      downAt = null;
      return;
    }
    downAt = null;
    const route = routeFor(findEntity(event.clientX, event.clientY) ?? { kind: "" });
    if (route !== null) {
      window.location.assign(route);
    }
  });
  let hoverQueued = false;
  canvas.addEventListener("pointermove", (event: PointerEvent) => {
    if (hoverQueued) {
      return;
    }
    hoverQueued = true;
    requestAnimationFrame(() => {
      hoverQueued = false;
      canvas.style.cursor = findEntity(event.clientX, event.clientY) === null ? "" : "pointer";
    });
  });

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
  const gateBeams = new Map<string, { mesh: THREE.Mesh; mat: THREE.MeshStandardMaterial; open: boolean }>();
  const lampMats = new Map<string, THREE.MeshStandardMaterial>();

  const sharedBox = new THREE.BoxGeometry(1, 1, 1);
  const concrete = new THREE.MeshStandardMaterial({ color: 0x2a3340, roughness: 0.9 });
  const concreteDark = new THREE.MeshStandardMaterial({ color: 0x1b2330, roughness: 0.95 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x3a4556, roughness: 0.55, metalness: 0.5 });
  const waterMat = new THREE.MeshStandardMaterial({ color: 0x0e2233, roughness: 0.35, metalness: 0.15 });

  function render(): void {
    renderer.render(scene, camera);
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

  function mulberry(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function update(data: IslandScene): void {
    clearWorld();
    currentRunId = data.runId;
    const rand = mulberry(data.seed);

    // Water plane (out-of-scope space).
    const water = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.y = -0.6;
    water.receiveShadow = true;
    world.add(water);

    // Island landmass: deterministic irregular disc from the run seed.
    const landShape = new THREE.Shape();
    const landR = Math.max(16, data.bounds.cols * 3.4 + 10);
    for (let k = 0; k <= 48; k++) {
      const angle = (k / 48) * Math.PI * 2;
      const wobble = 0.82 + rand() * 0.36;
      const px = Math.cos(angle) * landR * wobble;
      const pz = Math.sin(angle) * landR * wobble + data.bounds.rows * 3.2;
      if (k === 0) {
        landShape.moveTo(px, pz);
      } else {
        landShape.lineTo(px, pz);
      }
    }
    const landGeo = new THREE.ExtrudeGeometry(landShape, { depth: 2.4, bevelEnabled: false });
    landGeo.rotateX(-Math.PI / 2);
    const land = new THREE.Mesh(landGeo, new THREE.MeshStandardMaterial({ color: 0x18222e, roughness: 1 }));
    land.position.y = -2.4;
    land.receiveShadow = true;
    world.add(land);

    // Subtle elevation pads under level rows (presentation only).
    for (let row = 0; row < data.bounds.rows; row++) {
      const pad = new THREE.Mesh(sharedBox, concreteDark);
      pad.scale.set(data.bounds.cols * 6 + 8, 0.5, 5);
      pad.position.set(0, 0.25, row * 7);
      pad.receiveShadow = true;
      world.add(pad);
    }

    // Control tower (conceptual anchor; controls nothing).
    const tower = new THREE.Group();
    tower.position.set(0, 0, -12);
    const shaft = new THREE.Mesh(sharedBox, steel);
    shaft.scale.set(3, 11, 3);
    shaft.position.y = 5.5;
    shaft.castShadow = true;
    const deck = new THREE.Mesh(sharedBox, concrete);
    deck.scale.set(5.4, 1.6, 5.4);
    deck.position.y = 11.8;
    deck.castShadow = true;
    const beaconMat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xf85149, emissiveIntensity: 2 });
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 12), beaconMat);
    beacon.position.y = 13.6;
    tower.add(shaft, deck, beacon);
    shaft.userData.entity = { kind: "tower" };
    deck.userData.entity = { kind: "tower" };
    world.add(tower);

    const labelOf = (text: string, x: number, y: number, z: number, size?: number): void => {
      const sprite = makeLabel(text, size);
      sprite.position.set(x, y, z);
      world.add(sprite);
    };

    // Task structures with worker units beside them.
    for (const b of data.buildings) {
      const g = new THREE.Group();
      g.position.set(b.x, 0, b.z);
      const height = b.status === "FAILED" ? 2.2 : 3 + (b.level % 3);
      const body = new THREE.Mesh(sharedBox, concrete);
      body.scale.set(3.2, height, 3.2);
      body.position.y = height / 2 + 0.5;
      body.castShadow = true;
      body.receiveShadow = true;
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
      }
      world.add(g);
      labelOf(`${b.title} · ${b.status}`, b.x, height + 3.4, b.z, 40);
      if (b.worker !== null) {
        const live = b.worker.link === "live";
        const unit = new THREE.Mesh(
          sharedBox,
          live
            ? new THREE.MeshStandardMaterial({ color: 0x3a4556, roughness: 0.5, metalness: 0.6 })
            : new THREE.MeshStandardMaterial({ color: 0x232c38, roughness: 0.9, transparent: true, opacity: 0.45 }),
        );
        unit.scale.set(1.1, 1.5, 1.1);
        unit.position.set(b.x + 2.9, 1.25, b.z + 1.6);
        unit.castShadow = true;
        unit.userData.entity = { kind: "worker", id: b.worker.id };
        world.add(unit);
        refs.set(`worker:${b.worker.id}`, unit);
        labelOf(`worker ${b.worker.id.slice(0, 8)} (${b.worker.link})`, b.x + 2.9, 3.4, b.z + 1.6, 34);
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
      const railMat = new THREE.MeshStandardMaterial({
        color: path.satisfied ? 0x1f6feb : 0x2a3340,
        roughness: 0.5,
        metalness: path.satisfied ? 0.6 : 0.2,
        transparent: !path.satisfied,
        opacity: path.satisfied ? 1 : 0.55,
      });
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const length = Math.hypot(dx, dz);
      if (length < 0.01) {
        continue;
      }
      const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, length, 6), railMat);
      rail.position.set((a.x + b.x) / 2, 0.7, (a.z + b.z) / 2);
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
      labelOf(`${passed ? "✓" : "×"} ${gate.title} ${gate.verdict}`, gx, 6.4, gateZ, 36);
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
      const bodyCar = new THREE.Mesh(sharedBox, new THREE.MeshStandardMaterial({ color: 0x1d3a2a, roughness: 0.7 }));
      bodyCar.scale.set(4.4, 1.6, 2);
      bodyCar.position.set(cx, 1.7, yardZ);
      bodyCar.castShadow = true;
      const carGroup = new THREE.Group();
      carGroup.userData.entity = { kind: "car", id: car.sha };
      carGroup.add(bodyCar);
      world.add(rail, carGroup);
      refs.set(`car:${car.sha}`, carGroup);
      labelOf(`${car.title} · ${car.sha.slice(0, 12)}`, cx, 3.6, yardZ, 34);
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
      new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xd29922, emissiveIntensity: 2 }),
    );
    lampTop.position.set(0, 5, harborZ);
    world.add(pier, post, lampTop);
    labelOf(`HARBOR · MAIN ${data.harbor.branch}`, 0, 7, harborZ, 38);

    // Frame the run: fit bounds, keep the default view total.
    const spanX = Math.max(24, data.bounds.cols * 6 + 22);
    const spanZ = Math.max(30, data.bounds.rows * 7 + 34);
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
    camera.position.set(34, 34, 34);
    camera.lookAt(0, 0, data.bounds.rows * 3.2);
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, data.bounds.rows * 3.2);
    controls.update();
    // Match the drawing buffer to the laid-out canvas (CSS alone would only
    // upscale the 300x150 default framebuffer into a blur).
    renderer.setSize(Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight), false);
    render();
    const w = window as unknown as { __atlasIsland3dReady?: boolean };
    w.__atlasIsland3dReady = true;
  }

  function dispose(): void {
    controls.dispose();
    clearWorld();
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

  return { update, play, describe, dispose };
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

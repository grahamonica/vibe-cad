// Three.js scene for the CAD viewport: bodies with per-face highlighting,
// screen-space edge picking, datum planes, sketches, previews, a view cube
// and an orientation triad. React only feeds it state; it never re-creates
// the renderer.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type {
  DisplayStyle,
  Frame,
  Geometry,
  RenderBody,
  Texture,
  TopologyRef,
  Vec3,
  View,
} from "../../cad/types.ts";
import { textureInfo } from "../../cad/appearance.ts";
import { textureCanvases } from "./textures.ts";

export const palette = {
  white: "#FFFFFF",
  ink: "#1E1E1E",
  slate: "#70798C",
  accent: "#CE8147",
  body: "#544841",
};
export type Orientation =
  | "front"
  | "back"
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "iso"
  | "fit";
export type ScenePick =
  | { kind: "face"; ref: TopologyRef; point: Vec3 }
  | { kind: "edge"; ref: TopologyRef; point: Vec3 }
  | { kind: "plane"; planeId: string; point: Vec3 }
  | { kind: "none" };
export interface PickFilter {
  faces?: boolean;
  edges?: boolean;
  planes?: boolean;
}
export interface PlaneDisplay {
  id: string;
  name: string;
  frame: Frame;
  size: number;
}
export interface SceneOptions {
  ghost?: Geometry | null;
  /** Preview replaces its bodies in place (feature dialog) instead of a translucent proposal. */
  solidPreview?: boolean;
  explode?: number;
  explodeOffsets?: Record<string, Vec3>;
  hiddenBodies?: Set<string>;
  fadeBodies?: boolean;
  /** The view's display style; a body's own display mode wins. */
  displayStyle?: DisplayStyle;
  /** false hides tangent edges (where faces meet smoothly), as SolidWorks' Tangent Edges Removed. */
  tangentEdges?: boolean;
}
const directions: Record<Exclude<Orientation, "fit">, Vec3> = {
  front: [0, -1, 0],
  back: [0, 1, 0],
  top: [0, 0, 1],
  bottom: [0, 0, -1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  iso: [1, -1, 1],
};
const upFor = (dir: THREE.Vector3) =>
  Math.abs(dir.z) > 0.999 ? new THREE.Vector3(0, dir.z > 0 ? 1 : -1, 0) : new THREE.Vector3(0, 0, 1);

interface BodyRecord {
  body: RenderBody;
  mesh: THREE.Mesh;
  edges: LineSegments2;
  edgeColors: Float32Array;
  /** Per-edge segment ranges in the line geometry. */
  edgeRanges: Map<string, { start: number; count: number }>;
  segments: Float32Array;
  segmentEdge: string[];
  offset: THREE.Vector3;
  style: DisplayStyle;
  /** Silhouette candidates on curved faces: per mesh edge its two points and both triangle normals. */
  outline?: { candidates: Float32Array; lines: LineSegments2 };
  /** Hidden Lines Visible: the edges behind faces, dashed. */
  hiddenLines?: LineSegments2;
  /** Shaded (no edges): the selected or hovered edges only. */
  highlight?: LineSegments2;
}
/** Everything drawn for a body, moved together by explode and the gizmo. */
const recordObjects = (r: BodyRecord) =>
  [r.mesh, r.edges, r.outline?.lines, r.hiddenLines, r.highlight].filter((o): o is THREE.Mesh | LineSegments2 => !!o);
interface CameraTween {
  from: { position: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3; zoom: number };
  to: { position: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3; zoom: number };
  start: number;
  duration: number;
}

export class CadScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  readonly controls: OrbitControls;
  readonly transform: TransformControls;
  readonly overlay: HTMLDivElement;
  readonly root = new THREE.Group();
  readonly bodiesGroup = new THREE.Group();
  readonly ghostGroup = new THREE.Group();
  readonly planeGroup = new THREE.Group();
  readonly sketchGroup = new THREE.Group();
  /** Active sketch editor content, drawn above the model. */
  readonly sketchLayer = new THREE.Group();
  readonly helperGroup = new THREE.Group();
  /** Exploded-view trails from assembled to exploded positions. */
  readonly explodeGroup = new THREE.Group();
  /** Section view: stencil passes and the cap over the cut. */
  readonly sectionGroup = new THREE.Group();
  private section: THREE.Plane | null = null;
  private bodies = new Map<string, BodyRecord>();
  private materials: THREE.Material[] = [];
  private lineMaterials = new Set<LineMaterial>();
  /** Dashed hidden lines: dashes are kept a fixed number of pixels long. */
  private dashMaterials = new Set<LineMaterial>();
  private textures = new Map<Texture, { color: THREE.Texture; height?: THREE.Texture }>();
  private planes: (PlaneDisplay & { mesh: THREE.Mesh; outline: THREE.LineSegments; label: HTMLDivElement })[] = [];
  private selection = new Set<string>();
  private selectedPlanes = new Set<string>();
  private hover: { id?: string; plane?: string } = {};
  private needsRender = true;
  private frame = 0;
  private tween?: CameraTween;
  private size = { width: 1, height: 1 };
  private cube: ViewCube;
  private triad: Triad;
  private disposed = false;
  private labelUpdaters = new Set<() => void>();
  onCameraChange?: (position: Vec3, target: Vec3) => void;
  onComponentDrag?: (componentId: string, delta: Vec3) => void;
  constructor(readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, stencil: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(palette.white);
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(this.renderer.domElement);
    this.overlay = document.createElement("div");
    this.overlay.className = "viewport-labels";
    host.appendChild(this.overlay);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.32;
    pmrem.dispose();
    this.camera = new THREE.OrthographicCamera(-50, 50, 50, -50, -100000, 100000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(200, -200, 200);
    const headlight = new THREE.DirectionalLight("#ffffff", 1.6);
    headlight.position.set(-0.4, 0.6, 1);
    this.camera.add(headlight);
    this.scene.add(new THREE.HemisphereLight("#ffffff", "#9a9a9a", 0.9));
    this.scene.add(this.camera, this.root, this.helperGroup);
    this.root.add(this.bodiesGroup, this.ghostGroup, this.planeGroup, this.sketchGroup, this.sketchLayer, this.explodeGroup, this.sectionGroup);
    this.sketchLayer.renderOrder = 10;
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.18;
    this.controls.zoomToCursor = true;
    this.controls.rotateSpeed = 0.9;
    this.controls.minZoom = 0.01;
    this.controls.maxZoom = 2000;
    this.setMouseMode("model");
    this.controls.addEventListener("change", () => this.invalidate());
    this.controls.addEventListener("end", () => this.emitCamera());
    this.transform = new TransformControls(this.camera, this.renderer.domElement);
    this.transform.setSize(0.8);
    this.transform.addEventListener("dragging-changed", (e) => {
      this.controls.enabled = !e.value;
      if (!e.value) {
        const object = this.transform.object;
        if (!object?.userData.componentId) return;
        const delta = object.position.clone().sub(new THREE.Vector3(...(object.userData.origin as Vec3)));
        if (delta.length() > 1e-6)
          this.onComponentDrag?.(object.userData.componentId, delta.toArray() as Vec3);
      }
    });
    this.transform.addEventListener("change", () => this.invalidate());
    this.scene.add(this.transform.getHelper());
    this.cube = new ViewCube(this);
    this.triad = new Triad();
    const resize = new ResizeObserver(() => this.resize());
    resize.observe(host);
    this.resize();
    const loop = () => {
      if (this.disposed) return;
      this.frame = requestAnimationFrame(loop);
      this.step();
    };
    loop();
    this.disposeHooks.push(() => resize.disconnect());
  }
  private disposeHooks: (() => void)[] = [];
  setMouseMode(mode: "model" | "sketch" | "orbit") {
    this.controls.mouseButtons = {
      LEFT: mode === "sketch" ? (null as any) : THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.ROTATE,
      RIGHT: THREE.MOUSE.PAN,
    };
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  }
  invalidate() {
    this.needsRender = true;
  }
  private resize() {
    const rect = this.host.getBoundingClientRect();
    this.size = { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
    this.renderer.setSize(this.size.width, this.size.height);
    const aspect = this.size.width / this.size.height,
      h = 100;
    this.camera.left = (-h * aspect) / 2;
    this.camera.right = (h * aspect) / 2;
    this.camera.top = h / 2;
    this.camera.bottom = -h / 2;
    this.camera.updateProjectionMatrix();
    for (const m of this.lineMaterials) m.resolution.set(this.size.width, this.size.height);
    this.invalidate();
  }
  private emitCamera() {
    this.onCameraChange?.(
      this.camera.position.toArray() as Vec3,
      this.controls.target.toArray() as Vec3,
    );
  }
  /** World units per CSS pixel at the target depth (orthographic, so uniform). */
  pixelSize() {
    return (this.camera.top - this.camera.bottom) / this.camera.zoom / this.size.height;
  }
  private step() {
    if (this.tween) {
      const t = Math.min(1, (performance.now() - this.tween.start) / this.tween.duration),
        k = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const { from, to } = this.tween;
      const dirFrom = from.position.clone().sub(from.target).normalize(),
        dirTo = to.position.clone().sub(to.target).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(dirFrom, dirTo);
      const qk = new THREE.Quaternion().slerp(q, k);
      const target = from.target.clone().lerp(to.target, k);
      const distance = THREE.MathUtils.lerp(
        from.position.distanceTo(from.target),
        to.position.distanceTo(to.target),
        k,
      );
      this.controls.target.copy(target);
      this.camera.position.copy(target).add(dirFrom.applyQuaternion(qk).multiplyScalar(distance));
      this.camera.up.copy(from.up.clone().lerp(to.up, k).normalize());
      this.camera.zoom = THREE.MathUtils.lerp(from.zoom, to.zoom, k);
      this.camera.updateProjectionMatrix();
      this.camera.lookAt(target);
      if (t >= 1) {
        this.tween = undefined;
        this.camera.up.copy(to.up);
        this.controls.update();
        this.emitCamera();
      }
      this.needsRender = true;
    } else this.controls.update();
    if (!this.needsRender) return;
    this.needsRender = false;
    this.updateOutlines();
    for (const m of this.dashMaterials) m.dashScale = 1 / this.pixelSize();
    for (const update of this.labelUpdaters) update();
    this.updatePlaneLabels();
    this.renderer.setScissorTest(false);
    this.renderer.clear();
    this.renderer.setViewport(0, 0, this.size.width, this.size.height);
    this.renderer.render(this.scene, this.camera);
    this.cube.render(this.renderer, this.camera, this.size);
    this.triad.render(this.renderer, this.camera, this.size);
  }
  addLabelUpdater(fn: () => void) {
    this.labelUpdaters.add(fn);
    this.invalidate();
    return () => this.labelUpdaters.delete(fn);
  }
  /** CSS pixel position of a world point inside the host. */
  toScreen(p: THREE.Vector3 | Vec3): [number, number, boolean] {
    const v = (Array.isArray(p) ? new THREE.Vector3(...p) : p.clone()).project(this.camera);
    return [
      ((v.x + 1) / 2) * this.size.width,
      ((1 - v.y) / 2) * this.size.height,
      v.z > -1 && v.z < 1,
    ];
  }
  ray(clientX: number, clientY: number) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.camera);
    return raycaster;
  }
  /** Intersection of the pointer ray with a sketch plane, in plane coordinates. */
  planePoint(clientX: number, clientY: number, frame: Frame): [number, number] | null {
    const ray = this.ray(clientX, clientY).ray;
    const n = new THREE.Vector3(...frame.normal),
      o = new THREE.Vector3(...frame.origin);
    const denom = ray.direction.dot(n);
    if (Math.abs(denom) < 1e-9) return null;
    const t = o.clone().sub(ray.origin).dot(n) / denom;
    const p = ray.origin.clone().addScaledVector(ray.direction, t).sub(o);
    return [p.dot(new THREE.Vector3(...frame.xDir)), p.dot(new THREE.Vector3(...frame.yDir))];
  }
  cubeHit(clientX: number, clientY: number) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return this.cube.hit(clientX - rect.left, clientY - rect.top, this.size);
  }
  cubeHover(clientX: number | null, clientY = 0) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (this.cube.hover(clientX === null ? null : [clientX - rect.left, clientY - rect.top], this.size))
      this.invalidate();
  }
  // -------------------------------------------------------------------------
  // Camera
  private contentBox() {
    const box = new THREE.Box3();
    for (const r of this.bodies.values()) if (r.mesh.visible || r.mesh.userData.pickOnly) box.expandByObject(r.mesh);
    for (const o of this.ghostGroup.children) box.expandByObject(o);
    for (const o of this.sketchGroup.children) box.expandByObject(o);
    for (const o of this.sketchLayer.children) if (!o.userData.noFit) box.expandByObject(o);
    if (box.isEmpty()) box.set(new THREE.Vector3(-40, -40, -10), new THREE.Vector3(40, 40, 10));
    return box;
  }
  private zoomFor(radius: number) {
    const h = this.camera.top - this.camera.bottom,
      w = this.camera.right - this.camera.left;
    return Math.min(h, w) / (radius * 2.4);
  }
  orient(type: Orientation, animate = true) {
    const box = this.contentBox(),
      sphere = box.getBoundingSphere(new THREE.Sphere());
    const dir =
      type === "fit"
        ? this.camera.position.clone().sub(this.controls.target).normalize()
        : new THREE.Vector3(...directions[type]).normalize();
    const up = type === "fit" ? this.camera.up.clone() : upFor(dir);
    this.moveCamera(dir, sphere.center, up, this.zoomFor(Math.max(sphere.radius, 5)), animate);
  }
  /** Look straight at a plane (sketch "normal to"). */
  normalTo(frame: Frame, animate = true, keepZoom = false) {
    const dir = new THREE.Vector3(...frame.normal),
      up = new THREE.Vector3(...frame.yDir);
    const box = this.contentBox(),
      sphere = box.getBoundingSphere(new THREE.Sphere());
    const center = keepZoom ? this.controls.target.clone() : sphere.center;
    // Keep the view centered on the content projected onto the plane.
    // An empty sketch opens at a working scale of roughly 120 mm across.
    this.moveCamera(dir, center, up, keepZoom ? this.camera.zoom : this.zoomFor(Math.max(sphere.radius, 50)), animate);
  }
  /** Rotate to look along a world direction, keeping the target and zoom. */
  lookAlong(direction: Vec3, animate = true) {
    const dir = new THREE.Vector3(...direction).normalize();
    this.moveCamera(dir, this.controls.target.clone(), upFor(dir), this.camera.zoom, animate);
  }
  private moveCamera(dir: THREE.Vector3, target: THREE.Vector3, up: THREE.Vector3, zoom: number, animate: boolean) {
    const distance = 2000;
    const to = {
      position: target.clone().addScaledVector(dir, distance),
      target: target.clone(),
      up: up.clone(),
      zoom,
    };
    if (!animate) {
      this.camera.position.copy(to.position);
      this.controls.target.copy(to.target);
      this.camera.up.copy(to.up);
      this.camera.zoom = zoom;
      this.camera.updateProjectionMatrix();
      this.camera.lookAt(to.target);
      this.controls.update();
      this.invalidate();
      this.emitCamera();
      return;
    }
    this.tween = {
      from: {
        position: this.camera.position.clone(),
        target: this.controls.target.clone(),
        up: this.camera.up.clone(),
        zoom: this.camera.zoom,
      },
      to,
      start: performance.now(),
      duration: 320,
    };
    this.invalidate();
  }
  restoreCamera(position: Vec3, target: Vec3) {
    const dir = new THREE.Vector3(...position).sub(new THREE.Vector3(...target)).normalize();
    this.camera.position.copy(new THREE.Vector3(...target).addScaledVector(dir, 2000));
    this.controls.target.set(...target);
    this.camera.up.copy(upFor(dir));
    this.controls.update();
    this.invalidate();
  }
  // -------------------------------------------------------------------------
  // Materials
  lineMaterial(color: string, width = 1.4, extra: Partial<THREE.ShaderMaterialParameters & { dashed: boolean; dashSize: number; gapSize: number; vertexColors: boolean }> = {}) {
    const m = new LineMaterial({
      color: new THREE.Color(color).getHex(),
      linewidth: width,
      worldUnits: false,
      ...extra,
    } as any);
    m.resolution.set(this.size.width, this.size.height);
    this.lineMaterials.add(m);
    return m;
  }
  releaseLineMaterial(m: LineMaterial) {
    this.lineMaterials.delete(m);
    this.dashMaterials.delete(m);
    m.dispose();
  }
  /** A texture's maps, made once and shared by every body that uses it. */
  private textureMaps(id: Texture) {
    let maps = this.textures.get(id);
    if (!maps) {
      const canvases = textureCanvases(id),
        anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      const map = (canvas: HTMLCanvasElement, srgb: boolean) => {
        const t = new THREE.CanvasTexture(canvas);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = anisotropy;
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        return t;
      };
      maps = { color: map(canvases.color, true), ...(canvases.height ? { height: map(canvases.height, false) } : {}) };
      this.textures.set(id, maps);
    }
    return maps;
  }
  /** Face materials: the body's look, then selected and hovered. */
  private faceMaterials(color: string, opacity = 1, style: DisplayStyle = "shaded-edges", texture?: Texture) {
    const common = {
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
      transparent: opacity < 1,
      opacity,
      depthWrite: opacity >= 1,
    };
    let base: THREE.Material;
    if (style === "wireframe") base = new THREE.MeshBasicMaterial({ ...common, visible: false });
    // Hidden-line styles: flat white faces that only hide what is behind them.
    else if (style === "hidden-removed" || style === "hidden-visible") base = new THREE.MeshBasicMaterial({ color: palette.white, ...common });
    else if (texture) {
      const info = textureInfo(texture),
        maps = this.textureMaps(texture);
      base = new THREE.MeshStandardMaterial({
        color,
        map: maps.color,
        roughness: info.roughness,
        metalness: info.metalness,
        ...(maps.height ? { bumpMap: maps.height, bumpScale: 1.5 } : {}),
        ...common,
      });
    } else base = new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0, ...common });
    // In wireframe a picked face shows as a light tint.
    const marked = style === "wireframe" ? { ...common, transparent: true, opacity: 0.3, depthWrite: false } : common;
    const selected = new THREE.MeshStandardMaterial({ color: palette.accent, roughness: 0.8, metalness: 0, ...marked });
    const hovered = new THREE.MeshStandardMaterial({ color: palette.slate, roughness: 0.8, metalness: 0, ...marked });
    const list = [base, selected, hovered];
    this.materials.push(...list);
    return list;
  }
  // -------------------------------------------------------------------------
  // Bodies
  private clearGroup(group: THREE.Group) {
    for (const child of [...group.children]) {
      child.traverse((o: any) => {
        o.geometry?.dispose?.();
        const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const m of mats) {
          if (m instanceof LineMaterial) this.releaseLineMaterial(m);
          else m.dispose?.();
        }
      });
      group.remove(child);
    }
  }
  /**
   * Section view: cut the model with a plane, keeping the side where
   * normal · p ≤ offset, and cap the cut so solids read as solid.
   */
  setSection(section: { normal: Vec3; offset: number } | null) {
    this.section = section ? new THREE.Plane(new THREE.Vector3(...section.normal).normalize().negate(), section.offset) : null;
    this.renderer.localClippingEnabled = !!this.section;
    this.applySection();
  }
  private applySection() {
    const planes = this.section ? [this.section] : [];
    const clip = (m: THREE.Material) => {
      m.clippingPlanes = planes;
      m.needsUpdate = true;
    };
    for (const r of this.bodies.values()) {
      (r.mesh.material as THREE.Material[]).forEach(clip);
      for (const o of recordObjects(r).slice(1)) clip(o.material as THREE.Material);
    }
    this.ghostGroup.traverse((o: any) => (Array.isArray(o.material) ? o.material.forEach(clip) : o.material && clip(o.material)));
    // Stencil passes share the body geometry; only materials and the cap are owned here.
    for (const child of [...this.sectionGroup.children]) {
      const m = (child as THREE.Mesh).material as THREE.Material;
      m.dispose();
      if (child.userData.ownGeometry) (child as THREE.Mesh).geometry.dispose();
      this.sectionGroup.remove(child);
    }
    if (this.section) {
      const box = new THREE.Box3();
      for (const r of this.bodies.values()) {
        if (r.mesh.userData.pickOnly) continue;
        r.mesh.geometry.computeBoundingBox();
        box.union(r.mesh.geometry.boundingBox!.clone().translate(r.mesh.position));
        for (const [side, op] of [
          [THREE.BackSide, THREE.IncrementWrapStencilOp],
          [THREE.FrontSide, THREE.DecrementWrapStencilOp],
        ] as const) {
          const material = new THREE.MeshBasicMaterial({
            side,
            colorWrite: false,
            depthWrite: false,
            depthTest: false,
            stencilWrite: true,
            stencilFunc: THREE.AlwaysStencilFunc,
            stencilFail: op,
            stencilZFail: op,
            stencilZPass: op,
            clippingPlanes: planes,
          });
          const pass = new THREE.Mesh(r.mesh.geometry, material);
          pass.position.copy(r.mesh.position);
          pass.renderOrder = 20;
          this.sectionGroup.add(pass);
        }
      }
      if (!box.isEmpty()) {
        const size = box.getSize(new THREE.Vector3()).length() * 2 + 10;
        const normal = this.section.normal.clone().negate();
        const cap = new THREE.Mesh(
          new THREE.PlaneGeometry(size, size),
          new THREE.MeshStandardMaterial({
            color: palette.body,
            roughness: 0.9,
            metalness: 0,
            side: THREE.DoubleSide,
            stencilWrite: true,
            stencilRef: 0,
            stencilFunc: THREE.NotEqualStencilFunc,
            stencilFail: THREE.ReplaceStencilOp,
            stencilZFail: THREE.ReplaceStencilOp,
            stencilZPass: THREE.ReplaceStencilOp,
          }),
        );
        cap.userData.ownGeometry = true;
        cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
        // Centered on the model, on the plane normal · p = offset.
        cap.position.copy(box.getCenter(new THREE.Vector3()).projectOnPlane(normal).addScaledVector(normal, this.section.constant));
        cap.renderOrder = 21;
        cap.onAfterRender = (renderer) => renderer.clearStencil();
        this.sectionGroup.add(cap);
      }
    }
    this.invalidate();
  }
  /** Whether a world point lies in the part of the model the section view keeps. */
  private kept(p: THREE.Vector3) {
    return !this.section || this.section.distanceToPoint(p) >= -1e-6;
  }
  /** Move bodies to their exploded positions without rebuilding them, with dashed trails back to where they assemble. */
  setExplode(explode: number, offsets: Record<string, Vec3> = {}) {
    this.clearGroup(this.explodeGroup);
    for (const [id, record] of this.bodies) {
      const offset = new THREE.Vector3(...(offsets[id] ?? [0, 0, 0])).multiplyScalar(explode);
      record.offset.copy(offset);
      for (const o of recordObjects(record)) o.position.copy(offset);
      if (offset.lengthSq() < 1e-6) continue;
      const [lo, hi] = record.body.bounds;
      const center = new THREE.Vector3(...lo).add(new THREE.Vector3(...hi)).multiplyScalar(0.5);
      const geo = new THREE.BufferGeometry().setFromPoints([center, center.clone().add(offset)]);
      const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: palette.slate, dashSize: 3, gapSize: 2, depthTest: false, transparent: true }));
      line.computeLineDistances();
      line.renderOrder = 5;
      this.explodeGroup.add(line);
    }
    if (this.section) this.applySection();
    this.invalidate();
  }
  setGeometry(view: View | null, options: SceneOptions = {}) {
    this.transform.detach();
    this.clearGroup(this.explodeGroup);
    this.clearGroup(this.bodiesGroup);
    this.clearGroup(this.ghostGroup);
    this.bodies.clear();
    this.materials = [];
    if (!view) {
      this.invalidate();
      return;
    }
    const previewIds = new Set(options.ghost?.bodies.map((b) => b.id) ?? []);
    const solidPreview = !!(options.solidPreview && options.ghost);
    for (const body of view.geometry.bodies) {
      if (body.hidden || options.hiddenBodies?.has(body.id)) continue;
      const replaced = solidPreview && previewIds.has(body.id);
      const record = this.buildBody(body, {
        opacity: options.fadeBodies ? 0.35 : options.ghost && !solidPreview ? 0.35 : (body.opacity ?? 1),
        style: options.displayStyle,
        hideTangent: options.tangentEdges === false,
        offset: new THREE.Vector3(...(options.explodeOffsets?.[body.id] ?? [0, 0, 0])).multiplyScalar(options.explode ?? 0),
      });
      if (replaced) {
        // Hidden but still pickable, so selections refer to committed topology.
        record.mesh.material = (record.mesh.material as THREE.Material[]).map((m) => {
          const clone = m.clone();
          clone.visible = false;
          this.materials.push(clone);
          return clone;
        });
        record.mesh.userData.pickOnly = true;
        for (const o of recordObjects(record).slice(1)) o.visible = false;
      }
      this.bodies.set(body.id, record);
      this.bodiesGroup.add(...recordObjects(record));
    }
    this.updateOutlines(true);
    if (options.ghost)
      for (const body of options.ghost.bodies) {
        if (body.hidden) continue;
        if (solidPreview) {
          const record = this.buildBody(body, { opacity: 1, previewTint: true, style: options.displayStyle });
          // Silhouettes are only kept up to date for committed bodies.
          this.ghostGroup.add(record.mesh, record.edges, ...(record.hiddenLines ? [record.hiddenLines] : []));
          for (const unused of [record.outline?.lines, record.highlight]) {
            if (!unused) continue;
            unused.geometry.dispose();
            this.releaseLineMaterial(unused.material as LineMaterial);
          }
        } else {
          const [mat] = this.faceMaterials(palette.accent, 0.4);
          const mesh = new THREE.Mesh(this.meshGeometry(body), mat);
          mesh.renderOrder = 5;
          this.ghostGroup.add(mesh);
        }
      }
    this.applyHighlight();
    if (this.section) this.applySection();
    this.invalidate();
  }
  private meshGeometry(body: RenderBody) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(body.mesh.vertices, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(body.mesh.normals, 3));
    geo.setIndex(body.mesh.triangles);
    return geo;
  }
  private buildBody(
    body: RenderBody,
    o: { opacity: number; style?: DisplayStyle; offset?: THREE.Vector3; previewTint?: boolean; hideTangent?: boolean },
  ): BodyRecord {
    const style = body.style ?? o.style ?? "shaded-edges",
      texture = style === "shaded" || style === "shaded-edges" ? body.texture : undefined;
    let geo = this.meshGeometry(body);
    for (const g of body.mesh.faceGroups) geo.addGroup(g.start, g.count, 0);
    if (texture) geo = this.boxMapped(geo, body, textureInfo(texture).tile);
    const color = body.color?.toLowerCase() === "#86a7a0" ? palette.body : (body.color || palette.body);
    const mats = this.faceMaterials(color, o.opacity, style, texture);
    if (o.previewTint && "emissive" in mats[0]) (mats[0] as THREE.MeshStandardMaterial).emissive = new THREE.Color(palette.accent).multiplyScalar(0.12);
    const faceMaterials=new Map<string,number>();
    if(!texture) body.mesh.faceGroups.forEach((g,i)=>{
      if(!g.color)return;
      let index=faceMaterials.get(g.color);
      if(index===undefined){index=mats.length;mats.push(this.faceMaterials(g.color,o.opacity,style)[0]);faceMaterials.set(g.color,index);}
      geo.groups[i].materialIndex=index;
    });
    const baseMaterials=geo.groups.map(g=>g.materialIndex ?? 0);
    const mesh = new THREE.Mesh(geo, mats);
    mesh.userData = { bodyId: body.id, faceGroups: body.mesh.faceGroups, baseMaterials };
    const offset = o.offset ?? new THREE.Vector3();
    mesh.position.copy(offset);
    // Edges: one fat-line object per body with per-segment colors.
    const lines = body.edges.lines;
    const segments: number[] = [],
      segmentEdge: string[] = [],
      ranges = new Map<string, { start: number; count: number }>();
    const tangent = o.hideTangent ? new Set(body.tangentEdges ?? []) : undefined;
    for (const g of body.edges.edgeGroups) {
      if (tangent?.has(g.id)) continue;
      const start = segments.length / 6;
      for (let i = g.start; i + 1 < g.start + g.count; i += 2)
        segments.push(lines[i * 3], lines[i * 3 + 1], lines[i * 3 + 2], lines[i * 3 + 3], lines[i * 3 + 4], lines[i * 3 + 5]);
      const count = segments.length / 6 - start;
      ranges.set(g.id, { start, count });
      for (let k = 0; k < count; k++) segmentEdge.push(g.id);
    }
    // Cosmetic threads: light rings at the pitch along the threaded length
    // (at most 60), drawn after the edges so they are never picked as edges.
    const edgeCount = segments.length;
    for (const t of body.threads ?? []) {
      const n = new THREE.Vector3(...t.direction).normalize(),
        u = new THREE.Vector3(Math.abs(n.x) < 0.9 ? 1 : 0, Math.abs(n.x) < 0.9 ? 0 : 1, 0).cross(n).normalize(),
        w = n.clone().cross(u);
      const rings = Math.max(2, Math.min(60, Math.floor(t.length / t.pitch))),
        radius = t.radius * (t.internal ? 0.995 : 1.005);
      for (let k = 0; k <= rings; k++) {
        const c = new THREE.Vector3(...t.origin).addScaledVector(n, (t.length * k) / rings);
        for (let i = 0; i < 40; i++) {
          const p0 = c.clone().addScaledVector(u, radius * Math.cos((i / 40) * 2 * Math.PI)).addScaledVector(w, radius * Math.sin((i / 40) * 2 * Math.PI)),
            p1 = c.clone().addScaledVector(u, radius * Math.cos(((i + 1) / 40) * 2 * Math.PI)).addScaledVector(w, radius * Math.sin(((i + 1) / 40) * 2 * Math.PI));
          segments.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
        }
      }
    }
    const edgeGeo = new LineSegmentsGeometry();
    const positions = new Float32Array(segments);
    edgeGeo.setPositions(positions.length ? positions : new Float32Array(6));
    const colors = new Float32Array(Math.max(positions.length, 6));
    const ink = new THREE.Color(palette.ink),
      slate = new THREE.Color(palette.slate);
    for (let i = 0; i < colors.length; i += 3) colors.set(i < edgeCount ? [ink.r, ink.g, ink.b] : [slate.r, slate.g, slate.b], i);
    edgeGeo.setColors(colors);
    const material = this.lineMaterial(palette.ink, 1.25, { vertexColors: true, transparent: o.opacity < 1, opacity: o.opacity < 1 ? 0.4 : 1 } as any);
    const edges = new LineSegments2(edgeGeo, material);
    edges.position.copy(offset);
    edges.userData = { bodyId: body.id };
    // Shaded draws no edges: they stay pickable, and only picked ones show.
    let highlight: LineSegments2 | undefined;
    if (style === "shaded") {
      edges.visible = false;
      const g = new LineSegmentsGeometry();
      g.setPositions(new Float32Array(6));
      highlight = new LineSegments2(g, this.lineMaterial(palette.ink, 1.25, { vertexColors: true } as any));
      highlight.position.copy(offset);
      highlight.visible = false;
    }
    // Hidden Lines Visible: the same edges again, dashed, drawn only where a face is nearer.
    let hiddenLines: LineSegments2 | undefined;
    if (style === "hidden-visible" && edgeCount) {
      const g = new LineSegmentsGeometry();
      g.setPositions(positions.subarray(0, edgeCount));
      const dashed = this.lineMaterial(palette.slate, 1, { dashed: true, dashSize: 5, gapSize: 3, transparent: true, depthWrite: false, depthFunc: THREE.GreaterDepth } as any);
      this.dashMaterials.add(dashed);
      hiddenLines = new LineSegments2(g, dashed);
      hiddenLines.computeLineDistances();
      hiddenLines.position.copy(offset);
    }
    const outline = o.opacity === 1 && style !== "shaded" ? this.outlineCandidates(body) : undefined;
    let outlineLines: LineSegments2 | undefined;
    if (outline?.length) {
      const g = new LineSegmentsGeometry();
      g.setPositions(new Float32Array(6));
      outlineLines = new LineSegments2(g, this.lineMaterial(palette.ink, 1.25));
      outlineLines.position.copy(offset);
      outlineLines.userData = { bodyId: body.id, outline: true };
    }
    return {
      body,
      mesh,
      edges,
      edgeColors: colors,
      edgeRanges: ranges,
      segments: positions,
      segmentEdge,
      offset,
      style,
      ...(outline?.length && outlineLines ? { outline: { candidates: outline, lines: outlineLines } } : {}),
      ...(hiddenLines ? { hiddenLines } : {}),
      ...(highlight ? { highlight } : {}),
    };
  }
  /**
   * Texture coordinates by box mapping: each triangle takes the plane its
   * normal points along most, in millimeters from the body's corner, so the
   * pattern keeps its size and follows the body when it moves.
   */
  private boxMapped(indexed: THREE.BufferGeometry, body: RenderBody, tile: number) {
    const geo = indexed.toNonIndexed();
    indexed.dispose();
    const p = geo.getAttribute("position"),
      uv = new Float32Array(p.count * 2),
      [x0, y0, z0] = body.bounds[0];
    const a = new THREE.Vector3(),
      b = new THREE.Vector3(),
      c = new THREE.Vector3();
    for (let i = 0; i < p.count; i += 3) {
      a.fromBufferAttribute(p, i);
      b.fromBufferAttribute(p, i + 1);
      c.fromBufferAttribute(p, i + 2);
      const n = b.sub(a).cross(c.sub(a));
      const ax = Math.abs(n.x),
        ay = Math.abs(n.y),
        az = Math.abs(n.z);
      for (let k = i; k < i + 3; k++) {
        const x = p.getX(k) - x0,
          y = p.getY(k) - y0,
          z = p.getZ(k) - z0;
        const [u, v] = az >= ax && az >= ay ? [x, y] : ay >= ax ? [x, z] : [y, z];
        uv[k * 2] = u / tile;
        uv[k * 2 + 1] = v / tile;
      }
    }
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    return geo;
  }
  /**
   * Mesh edges inside curved faces where the surface could turn away from the
   * viewer: each with its endpoints and the normals of its two triangles.
   * Vertices are welded by position, so seams of closed surfaces join up.
   */
  private outlineCandidates(body: RenderBody): Float32Array {
    const curved = new Set(body.topology.filter((t) => t.kind === "face" && t.geomType !== "PLANE").map((t) => t.id));
    const v = body.mesh.vertices,
      tri = body.mesh.triangles,
      out: number[] = [];
    const key = (i: number) => `${Math.round(v[i * 3] * 1e5)},${Math.round(v[i * 3 + 1] * 1e5)},${Math.round(v[i * 3 + 2] * 1e5)}`;
    for (const g of body.mesh.faceGroups) {
      if (!curved.has(g.id)) continue;
      const weld = new Map<string, number>(),
        id = (i: number) => {
          const k = key(i);
          if (!weld.has(k)) weld.set(k, i);
          return weld.get(k)!;
        };
      const normal = (t: number) => {
        const [a, b, c] = [tri[t], tri[t + 1], tri[t + 2]].map((i) => new THREE.Vector3(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]));
        return b.sub(a).cross(c.sub(a)).normalize();
      };
      const shared = new Map<string, { a: number; b: number; tris: number[] }>();
      for (let t = g.start; t < g.start + g.count; t += 3)
        for (const [p, q] of [
          [tri[t], tri[t + 1]],
          [tri[t + 1], tri[t + 2]],
          [tri[t + 2], tri[t]],
        ]) {
          const a = id(p),
            b = id(q),
            k = a < b ? `${a}|${b}` : `${b}|${a}`;
          const e = shared.get(k) ?? { a: p, b: q, tris: [] };
          e.tris.push(t);
          shared.set(k, e);
        }
      for (const e of shared.values()) {
        if (e.tris.length !== 2) continue;
        const n1 = normal(e.tris[0]),
          n2 = normal(e.tris[1]);
        if (n1.dot(n2) > 0.99999) continue;
        out.push(v[e.a * 3], v[e.a * 3 + 1], v[e.a * 3 + 2], v[e.b * 3], v[e.b * 3 + 1], v[e.b * 3 + 2], n1.x, n1.y, n1.z, n2.x, n2.y, n2.z);
      }
    }
    return new Float32Array(out);
  }
  private outlineView = new THREE.Vector3();
  /** Redraw silhouettes when the view direction changes: edges between front- and back-facing triangles. */
  private updateOutlines(force = false) {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    if (!force && dir.distanceToSquared(this.outlineView) < 1e-10) return;
    this.outlineView.copy(dir);
    for (const r of this.bodies.values()) {
      if (!r.outline) continue;
      const c = r.outline.candidates,
        seg: number[] = [];
      for (let i = 0; i < c.length; i += 12) {
        const f1 = c[i + 6] * dir.x + c[i + 7] * dir.y + c[i + 8] * dir.z,
          f2 = c[i + 9] * dir.x + c[i + 10] * dir.y + c[i + 11] * dir.z;
        if (f1 * f2 < 0) seg.push(c[i], c[i + 1], c[i + 2], c[i + 3], c[i + 4], c[i + 5]);
      }
      const g = r.outline.lines.geometry as LineSegmentsGeometry;
      g.setPositions(new Float32Array(seg.length ? seg : [0, 0, 0, 0, 0, 0]));
      r.outline.lines.visible = seg.length > 0 && r.edges.visible;
    }
  }
  /** Attach the translate gizmo to a body's displayed position (assembly component moves). */
  attachGizmo(componentId: string, bodyIds: string[], position: Vec3) {
    this.transform.detach();
    const records = bodyIds.map((id) => this.bodies.get(id)).filter(Boolean) as BodyRecord[];
    if (!records.length) return;
    const wrapper = new THREE.Group();
    wrapper.position.set(...position);
    wrapper.userData = { componentId, origin: position };
    for (const r of records)
      for (const o of recordObjects(r)) {
        o.position.sub(wrapper.position);
        wrapper.add(o);
      }
    this.bodiesGroup.add(wrapper);
    this.transform.attach(wrapper);
    this.invalidate();
  }
  setSelection(refs: TopologyRef[], planes: string[] = []) {
    this.selection = new Set(refs.map((r) => r.id));
    this.selectedPlanes = new Set(planes);
    this.applyHighlight();
    this.updatePlaneStyles();
  }
  setHover(pick: ScenePick | null) {
    const next =
      pick?.kind === "face" || pick?.kind === "edge"
        ? { id: pick.ref.id }
        : pick?.kind === "plane"
          ? { plane: pick.planeId }
          : {};
    if (next.id === this.hover.id && next.plane === this.hover.plane) return;
    this.hover = next;
    this.applyHighlight();
    this.updatePlaneStyles();
  }
  private applyHighlight() {
    const accent = new THREE.Color(palette.accent),
      ink = new THREE.Color(palette.ink),
      slate = new THREE.Color(palette.slate);
    for (const r of this.bodies.values()) {
      const geo = r.mesh.geometry;
      r.body.mesh.faceGroups.forEach((g, i) => {
        if (!geo.groups[i]) return;
        geo.groups[i].materialIndex = this.selection.has(g.id) ? 1 : this.hover.id === g.id ? 2 : (r.mesh.userData.baseMaterials?.[i] ?? 0);
      });
      for (const [id, range] of r.edgeRanges) {
        const c = this.selection.has(id) ? accent : this.hover.id === id ? slate : ink;
        for (let k = range.start; k < range.start + range.count; k++) r.edgeColors.set([c.r, c.g, c.b, c.r, c.g, c.b], k * 6);
      }
      const attr = (r.edges.geometry as any).attributes.instanceColorStart;
      if (attr) {
        attr.data.array.set(r.edgeColors);
        attr.data.needsUpdate = true;
      }
      if (r.highlight) {
        const positions: number[] = [],
          colors: number[] = [];
        for (const [id, range] of r.edgeRanges) {
          if (!this.selection.has(id) && this.hover.id !== id) continue;
          positions.push(...r.segments.subarray(range.start * 6, (range.start + range.count) * 6));
          colors.push(...r.edgeColors.subarray(range.start * 6, (range.start + range.count) * 6));
        }
        const g = r.highlight.geometry as LineSegmentsGeometry;
        g.setPositions(positions.length ? new Float32Array(positions) : new Float32Array(6));
        g.setColors(colors.length ? new Float32Array(colors) : new Float32Array(6));
        r.highlight.visible = positions.length > 0 && !r.mesh.userData.pickOnly;
      }
      // Selected edges stay visible even through a solid preview.
      if (r.mesh.userData.pickOnly) r.edges.visible = [...r.edgeRanges.keys()].some((id) => this.selection.has(id));
    }
    this.invalidate();
  }
  // -------------------------------------------------------------------------
  // Datum planes
  setPlanes(list: PlaneDisplay[]) {
    for (const p of this.planes) p.label.remove();
    this.clearGroup(this.planeGroup);
    this.planes = list.map((p) => {
      const geo = new THREE.PlaneGeometry(p.size, p.size);
      const mat = new THREE.MeshBasicMaterial({
        color: palette.slate,
        transparent: true,
        opacity: 0.07,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      const basis = new THREE.Matrix4().makeBasis(
        new THREE.Vector3(...p.frame.xDir),
        new THREE.Vector3(...p.frame.yDir),
        new THREE.Vector3(...p.frame.normal),
      );
      mesh.quaternion.setFromRotationMatrix(basis);
      mesh.position.set(...p.frame.origin);
      mesh.userData = { planeId: p.id };
      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: palette.slate, transparent: true, opacity: 0.7 }),
      );
      outline.quaternion.copy(mesh.quaternion);
      outline.position.copy(mesh.position);
      this.planeGroup.add(mesh, outline);
      const label = document.createElement("div");
      label.className = "plane-label";
      label.textContent = p.name;
      this.overlay.appendChild(label);
      return { ...p, mesh, outline, label };
    });
    this.updatePlaneStyles();
    this.invalidate();
  }
  private updatePlaneStyles() {
    for (const p of this.planes) {
      const selected = this.selectedPlanes.has(p.id),
        hovered = this.hover.plane === p.id;
      (p.mesh.material as THREE.MeshBasicMaterial).color.set(selected ? palette.accent : palette.slate);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = selected ? 0.16 : hovered ? 0.14 : 0.07;
      (p.outline.material as THREE.LineBasicMaterial).color.set(selected ? palette.accent : palette.slate);
      p.label.classList.toggle("active", selected || hovered);
    }
    this.invalidate();
  }
  private updatePlaneLabels() {
    for (const p of this.planes) {
      const corner = new THREE.Vector3(...p.frame.origin)
        .addScaledVector(new THREE.Vector3(...p.frame.xDir), -p.size / 2)
        .addScaledVector(new THREE.Vector3(...p.frame.yDir), p.size / 2);
      const [x, y, visible] = this.toScreen(corner);
      p.label.style.transform = `translate(${x + 4}px, ${y + 2}px)`;
      p.label.style.display = visible ? "" : "none";
    }
  }
  // -------------------------------------------------------------------------
  // Picking
  pick(clientX: number, clientY: number, filter: PickFilter = { faces: true, edges: true }): ScenePick {
    const raycaster = this.ray(clientX, clientY);
    // Wireframe bodies have no faces to pick or to hide edges behind.
    const meshes = [...this.bodies.values()].filter((r) => r.style !== "wireframe").map((r) => r.mesh);
    // The part of the model a section view removes cannot be picked.
    const faceHit = raycaster.intersectObjects(meshes, false).find((h) => this.kept(h.point));
    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = clientX - rect.left,
      py = clientY - rect.top;
    if (filter.edges) {
      const edge = this.pickEdge(px, py, faceHit?.distance ?? Infinity, raycaster);
      if (edge) return edge;
    }
    if (filter.faces && faceHit) {
      const mesh = faceHit.object as THREE.Mesh,
        groups = mesh.userData.faceGroups as RenderBody["mesh"]["faceGroups"];
      const index = (faceHit.faceIndex ?? 0) * 3;
      const group = groups.find((g) => index >= g.start && index < g.start + g.count);
      const record = this.bodies.get(mesh.userData.bodyId);
      const t = record?.body.topology.find((t) => t.id === group?.id);
      if (t)
        return {
          kind: "face",
          ref: { id: t.id, bodyId: t.bodyId, kind: "face", signature: t.signature, geomType: t.geomType, point: faceHit.point.toArray() as Vec3 },
          point: faceHit.point.toArray() as Vec3,
        };
    }
    if (filter.planes && this.planes.length) {
      const hit = raycaster.intersectObjects(this.planes.map((p) => p.mesh), false)[0];
      if (hit && (!faceHit || hit.distance < faceHit.distance))
        return { kind: "plane", planeId: hit.object.userData.planeId, point: hit.point.toArray() as Vec3 };
    }
    return { kind: "none" };
  }
  private pickEdge(px: number, py: number, faceDistance: number, raycaster: THREE.Raycaster): ScenePick | null {
    const threshold = 6;
    let best: { d: number; id: string; record: BodyRecord; point: THREE.Vector3 } | undefined;
    const a = new THREE.Vector3(),
      b = new THREE.Vector3();
    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    const origin = raycaster.ray.origin;
    for (const record of this.bodies.values()) {
      const s = record.segments,
        world = record.edges.matrixWorld;
      for (let i = 0; i < record.segmentEdge.length; i++) {
        a.set(s[i * 6], s[i * 6 + 1], s[i * 6 + 2]).applyMatrix4(world);
        b.set(s[i * 6 + 3], s[i * 6 + 4], s[i * 6 + 5]).applyMatrix4(world);
        const [ax, ay] = this.toScreen(a),
          [bx, by] = this.toScreen(b);
        const dx = bx - ax,
          dy = by - ay,
          l2 = dx * dx + dy * dy;
        const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
        const d = Math.hypot(ax + t * dx - px, ay + t * dy - py);
        if (d > threshold || (best && d >= best.d)) continue;
        const point = a.clone().lerp(b, t);
        // Occluded edges sit behind the first face hit.
        const depth = point.clone().sub(origin).dot(camDir);
        if (depth > faceDistance + Math.max(0.5, this.pixelSize() * 4)) continue;
        best = { d, id: record.segmentEdge[i], record, point };
      }
    }
    if (!best) return null;
    const t = best.record.body.topology.find((t) => t.id === best!.id);
    if (!t) return null;
    return {
      kind: "edge",
      ref: { id: t.id, bodyId: t.bodyId, kind: "edge", signature: t.signature, geomType: t.geomType, point: best.point.toArray() as Vec3 },
      point: best.point.toArray() as Vec3,
    };
  }
  // -------------------------------------------------------------------------
  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    for (const h of this.disposeHooks) h();
    this.transform.dispose();
    this.controls.dispose();
    this.clearGroup(this.bodiesGroup);
    this.clearGroup(this.ghostGroup);
    this.clearGroup(this.planeGroup);
    this.clearGroup(this.sketchGroup);
    this.clearGroup(this.sketchLayer);
    this.cube.dispose();
    for (const maps of this.textures.values()) {
      maps.color.dispose();
      maps.height?.dispose();
    }
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.overlay.remove();
  }
}

// ---------------------------------------------------------------------------
// View cube: faces, edges and corners are clickable regions.
const CUBE_SIZE = 108;
const CUBE_MARGIN = 10;
function faceTexture(text: string) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = palette.slate;
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, 250, 250);
  ctx.fillStyle = palette.ink;
  ctx.font = "600 44px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 128, 132);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
class ViewCube {
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 20);
  private cube!: THREE.Mesh;
  private regions: THREE.Mesh[] = [];
  private hovered?: THREE.Mesh;
  private textures: THREE.Texture[] = [];
  constructor(private owner: CadScene) {
    // Six labelled faces, each oriented from its outward normal and "up" so text reads correctly from outside.
    const faces: [string, Vec3, Vec3][] = [
      ["FRONT", [0, -1, 0], [0, 0, 1]],
      ["BACK", [0, 1, 0], [0, 0, 1]],
      ["RIGHT", [1, 0, 0], [0, 0, 1]],
      ["LEFT", [-1, 0, 0], [0, 0, 1]],
      ["TOP", [0, 0, 1], [0, 1, 0]],
      ["BOTTOM", [0, 0, -1], [0, -1, 0]],
    ];
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(1.98, 1.98, 1.98), new THREE.MeshBasicMaterial({ color: palette.white }));
    this.scene.add(this.cube);
    for (const [label, n, up] of faces) {
      const t = faceTexture(label);
      this.textures.push(t);
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: t }));
      const normal = new THREE.Vector3(...n),
        upward = new THREE.Vector3(...up),
        right = upward.clone().cross(normal);
      plane.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, upward, normal));
      plane.position.copy(normal);
      this.scene.add(plane);
    }
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)),
      new THREE.LineBasicMaterial({ color: palette.slate }),
    );
    this.scene.add(edges);
    // Hover regions: 26 boxes covering faces, edges and corners.
    for (const x of [-1, 0, 1])
      for (const y of [-1, 0, 1])
        for (const z of [-1, 0, 1]) {
          if (!x && !y && !z) continue;
          const size = [x ? 0.4 : 1.2, y ? 0.4 : 1.2, z ? 0.4 : 1.2];
          const geo = new THREE.BoxGeometry(size[0] + 0.03, size[1] + 0.03, size[2] + 0.03);
          const mat = new THREE.MeshBasicMaterial({ color: palette.accent, transparent: true, opacity: 0, depthWrite: false });
          const m = new THREE.Mesh(geo, mat);
          m.position.set(x * 0.8, y * 0.8, z * 0.8);
          m.userData = { dir: [x, y, z] };
          this.regions.push(m);
          this.scene.add(m);
        }
  }
  private viewport(size: { width: number; height: number }) {
    return { x: size.width - CUBE_SIZE - CUBE_MARGIN, y: size.height - CUBE_SIZE - CUBE_MARGIN, w: CUBE_SIZE, h: CUBE_SIZE };
  }
  render(renderer: THREE.WebGLRenderer, main: THREE.Camera, size: { width: number; height: number }) {
    const vp = this.viewport(size);
    const dir = new THREE.Vector3();
    main.getWorldDirection(dir);
    this.camera.position.copy(dir.multiplyScalar(-6));
    this.camera.up.copy(main.up);
    this.camera.lookAt(0, 0, 0);
    renderer.setScissorTest(true);
    renderer.setScissor(vp.x, vp.y, vp.w, vp.h);
    renderer.setViewport(vp.x, vp.y, vp.w, vp.h);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
  }
  private intersect(x: number, y: number, size: { width: number; height: number }) {
    const vp = this.viewport(size);
    const top = size.height - vp.y - vp.h;
    if (x < vp.x || x > vp.x + vp.w || y < top || y > top + vp.h) return undefined;
    const ndc = new THREE.Vector2(((x - vp.x) / vp.w) * 2 - 1, -((y - top) / vp.h) * 2 + 1);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.camera);
    if (!raycaster.intersectObject(this.cube, false).length) return null;
    return raycaster.intersectObjects(this.regions, false)[0]?.object as THREE.Mesh | undefined;
  }
  /** Returns a world view direction when the pointer is over the cube. */
  hit(x: number, y: number, size: { width: number; height: number }): Vec3 | undefined | null {
    const region = this.intersect(x, y, size);
    if (region === undefined) return undefined;
    if (!region) return null;
    return region.userData.dir as Vec3;
  }
  hover(point: [number, number] | null, size: { width: number; height: number }) {
    const region = point ? this.intersect(point[0], point[1], size) ?? undefined : undefined;
    if (region === this.hovered) return false;
    if (this.hovered) (this.hovered.material as THREE.MeshBasicMaterial).opacity = 0;
    this.hovered = region ?? undefined;
    if (this.hovered) (this.hovered.material as THREE.MeshBasicMaterial).opacity = 0.45;
    return true;
  }
  dispose() {
    this.textures.forEach((t) => t.dispose());
    this.scene.traverse((o: any) => {
      o.geometry?.dispose?.();
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: any) => m?.dispose?.());
    });
    void this.owner;
  }
}

// Small XYZ triad in the lower-left corner. Axis colors keep their standard meaning.
class Triad {
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1.4, 1.4, 1.4, -1.4, 0.1, 20);
  constructor() {
    const axes: [Vec3, string][] = [
      [[1, 0, 0], "#B34238"],
      [[0, 1, 0], "#34834F"],
      [[0, 0, 1], "#2B74B9"],
    ];
    for (const [d, color] of axes) {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(...d)]);
      this.scene.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color })));
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: this.letter(d[0] ? "X" : d[1] ? "Y" : "Z", color), depthTest: false }),
      );
      sprite.position.set(...(d.map((v) => v * 1.25) as Vec3));
      sprite.scale.set(0.42, 0.42, 1);
      this.scene.add(sprite);
    }
  }
  private letter(text: string, color: string) {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = color;
    ctx.font = "600 44px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 32, 34);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  render(renderer: THREE.WebGLRenderer, main: THREE.Camera, size: { width: number; height: number }) {
    const s = 64;
    const dir = new THREE.Vector3();
    main.getWorldDirection(dir);
    this.camera.position.copy(dir.multiplyScalar(-6));
    this.camera.up.copy(main.up);
    this.camera.lookAt(0, 0, 0);
    renderer.setScissorTest(true);
    renderer.setScissor(6, 6, s, s);
    renderer.setViewport(6, 6, s, s);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
    void size;
  }
}

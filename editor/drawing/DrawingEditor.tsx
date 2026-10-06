// Drawing workspace: interactive sheet with views, smart dimensions and
// annotations, plus the sheet tree and the properties panel.
import { useEffect, useMemo, useRef, useState } from "react";
import type { DrawingEdge, DrawingProjection, DrawingSheet, Vec2, View, ViewOrientation } from "../../cad/types.ts";
import { Icons, type IconName } from "../cad-icons.tsx";
import { Check, Choice, NumberField } from "../ui.tsx";
import type { Cad } from "../state.ts";
import { strip } from "../panels/dialogs.tsx";

export type DrawingTool =
  | null
  | { kind: "model"; orientation: ViewOrientation }
  | { kind: "flat" }
  | { kind: "projected" }
  | { kind: "section"; axis: "horizontal" | "vertical" }
  | { kind: "detail" }
  | { kind: "dimension" }
  /** Pick the zero, place the row, then each feature; `dimensionId` once placed. */
  | { kind: "ordinate"; dimensionId?: string }
  | { kind: "hole" }
  | { kind: "centermark" }
  | { kind: "centerline" }
  | { kind: "note" }
  | { kind: "balloon" }
  | { kind: "bom" }
  | { kind: "surface" }
  | { kind: "datum" }
  | { kind: "gdt" }
  | { kind: "weld" };
export type DrawingSelection =
  | { kind: "sheet" }
  | { kind: "view"; id: string }
  | { kind: "dimension"; id: string }
  | { kind: "annotation"; id: string }
  | null;
interface Rendered {
  svg: string;
  width: number;
  height: number;
  revision: number;
  views: DrawingProjection[];
  labels: { id: string; view: string; at: Vec2 }[];
}
interface EdgePick {
  view: DrawingProjection;
  edge: DrawingEdge;
  anchor: "start" | "end" | "center" | "edge";
  at: Vec2;
}
const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function segDist(p: Vec2, a: Vec2, b: Vec2) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    l2 = dx * dx + dy * dy;
  const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}
const viewName = (o: string) => o[0].toUpperCase() + o.slice(1);
/** SolidWorks-style placement: above/below a span → horizontal, beside → vertical. */
function linearMode(a: Vec2, b: Vec2, at: Vec2): "horizontal" | "vertical" | "aligned" {
  const minX = Math.min(a[0], b[0]),
    maxX = Math.max(a[0], b[0]),
    minY = Math.min(a[1], b[1]),
    maxY = Math.max(a[1], b[1]);
  if (maxX - minX < 1e-6) return "vertical";
  if (maxY - minY < 1e-6) return "horizontal";
  const inX = at[0] > minX && at[0] < maxX,
    inY = at[1] > minY && at[1] < maxY;
  if (inX && !inY) return "horizontal";
  if (inY && !inX) return "vertical";
  return "aligned";
}

export function DrawingEditor({
  cad,
  view,
  sheetId,
  tool,
  onTool,
  selection,
  onSelect,
}: {
  cad: Cad;
  view: View;
  sheetId: string | null;
  tool: DrawingTool;
  onTool: (t: DrawingTool) => void;
  selection: DrawingSelection;
  onSelect: (s: DrawingSelection) => void;
}) {
  const sheet = view.document.drawings?.find((d) => d.id === sheetId);
  const [rendered, setRendered] = useState<Rendered | null>(null),
    [error, setError] = useState(""),
    [nav, setNav] = useState({ zoom: 1, x: 0, y: 0 }),
    [box, setBox] = useState({ width: 1000, height: 700 }),
    [hover, setHover] = useState<EdgePick | null>(null),
    [picks, setPicks] = useState<EdgePick[]>([]),
    [anchor, setAnchor] = useState<{ view: DrawingProjection; at: Vec2; radius?: number } | null>(null),
    [pointer, setPointer] = useState<Vec2 | null>(null),
    [note, setNote] = useState<{ at: Vec2; text: string } | null>(null);
  const host = useRef<HTMLDivElement>(null),
    svgHost = useRef<HTMLDivElement>(null),
    drag = useRef<{ kind: "pan" | "view" | "dimension" | "annotation"; id?: string; start: Vec2; client: Vec2; moved: boolean; nav?: typeof nav } | null>(null);
  // Render whenever the model or the sheet changes.
  useEffect(() => {
    if (!sheet) {
      setRendered(null);
      return;
    }
    let live = true;
    setError("");
    void cad
      .execute<Rendered>("render_drawing", { drawingId: sheet.id })
      .then((r) => live && setRendered(r))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [sheet?.id, view.document.revision]);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setBox({ width: r.width, height: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    setNav({ zoom: 1, x: 0, y: 0 });
    setPicks([]);
    setAnchor(null);
  }, [sheetId]);
  useEffect(() => {
    setPicks([]);
    setAnchor(null);
    setNote(null);
  }, [JSON.stringify(tool)]);
  const W = rendered?.width ?? 297,
    H = rendered?.height ?? 210;
  const base = Math.min((box.width - 48) / W, (box.height - 48) / H);
  const scale = base * nav.zoom;
  const offset: Vec2 = [(box.width - W * scale) / 2 + nav.x, (box.height - H * scale) / 2 + nav.y];
  const toSheet = (clientX: number, clientY: number): Vec2 => {
    const r = host.current!.getBoundingClientRect();
    return [(clientX - r.left - offset[0]) / scale, (clientY - r.top - offset[1]) / scale];
  };
  // Wheel zoom about the cursor.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setNav((n) => {
        const zoom = Math.max(0.3, Math.min(12, n.zoom * Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0015))));
        const k = zoom / n.zoom;
        const cx = e.clientX - r.left - box.width / 2,
          cy = e.clientY - r.top - box.height / 2;
        return { zoom, x: cx - (cx - n.x) * k, y: cy - (cy - n.y) * k };
      });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [box.width, box.height]);
  const svgMarkup = useMemo(
    () => (rendered ? rendered.svg.replace(/width="[\d.]+mm" height="[\d.]+mm"/, 'width="100%" height="100%"') : ""),
    [rendered?.svg],
  );
  const viewAt = (p: Vec2) =>
    rendered?.views.find((v) => p[0] >= v.bounds[0] - 4 && p[0] <= v.bounds[0] + v.bounds[2] + 4 && p[1] >= v.bounds[1] - 4 && p[1] <= v.bounds[1] + v.bounds[3] + 4);
  const edgeAt = (p: Vec2): EdgePick | null => {
    if (!rendered) return null;
    const reach = 7 / scale;
    let best: EdgePick | null = null,
      bestD = reach;
    for (const v of rendered.views)
      for (const e of v.edges ?? []) {
        if (!e.visible) continue;
        for (let i = 0; i + 1 < e.points.length; i++) {
          const d = segDist(p, e.points[i], e.points[i + 1]);
          if (d < bestD) {
            bestD = d;
            let a: EdgePick["anchor"] = e.circle ? "center" : "edge";
            if (!e.circle && e.points.length >= 2) {
              if (dist(p, e.points[0]) < reach * 1.2) a = "start";
              else if (dist(p, e.points[e.points.length - 1]) < reach * 1.2) a = "end";
            }
            best = { view: v, edge: e, anchor: a, at: p };
          }
        }
      }
    return best;
  };
  const toModel = (v: DrawingProjection, p: Vec2): Vec2 => [(p[0] - v.origin![0]) / v.scale!, -(p[1] - v.origin![1]) / v.scale!];
  const viewCenter = (id: string) => sheet?.views?.find((v) => v.id === id)?.position ?? [0, 0];
  const run = (name: string, args: Record<string, any>) => cad.execute(name, { drawingId: sheet!.id, ...args }).catch((e) => setError((e as Error).message));
  const nextDatum = () => {
    const used = new Set((sheet?.annotations ?? []).flatMap((a) => (a.type === "datum" ? [a.label] : [])));
    return [..."ABCDEFGHJKLMNP"].find((l) => !used.has(l)) ?? "Z";
  };
  // ---------------------------------------------------------------------------
  const click = (p: Vec2, additive: boolean, target: Element | null) => {
    if (!sheet || !rendered) return;
    const edge = edgeAt(p);
    const v = viewAt(p);
    if (!tool) {
      const dim = target?.closest("[data-dimension]")?.getAttribute("data-dimension");
      const ann = target?.closest("[data-annotation]")?.getAttribute("data-annotation");
      if (dim) return onSelect({ kind: "dimension", id: dim });
      if (ann) return onSelect({ kind: "annotation", id: ann });
      if (v) return onSelect({ kind: "view", id: v.name });
      return onSelect(additive ? selection : { kind: "sheet" });
    }
    switch (tool.kind) {
      case "model":
        void run("add_drawing_view", { kind: "base", orientation: tool.orientation, position: p, hiddenLines: !["iso", "dimetric", "trimetric"].includes(tool.orientation) });
        onTool(null);
        return;
      case "flat":
        void run("add_drawing_view", { kind: "flat", position: p });
        onTool(null);
        return;
      case "projected": {
        if (!anchor) {
          const parent = v ?? rendered.views.find((x) => selection?.kind === "view" && x.name === selection.id);
          if (parent && parent.kind !== "detail") setAnchor({ view: parent, at: [parent.bounds[0] + parent.bounds[2] / 2, parent.bounds[1] + parent.bounds[3] / 2] });
          return;
        }
        const dx = p[0] - anchor.at[0],
          dy = p[1] - anchor.at[1];
        const side = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "below" : "above";
        void run("add_drawing_view", { kind: "projected", parentId: anchor.view.name, side, position: p });
        onTool(null);
        return;
      }
      case "section": {
        if (!anchor) {
          if (!v || v.kind === "detail" || !v.origin) return;
          setAnchor({ view: v, at: p });
          return;
        }
        const pv = anchor.view,
          [x0, y0, w, h] = pv.bounds;
        const a: Vec2 = tool.axis === "horizontal" ? [x0 - 4, anchor.at[1]] : [anchor.at[0], y0 + h + 4];
        const b: Vec2 = tool.axis === "horizontal" ? [x0 + w + 4, anchor.at[1]] : [anchor.at[0], y0 - 4];
        void run("add_drawing_view", { kind: "section", parentId: pv.name, a: toModel(pv, a), b: toModel(pv, b), position: p });
        onTool(null);
        return;
      }
      case "detail": {
        if (!anchor) {
          if (!v || !v.origin) return;
          setAnchor({ view: v, at: p });
          return;
        }
        if (anchor.radius === undefined) {
          setAnchor({ ...anchor, radius: Math.max(2, dist(anchor.at, p)) });
          return;
        }
        void run("add_drawing_view", { kind: "detail", parentId: anchor.view.name, center: toModel(anchor.view, anchor.at), radius: anchor.radius / anchor.view.scale!, position: p });
        onTool(null);
        return;
      }
      case "ordinate": {
        // Holes by their centers, lines by the picked end or their middle.
        const point = (k: EdgePick) => ({ ref: strip(k.edge.ref), anchor: k.edge.circle ? "center" : k.anchor === "start" || k.anchor === "end" ? k.anchor : "mid" });
        const placed = tool.dimensionId ? sheet.dimensions.find((x) => x.id === tool.dimensionId) : undefined;
        if (placed) {
          // Each further pick in the same view adds a feature; a click on empty paper finishes.
          if (!edge) return onTool(null);
          if (edge.view.name !== placed.view) return;
          void run("update_drawing_dimension", { dimensionId: placed.id, points: [...(placed.points ?? []), point(edge)] });
          return;
        }
        if (!picks.length) {
          if (edge) setPicks([edge]);
          return;
        }
        // The row's side sets the axis: above or below measures across, beside measures up.
        const zero = picks[0],
          from = zero.edge.circle ? zero.edge.circle.center : zero.at,
          center = viewCenter(zero.view.name);
        const axis = Math.abs(p[1] - from[1]) >= Math.abs(p[0] - from[0]) ? "horizontal" : "vertical";
        setPicks([]);
        void cad
          .execute<View>("add_drawing_dimension", { drawingId: sheet.id, view: zero.view.name, type: "ordinate", axis, points: [point(zero)], position: [p[0] - center[0], p[1] - center[1]] })
          .then((result) => {
            const id = result.document.drawings?.find((x) => x.id === sheet.id)?.dimensions.at(-1)?.id;
            if (id) onTool({ kind: "ordinate", dimensionId: id });
          })
          .catch((e) => setError((e as Error).message));
        return;
      }
      case "dimension": {
        if (edge && picks.length < 2) {
          if (edge.edge.circle && !picks.length) {
            setPicks([edge]);
            return;
          }
          if (picks.length === 1 && picks[0].edge.ref.id === edge.edge.ref.id && picks[0].anchor === edge.anchor) return;
          setPicks([...picks, edge]);
          return;
        }
        if (!picks.length) return;
        const first = picks[0];
        const vid = first.view.name,
          center = viewCenter(vid);
        const position: Vec2 = [p[0] - center[0], p[1] - center[1]];
        const point = (k: EdgePick) => ({ ref: strip(k.edge.ref), anchor: k.anchor });
        if (picks.length === 1 && first.edge.circle) {
          const closed = dist(first.edge.points[0], first.edge.points[first.edge.points.length - 1]) < 1e-3;
          void run("add_drawing_dimension", { view: vid, type: closed ? "diameter" : "radius", points: [point(first)], position });
        } else if (picks.length === 1) {
          const pts = first.edge.points;
          void run("add_drawing_dimension", { view: vid, type: linearMode(pts[0], pts[pts.length - 1], p), points: [{ ref: strip(first.edge.ref), anchor: "edge" }], position });
        } else {
          const [a, b] = picks;
          const loc = (k: EdgePick): Vec2 =>
            k.edge.circle ? k.edge.circle.center : k.anchor === "start" ? k.edge.points[0] : k.anchor === "end" ? k.edge.points[k.edge.points.length - 1] : k.at;
          const bothLines = a.anchor === "edge" && b.anchor === "edge" && !a.edge.circle && !b.edge.circle;
          if (bothLines) {
            const da = [a.edge.points.at(-1)![0] - a.edge.points[0][0], a.edge.points.at(-1)![1] - a.edge.points[0][1]],
              db = [b.edge.points.at(-1)![0] - b.edge.points[0][0], b.edge.points.at(-1)![1] - b.edge.points[0][1]];
            const sin = Math.abs(da[0] * db[1] - da[1] * db[0]) / (Math.hypot(da[0], da[1]) * Math.hypot(db[0], db[1]) || 1);
            void run("add_drawing_dimension", { view: vid, type: sin > 1e-3 ? "angle" : "aligned", points: [point(a), point(b)], position });
          } else {
            const pa = loc(a),
              pb = loc(b);
            const type = a.anchor === "edge" || b.anchor === "edge" ? "aligned" : linearMode(pa, pb, p);
            void run("add_drawing_dimension", { view: vid, type, points: [point(a), point(b)], position });
          }
        }
        setPicks([]);
        return;
      }
      case "hole":
      case "centermark": {
        if (!picks.length) {
          if (edge?.edge.circle) {
            if (tool.kind === "centermark") {
              void run("add_drawing_annotation", { annotation: { type: "centermark", view: edge.view.name, ref: strip(edge.edge.ref) } });
              return;
            }
            setPicks([edge]);
          }
          return;
        }
        const k = picks[0],
          center = viewCenter(k.view.name);
        void run("add_drawing_dimension", { view: k.view.name, type: "hole", points: [{ ref: strip(k.edge.ref), anchor: "center" }], position: [p[0] - center[0], p[1] - center[1]] });
        setPicks([]);
        return;
      }
      case "centerline": {
        if (!edge || edge.edge.circle) return;
        if (!picks.length) {
          setPicks([edge]);
          return;
        }
        void run("add_drawing_annotation", { annotation: { type: "centerline", view: picks[0].view.name, refs: [strip(picks[0].edge.ref), strip(edge.edge.ref)] } });
        setPicks([]);
        return;
      }
      case "note":
        setNote({ at: p, text: "" });
        return;
      case "bom":
        void run("add_drawing_annotation", { annotation: { type: "bom", position: p } });
        onTool(null);
        return;
      case "balloon":
      case "surface":
      case "datum":
      case "gdt":
      case "weld": {
        if (!picks.length) {
          if (edge) setPicks([edge]);
          return;
        }
        const k = picks[0],
          base = { view: k.view.name, ref: strip(k.edge.ref), position: p };
        const annotation =
          tool.kind === "balloon"
            ? { type: "balloon", ...base }
            : tool.kind === "surface"
              ? { type: "surface", ...base, roughness: "Ra 3.2" }
              : tool.kind === "datum"
                ? { type: "datum", ...base, label: nextDatum() }
                : tool.kind === "weld"
                  ? { type: "weld", ...base }
                  : { type: "gdt", ...base, characteristic: k.edge.circle ? "position" : "flatness", tolerance: 0.1, diametral: !!k.edge.circle, datums: k.edge.circle ? ["A"] : [] };
        void run("add_drawing_annotation", { annotation });
        setPicks([]);
        return;
      }
    }
  };
  // ---------------------------------------------------------------------------
  const onPointerDown = (e: React.PointerEvent) => {
    if (!sheet) return;
    const p = toSheet(e.clientX, e.clientY);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (e.button === 1 || e.button === 2 || (e.button === 0 && e.altKey)) {
      drag.current = { kind: "pan", start: p, client: [e.clientX, e.clientY], moved: false, nav };
      return;
    }
    if (e.button !== 0) return;
    if (!tool) {
      const target = e.target as Element;
      const dim = target.closest("[data-dimension]")?.getAttribute("data-dimension");
      const ann = target.closest("[data-annotation]")?.getAttribute("data-annotation");
      const v = viewAt(p);
      if (dim) drag.current = { kind: "dimension", id: dim, start: p, client: [e.clientX, e.clientY], moved: false };
      else if (ann && sheet.annotations?.find((a) => a.id === ann && "position" in a)) drag.current = { kind: "annotation", id: ann, start: p, client: [e.clientX, e.clientY], moved: false };
      else if (v) drag.current = { kind: "view", id: v.name, start: p, client: [e.clientX, e.clientY], moved: false };
      else drag.current = { kind: "pan", start: p, client: [e.clientX, e.clientY], moved: false, nav };
      return;
    }
    drag.current = { kind: "pan", start: p, client: [e.clientX, e.clientY], moved: false, nav };
  };
  const moveGroup = (selector: string, dx: number, dy: number) => {
    const g = svgHost.current?.querySelector(selector);
    if (g) g.setAttribute("transform", `translate(${dx} ${dy})`);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = toSheet(e.clientX, e.clientY);
    setPointer(p);
    const d = drag.current;
    if (d && e.buttons) {
      if (Math.hypot(e.clientX - d.client[0], e.clientY - d.client[1]) > 3) d.moved = true;
      if (!d.moved) return;
      if (d.kind === "pan") {
        setNav({ ...d.nav!, x: d.nav!.x + e.clientX - d.client[0], y: d.nav!.y + e.clientY - d.client[1] });
        return;
      }
      let [dx, dy] = [p[0] - d.start[0], p[1] - d.start[1]];
      if (d.kind === "view") {
        const v = sheet?.views?.find((x) => x.id === d.id);
        const parent = v?.parentId && sheet?.views?.find((x) => x.id === v.parentId);
        if (v?.kind === "projected" && parent) {
          const horizontal = Math.abs(v.position[0] - parent.position[0]) > Math.abs(v.position[1] - parent.position[1]);
          if (horizontal) dy = 0;
          else dx = 0;
        }
        moveGroup(`[data-view="${CSS.escape(d.id!)}"]`, dx, dy);
      } else if (d.kind === "dimension") moveGroup(`[data-dimension="${CSS.escape(d.id!)}"]`, dx, dy);
      else moveGroup(`[data-annotation="${CSS.escape(d.id!)}"]`, dx, dy);
      return;
    }
    if (tool && ["dimension", "ordinate", "hole", "centermark", "centerline", "balloon", "surface", "datum", "gdt", "weld"].includes(tool.kind)) setHover(edgeAt(p));
    else if (hover) setHover(null);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    const p = toSheet(e.clientX, e.clientY);
    if (!d || !sheet) return;
    if (!d.moved) {
      if (e.button === 0 && !e.altKey) click(p, e.shiftKey || e.metaKey, e.target as Element);
      return;
    }
    if (d.kind === "pan") return;
    const dx = p[0] - d.start[0],
      dy = p[1] - d.start[1];
    if (d.kind === "view") {
      const v = sheet.views?.find((x) => x.id === d.id);
      if (v) void run("update_drawing_view", { viewId: v.id, position: [v.position[0] + dx, v.position[1] + dy] });
      onSelect({ kind: "view", id: d.id! });
    } else if (d.kind === "dimension") {
      const label = rendered?.labels.find((l) => l.id === d.id);
      const dim = sheet.dimensions.find((x) => x.id === d.id);
      if (label && dim) {
        const c = viewCenter(dim.view);
        void run("update_drawing_dimension", { dimensionId: dim.id, position: [label.at[0] + dx - c[0], label.at[1] + dy - c[1]] });
      }
      onSelect({ kind: "dimension", id: d.id! });
    } else {
      const a = sheet.annotations?.find((x) => x.id === d.id) as any;
      if (a?.position) void run("update_drawing_annotation", { annotationId: a.id, position: [a.position[0] + dx, a.position[1] + dy] });
      onSelect({ kind: "annotation", id: d.id! });
    }
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === "Escape") {
        if (picks.length || anchor) {
          setPicks([]);
          setAnchor(null);
        } else if (tool) onTool(null);
        else onSelect(null);
      }
      if (e.key.toLowerCase() === "f" && !e.metaKey && !e.ctrlKey) setNav({ zoom: 1, x: 0, y: 0 });
      if ((e.key === "Delete" || e.key === "Backspace") && sheet && selection) {
        if (selection.kind === "view") void run("remove_drawing_view", { viewId: selection.id });
        if (selection.kind === "dimension") void run("remove_drawing_dimension", { dimensionId: selection.id });
        if (selection.kind === "annotation") void run("remove_drawing_annotation", { annotationId: selection.id });
        onSelect(null);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  // ---------------------------------------------------------------------------
  // Overlay content in sheet coordinates.
  const overlay: React.ReactNode[] = [];
  const poly = (pts: Vec2[], key: string, cls: string) => <polyline key={key} className={cls} points={pts.map((q) => q.join(",")).join(" ")} />;
  if (hover) overlay.push(poly(hover.edge.points, "hover", "dw-hover"));
  picks.forEach((k, i) => overlay.push(poly(k.edge.points, `pick${i}`, "dw-pick")));
  const selView = selection?.kind === "view" ? rendered?.views.find((v) => v.name === selection.id) : undefined;
  if (selView) overlay.push(<rect key="selview" className="dw-selected" x={selView.bounds[0] - 3} y={selView.bounds[1] - 3} width={selView.bounds[2] + 6} height={selView.bounds[3] + 6} />);
  if (anchor && pointer && tool?.kind === "projected") {
    const v = anchor.view;
    const dx = pointer[0] - anchor.at[0],
      dy = pointer[1] - anchor.at[1];
    const horizontal = Math.abs(dx) > Math.abs(dy);
    const c: Vec2 = horizontal ? [pointer[0], anchor.at[1]] : [anchor.at[0], pointer[1]];
    overlay.push(<rect key="ghost" className="dw-ghost" x={c[0] - v.bounds[2] / 2} y={c[1] - v.bounds[3] / 2} width={v.bounds[2]} height={v.bounds[3]} />);
  }
  if (tool?.kind === "section" && (anchor || pointer)) {
    const at = anchor?.at ?? pointer!;
    const v = anchor?.view ?? (pointer ? viewAt(pointer) : undefined);
    if (v) {
      const [x0, y0, w, h] = v.bounds;
      const line = tool.axis === "horizontal" ? [[x0 - 4, at[1]], [x0 + w + 4, at[1]]] : [[at[0], y0 - 4], [at[0], y0 + h + 4]];
      overlay.push(<polyline key="cut" className="dw-cut" points={line.map((q) => q.join(",")).join(" ")} />);
    }
  }
  if (tool?.kind === "detail" && anchor && pointer)
    overlay.push(<circle key="detail" className="dw-cut" cx={anchor.at[0]} cy={anchor.at[1]} r={anchor.radius ?? Math.max(1, dist(anchor.at, pointer))} />);
  const hint =
    !sheet
      ? ""
      : tool?.kind === "flat"
        ? "Place the flat pattern"
        : tool?.kind === "projected"
        ? anchor
          ? "Place the projected view"
          : "Select the parent view"
        : tool?.kind === "section"
          ? anchor
            ? "Place the section view"
            : "Click through the parent view to cut"
          : tool?.kind === "detail"
            ? !anchor
              ? "Click the detail center"
              : anchor.radius === undefined
                ? "Click to set the radius"
                : "Place the detail view"
            : tool?.kind === "dimension"
              ? picks.length
                ? "Pick another edge or click to place"
                : "Pick an edge, hole or two points"
              : "";
  return (
    <div
      className={`drawing-canvas ${tool ? "tool" : ""}`}
      ref={host}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setHover(null)}
      onContextMenu={(e) => e.preventDefault()}
      aria-label="Drawing sheet"
    >
      {selection && (selection.kind === "dimension" || selection.kind === "annotation") && (
        <style>{`.sheet-svg [data-${selection.kind}="${selection.id.replace(/[^a-zA-Z0-9-]/g, "")}"] path { stroke: #CE8147; } .sheet-svg [data-${selection.kind}="${selection.id.replace(/[^a-zA-Z0-9-]/g, "")}"] text { fill: #CE8147; }`}</style>
      )}
      {rendered && (
        <div className="sheet" style={{ width: W * scale, height: H * scale, transform: `translate(${offset[0]}px, ${offset[1]}px)` }}>
          <div className="sheet-svg" ref={svgHost} dangerouslySetInnerHTML={{ __html: svgMarkup }} />
          <svg className="sheet-overlay" viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" style={{ ["--px" as any]: String(1 / scale) }}>
            {overlay}
          </svg>
        </div>
      )}
      {note && (
        <textarea
          className="note-editor"
          autoFocus
          style={{ left: offset[0] + note.at[0] * scale, top: offset[1] + note.at[1] * scale }}
          value={note.text}
          placeholder="Note"
          onChange={(e) => setNote({ ...note, text: e.target.value })}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") setNote(null);
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (note.text.trim()) void run("add_drawing_annotation", { annotation: { type: "note", position: [note.at[0], note.at[1] + 2.5], text: note.text.trim() } });
              setNote(null);
              onTool(null);
            }
          }}
        />
      )}
      {!sheet && <div className="drawing-empty">Create a sheet from the model.</div>}
      {hint && <div className="drawing-hint">{hint}</div>}
      {error && (
        <div className="error-line" role="alert" onClick={() => setError("")}>
          {error}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
export function DrawingTree({
  view,
  sheetId,
  selection,
  onSheet,
  onSelect,
  onContext,
}: {
  view: View;
  sheetId: string | null;
  selection: DrawingSelection;
  onSheet: (id: string) => void;
  onSelect: (s: DrawingSelection) => void;
  onContext: (sheet: DrawingSheet, x: number, y: number) => void;
}) {
  const icon: Record<string, IconName> = { base: "drawingView", projected: "projectedView", section: "sectionView", detail: "detailView", flat: "edgeFlange" };
  return (
    <div className="feature-tree" role="tree" aria-label="Drawing sheets">
      {(view.document.drawings ?? []).map((d) => {
        const active = d.id === sheetId;
        return (
          <div key={d.id} role="group">
            <div
              role="treeitem"
              aria-selected={active && selection?.kind === "sheet"}
              className={`tree-row ${active && (selection?.kind === "sheet" || !selection) ? "selected" : ""}`}
              onClick={() => {
                onSheet(d.id);
                onSelect({ kind: "sheet" });
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                onContext(d, e.clientX, e.clientY);
              }}
            >
              <span className="tree-expander" />
              <span className="tree-icon">
                <Icons.sheet size={15} />
              </span>
              <span className="tree-label">{d.name}</span>
              <span className="tree-note">{d.size}</span>
            </div>
            {active &&
              (d.views ?? []).map((v) => {
                const I = Icons[icon[v.kind]];
                const selected = selection?.kind === "view" && selection.id === v.id;
                return (
                  <div
                    key={v.id}
                    role="treeitem"
                    aria-selected={selected}
                    className={`tree-row ${selected ? "selected" : ""}`}
                    style={{ paddingLeft: 26 }}
                    onClick={() => onSelect({ kind: "view", id: v.id })}
                  >
                    <span className="tree-expander" />
                    <span className="tree-icon">
                      <I size={15} />
                    </span>
                    <span className="tree-label">{v.name}</span>
                  </div>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
function TextField({ label, value, onCommit, multiline = false }: { label: string; value: string; onCommit: (v: string) => void; multiline?: boolean }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const props = {
    value: draft,
    "aria-label": label,
    onChange: (e: any) => setDraft(e.target.value),
    onBlur: () => draft !== value && onCommit(draft),
    onKeyDown: (e: any) => {
      e.stopPropagation();
      if (e.key === "Enter" && !(multiline && e.shiftKey)) (e.target as HTMLElement).blur();
      if (e.key === "Escape") setDraft(value);
    },
  };
  return (
    <label className={`field ${multiline ? "field-stack" : ""}`}>
      <span>{label}</span>
      {multiline ? <textarea {...props} rows={3} /> : <input {...props} />}
    </label>
  );
}
export function DrawingProperties({ cad, view, sheetId, selection }: { cad: Cad; view: View; sheetId: string | null; selection: DrawingSelection }) {
  const sheet = view.document.drawings?.find((d) => d.id === sheetId);
  if (!sheet) return <div className="inspector" />;
  const run = (name: string, args: Record<string, any>) => void cad.run(name, { drawingId: sheet.id, ...args });
  const update = (fields: Record<string, any>) => run("update_drawing", fields);
  const v = selection?.kind === "view" ? sheet.views?.find((x) => x.id === selection.id) : undefined;
  const d = selection?.kind === "dimension" ? sheet.dimensions.find((x) => x.id === selection.id) : undefined;
  const a = selection?.kind === "annotation" ? sheet.annotations?.find((x) => x.id === selection.id) : undefined;
  return (
    <div className="inspector">
      <div className="inspector-body props">
        {v ? (
          <>
            <div className="props-title">
              <Icons.drawingView size={16} />
              <strong>{v.name}</strong>
            </div>
            <TextField label="Name" value={v.name} onCommit={(name) => run("update_drawing_view", { viewId: v.id, name })} />
            {v.kind === "base" && (
              <Choice
                label="Orientation"
                value={v.orientation ?? "front"}
                onChange={(orientation) => run("update_drawing_view", { viewId: v.id, orientation })}
                options={["front", "back", "top", "bottom", "left", "right", "iso", "dimetric", "trimetric"].map((o) => ({ value: o, label: viewName(o) }))}
              />
            )}
            <NumberField label="Scale" unit="×" step={0.1} value={v.scale ?? sheet.scale} min={0.001} max={50} onChange={(scale) => run("update_drawing_view", { viewId: v.id, scale })} />
            <Check label="Hidden lines" value={v.hiddenLines ?? sheet.hiddenLines} onChange={(hiddenLines) => run("update_drawing_view", { viewId: v.id, hiddenLines })} />
            <Check label="Label" value={!!v.showLabel || v.kind === "section" || v.kind === "detail"} disabled={v.kind === "section" || v.kind === "detail"} onChange={(showLabel) => run("update_drawing_view", { viewId: v.id, showLabel })} />
            {(view.document.components?.length ?? 0) > 0 && <Check label="Exploded" value={!!v.exploded} onChange={(exploded) => run("update_drawing_view", { viewId: v.id, exploded })} />}
            {v.section && <Check label="Flip direction" value={!!v.section.flip} onChange={(flip) => run("update_drawing_view", { viewId: v.id, flip })} />}
            <div className="props-actions">
              <button className="text-button danger" onClick={() => run("remove_drawing_view", { viewId: v.id })}>
                Delete view
              </button>
            </div>
          </>
        ) : d ? (
          <>
            <div className="props-title">
              <Icons.dimension size={16} />
              <strong>Dimension</strong>
            </div>
            <Choice
              label="Tolerance"
              value={d.tolerance?.kind ?? "none"}
              onChange={(kind) =>
                kind === "none"
                  ? run("update_drawing_dimension", { dimensionId: d.id, clearTolerance: true })
                  : run("update_drawing_dimension", { dimensionId: d.id, tolerance: { kind, upper: d.tolerance?.upper ?? 0.1, ...(kind !== "symmetric" ? { lower: d.tolerance?.lower ?? -0.1 } : {}) } })
              }
              options={[
                { value: "none", label: "None" },
                { value: "symmetric", label: "Symmetric ±" },
                { value: "bilateral", label: "Bilateral" },
                { value: "limits", label: "Limits" },
              ]}
            />
            {d.tolerance && <NumberField label="Upper" value={d.tolerance.upper} min={0} step={0.01} onChange={(upper) => run("update_drawing_dimension", { dimensionId: d.id, tolerance: { ...d.tolerance!, upper } })} />}
            {d.tolerance && d.tolerance.kind !== "symmetric" && (
              <NumberField label="Lower" value={d.tolerance.lower ?? 0} step={0.01} onChange={(lower) => run("update_drawing_dimension", { dimensionId: d.id, tolerance: { ...d.tolerance!, lower } })} />
            )}
            <NumberField label="Decimals" unit="" integer value={d.decimals ?? 2} min={0} max={4} onChange={(decimals) => run("update_drawing_dimension", { dimensionId: d.id, decimals })} />
            <TextField label="Prefix" value={d.prefix ?? ""} onCommit={(prefix) => run("update_drawing_dimension", { dimensionId: d.id, prefix })} />
            <TextField label="Suffix" value={d.suffix ?? ""} onCommit={(suffix) => run("update_drawing_dimension", { dimensionId: d.id, suffix })} />
            <div className="props-actions">
              <button className="text-button danger" onClick={() => run("remove_drawing_dimension", { dimensionId: d.id })}>
                Delete dimension
              </button>
            </div>
          </>
        ) : a ? (
          <>
            <div className="props-title">
              <Icons.note size={16} />
              <strong>{({ note: "Note", balloon: "Balloon", bom: "Bill of materials", centermark: "Center mark", centerline: "Centerline", surface: "Surface finish", datum: "Datum", gdt: "Geometric tolerance", weld: "Weld symbol" } as Record<string, string>)[a.type]}</strong>
            </div>
            {a.type === "note" && <TextField label="Text" multiline value={a.text} onCommit={(text) => run("update_drawing_annotation", { annotationId: a.id, text })} />}
            {a.type === "note" && <NumberField label="Height" value={a.size ?? 3.5} min={1.8} max={10} step={0.5} onChange={(size) => run("update_drawing_annotation", { annotationId: a.id, size })} />}
            {a.type === "balloon" && <NumberField label="Item" unit="" integer value={a.item ?? 1} min={1} max={999} onChange={(item) => run("update_drawing_annotation", { annotationId: a.id, item })} />}
            {a.type === "surface" && <TextField label="Roughness" value={a.roughness} onCommit={(roughness) => run("update_drawing_annotation", { annotationId: a.id, roughness })} />}
            {a.type === "datum" && <TextField label="Letter" value={a.label} onCommit={(label) => run("update_drawing_annotation", { annotationId: a.id, label })} />}
            {a.type === "gdt" && <NumberField label="Tolerance" value={a.tolerance} min={0.0001} step={0.01} onChange={(tolerance) => run("update_drawing_annotation", { annotationId: a.id, tolerance })} />}
            {a.type === "weld" && (
              <>
                <NumberField
                  label="Leg"
                  value={a.leg ?? view?.document.features.find((f) => f.type === "weld" && f.bodyId === a.ref.bodyId)?.params.size ?? 3}
                  min={0.1}
                  step={0.5}
                  onChange={(leg) => run("update_drawing_annotation", { annotationId: a.id, leg })}
                />
                <Check label="Full length" value={a.length === undefined} onChange={(full) => run("update_drawing_annotation", { annotationId: a.id, length: full ? null : 25 })} />
                {a.length !== undefined && <NumberField label="Length" value={a.length} min={0.1} onChange={(length) => run("update_drawing_annotation", { annotationId: a.id, length })} />}
                <Choice
                  label="Side"
                  value={a.sides ?? "arrow"}
                  onChange={(sides) => run("update_drawing_annotation", { annotationId: a.id, sides })}
                  options={[
                    { value: "arrow", label: "Arrow side" },
                    { value: "other", label: "Other side" },
                    { value: "both", label: "Both sides" },
                  ]}
                />
                <Check label="All around" value={!!a.allAround} onChange={(allAround) => run("update_drawing_annotation", { annotationId: a.id, allAround })} />
                <Check label="Field weld" value={!!a.field} onChange={(field) => run("update_drawing_annotation", { annotationId: a.id, field })} />
                <TextField label="Process" value={a.process ?? ""} onCommit={(process) => run("update_drawing_annotation", { annotationId: a.id, process: process.trim() || null })} />
              </>
            )}
            <div className="props-actions">
              <button className="text-button danger" onClick={() => run("remove_drawing_annotation", { annotationId: a.id })}>
                Delete
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="props-title">
              <Icons.sheet size={16} />
              <strong>{sheet.name}</strong>
            </div>
            <TextField label="Sheet name" value={sheet.name} onCommit={(name) => name.trim() && update({ name })} />
            <Choice label="Size" value={sheet.size} onChange={(size) => update({ size })} options={["A4", "A3", "A2", "A1", "A0", "ANSI A", "ANSI B", "ANSI C", "ANSI D"].map((s) => ({ value: s, label: s }))} />
            <Choice label="Orientation" value={sheet.orientation ?? "landscape"} onChange={(orientation) => update({ orientation })} options={[{ value: "landscape", label: "Landscape" }, { value: "portrait", label: "Portrait" }]} />
            <NumberField label="Scale" unit="×" step={0.1} value={sheet.scale} min={0.001} max={20} onChange={(scale) => update({ scale })} />
            <Choice label="Projection" value={sheet.projection} onChange={(projection) => update({ projection })} options={[{ value: "third", label: "Third angle" }, { value: "first", label: "First angle" }]} />
            <Check label="Hidden lines" value={sheet.hiddenLines} onChange={(hiddenLines) => update({ hiddenLines })} />
            <h4>Title block</h4>
            {(
              [
                ["title", "Title"],
                ["drawingNumber", "Drawing no."],
                ["revisionLabel", "Revision"],
                ["material", "Material"],
                ["finish", "Finish"],
                ["author", "Drawn"],
                ["date", "Date"],
                ["checkedBy", "Checked"],
                ["approvedBy", "Approved"],
                ["company", "Company"],
                ["generalTolerance", "Tolerances"],
              ] as const
            ).map(([key, label]) => (
              <TextField key={key} label={label} value={(sheet as any)[key] ?? ""} onCommit={(value) => update({ [key]: value })} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

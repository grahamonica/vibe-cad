import { allComponents } from "./types.ts";
import type { Document } from "./types.ts";
import { solveSketch } from "./solver.ts";
import { validVariableName } from "./equations.ts";
export function validateDocument(d: Document) {
  for (const s of d.sketches) {
    if (
      s.referencePlaneId &&
      !d.referencePlanes?.some((p) => p.id === s.referencePlaneId)
    )
      throw Error("Sketch reference plane is missing");
    solveSketch(s);
  }
  const finiteVector = (v: number[]) =>
    v.length === 3 &&
    v.every((n) => Number.isFinite(n) && Math.abs(n) <= 10000);
  const members = new Set<string>();
  if (
    (d.components?.length ?? 0) > 100 ||
    (d.mates?.length ?? 0) > 200 ||
    (d.drawings?.length ?? 0) > 30 ||
    (d.referencePlanes?.length ?? 0) > 100
  )
    throw Error("Document assembly/drawing limits reached");
  for (const p of d.referencePlanes ?? []) {
    if (!finiteVector(p.origin) || !["XY", "XZ", "YZ"].includes(p.plane))
      throw Error("Invalid reference plane");
    const def = p.definition;
    if (def?.kind === "offset" && (!Number.isFinite(def.distance) || Math.abs(def.distance) > 10000))
      throw Error(`${p.name}: invalid offset`);
    if (def?.kind === "angle" && !Number.isFinite(def.angle)) throw Error(`${p.name}: invalid angle`);
    if (def?.kind === "three-point" && !def.points.every(finiteVector))
      throw Error(`${p.name}: invalid points`);
    if (def?.kind === "three-point") {
      const [a, b, c] = def.points,
        u = b.map((v, i) => v - a[i]),
        w = c.map((v, i) => v - a[i]),
        n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      if (Math.hypot(...n) < 1e-9) throw Error(`${p.name}: the three points are collinear`);
    }
    const planeIds = new Set((d.referencePlanes ?? []).map((x) => x.id));
    const refs = def
      ? def.kind === "offset" || def.kind === "angle"
        ? [def.base]
        : def.kind === "midplane"
          ? [def.a, def.b]
          : []
      : [];
    for (const r of refs)
      if (r.kind === "reference" && (!planeIds.has(r.planeId) || r.planeId === p.id))
        throw Error(`${p.name}: base plane is missing`);
  }
  if (
    d.material &&
    (typeof d.material.name !== "string" ||
      !d.material.name.trim() ||
      d.material.name.length > 80 ||
      !Number.isFinite(d.material.density) ||
      d.material.density <= 0 ||
      d.material.density > 30)
  )
    throw Error("Material needs a name and a density between 0 and 30 g/cm³");
  if (d.material) {
    const { infill, wall } = d.material;
    if (infill !== undefined && !(infill >= 0 && infill <= 100)) throw Error("Infill must be between 0 and 100%");
    if (wall !== undefined && !(wall >= 0 && wall <= 20)) throw Error("Printed wall thickness must be between 0 and 20 mm");
    for (const key of ["modulus", "yield", "tensile", "poisson"] as const)
      if (d.material[key] !== undefined && !(Number.isFinite(d.material[key]) && d.material[key]! >= 0)) throw Error(`Material ${key} must be a positive number`);
  }
  if (d.units !== undefined && d.units !== "mm" && d.units !== "in") throw Error("Units must be mm or in");
  for (const [key, value] of [["Mass override", d.massOverride], ["Weight limit", d.weightLimit]] as const)
    if (value !== undefined && !(Number.isFinite(value) && value > 0 && value < 1e9)) throw Error(`${key} must be a positive mass in grams`);
  const names = new Set<string>();
  if ((d.variables?.length ?? 0) > 200) throw Error("Limit of 200 variables reached");
  for (const v of d.variables ?? []) {
    if (!validVariableName(v.name)) throw Error(`Invalid variable name ${v.name}`);
    if (names.has(v.name)) throw Error(`Duplicate variable ${v.name}`);
    if (typeof v.expression !== "string" || !Number.isFinite(v.value) || (v.description?.length ?? 0) > 200) throw Error(`Invalid variable ${v.name}`);
    names.add(v.name);
  }
  for (const c of d.components ?? []) {
    if (
      !finiteVector(c.position) ||
      !finiteVector(c.rotation) ||
      !finiteVector(c.explode) ||
      (c.source || c.belt ? c.bodyIds.length > 0 : !c.bodyIds.length) ||
      (c.source && c.belt)
    )
      throw Error("Invalid component transform or membership");
    if (c.belt) {
      const [p, q] = c.belt.pulleys ?? [];
      const known = (id: unknown) => typeof id === "string" && allComponents(d).some((x) => x.id === id && !!x.source);
      if (!known(p) || !known(q) || p === q) throw Error(`${c.name}: a belt runs on two different inserted pulleys`);
      if (c.belt.width !== undefined && !(Number.isFinite(c.belt.width) && c.belt.width > 0 && c.belt.width <= 1000)) throw Error(`${c.name}: invalid belt width`);
    }
    if (c.source && (!/^[a-zA-Z0-9_-]{1,80}$/.test(c.source.documentId) || c.source.documentId === d.id))
      throw Error("An assembly cannot insert itself");
    for (const id of c.bodyIds) {
      if (!d.bodies.some((b) => b.id === id) || members.has(id))
        throw Error("A body must belong to exactly one component");
      members.add(id);
    }
  }
  for (const p of d.componentPatterns ?? []) {
    const source = d.components?.find((c) => c.id === p.componentId);
    if (!source?.source) throw Error(`${p.name}: its source component is missing`);
    if (!Number.isInteger(p.count) || p.count < 2 || p.count > 100) throw Error(`${p.name}: 2 to 100 instances`);
    if (p.kind === "linear" && !(Number.isFinite(p.spacing) && (p.spacing ?? 0) > 0)) throw Error(`${p.name}: invalid spacing`);
    if (p.kind === "circular" && !(Number.isFinite(p.angle ?? 360) && (p.angle ?? 360) > 0 && (p.angle ?? 360) <= 360)) throw Error(`${p.name}: invalid angle`);
  }
  for (const sheet of d.drawings ?? []) {
    if (
      !sheet.bodyIds.length ||
      sheet.bodyIds.some(
        (id) =>
          !d.bodies.some((b) => b.id === id) &&
          !allComponents(d).some((c) => (c.source || c.belt) && id.startsWith(`${c.id}/`)),
      )
    )
      throw Error("Drawing source body is missing");
    if (!Number.isFinite(sheet.scale) || sheet.scale <= 0 || sheet.scale > 20)
      throw Error("Invalid drawing scale");
    if (sheet.dimensions.length > 200)
      throw Error("Limit of 200 sheet dimensions reached");
    const finite2 = (v: unknown) =>
      Array.isArray(v) && v.length === 2 && v.every((n) => Number.isFinite(n) && Math.abs(n) <= 10000);
    const viewIds = new Set<string>();
    for (const v of sheet.views ?? []) {
      if (viewIds.has(v.id)) throw Error("Drawing view ids must be unique");
      viewIds.add(v.id);
      if (!finite2(v.position)) throw Error(`${v.name}: invalid view position`);
      if (v.scale !== undefined && !(v.scale > 0 && v.scale <= 50)) throw Error(`${v.name}: invalid view scale`);
      if (v.section && (!finite2(v.section.a) || !finite2(v.section.b))) throw Error(`${v.name}: invalid section line`);
      if (v.detail && (!finite2(v.detail.center) || !(v.detail.radius > 0))) throw Error(`${v.name}: invalid detail circle`);
    }
    for (const v of sheet.views ?? [])
      if (v.parentId && !viewIds.has(v.parentId)) throw Error(`${v.name}: its parent view is missing`);
    const known = sheet.views?.length ? viewIds : new Set(["front", "top", "right", "iso"]);
    const inSources = (ref: { bodyId: string }) => {
      if (!sheet.bodyIds.includes(ref.bodyId))
        throw Error("Dimension reference is outside the drawing source solids");
    };
    for (const dim of sheet.dimensions) {
      if (!known.has(dim.view)) throw Error("Drawing dimension refers to a missing view");
      for (const ref of [
        ...(dim.refs ?? []),
        ...(dim.reference ? [dim.reference] : []),
        ...(dim.points ?? []).map((p) => p.ref),
      ])
        inSources(ref);
      if (dim.position && !finite2(dim.position)) throw Error("Invalid dimension position");
    }
    for (const a of sheet.annotations ?? []) {
      if ("view" in a && !known.has(a.view)) throw Error("Drawing annotation refers to a missing view");
      if ("position" in a && !finite2(a.position)) throw Error("Invalid annotation position");
      const refs = "refs" in a ? a.refs : "ref" in a ? [a.ref] : a.type === "note" && a.leader ? [a.leader.ref] : [];
      for (const ref of refs) inSources(ref);
      if (a.type === "weld") {
        for (const v of [a.leg, a.length]) if (v !== undefined && !(Number.isFinite(v) && v > 0 && v <= 10000)) throw Error("Invalid weld symbol size");
        if (a.sides !== undefined && !["arrow", "other", "both"].includes(a.sides)) throw Error("Invalid weld symbol side");
        if (a.process !== undefined && (typeof a.process !== "string" || a.process.length > 40)) throw Error("Invalid weld process");
      }
    }
  }
  for (const f of d.features) {
    const p = f.params;
    for (const [key, value] of Object.entries(p)) {
      if (
        typeof value === "number" &&
        (!Number.isFinite(value) || Math.abs(value) > 10000)
      )
        throw Error(`${f.name}: invalid ${key}`);
    }
    for (const key of [
      "radius",
      "diameter",
      "spacing",
      "thickness",
      "counterboreDiameter",
      "counterboreDepth",
      "depth",
    ])
      if (p[key] !== undefined && p[key] <= 0)
        throw Error(`${f.name}: ${key} must be positive`);
    if (f.type === "extrude" && Math.abs(p.distance) < 1e-6)
      throw Error("Extrusion distance must be nonzero");
    if (f.type === "chamfer" && p.distance <= 0)
      throw Error("Chamfer distance must be positive");
    if (
      f.type === "pattern" &&
      (!Number.isInteger(p.count) || p.count < 2 || p.count > 200)
    )
      throw Error("Pattern count must be an integer from 2 to 200");
    if (
      f.type === "pattern" &&
      p.count2 !== undefined &&
      (!Number.isInteger(p.count2) || p.count2 < 1 || p.count * p.count2 > 2500)
    )
      throw Error("Second-direction count must be an integer; at most 2500 instances");
    if (f.type === "moveFace" && !(Number.isFinite(p.offset) && p.offset !== 0 && Math.abs(p.offset) <= 10000 && Array.isArray(p.faces) && p.faces.length))
      throw Error(`${f.name}: Move Face needs faces and a non-zero offset`);
    if (f.type === "draft" && !(p.angle > 0 && p.angle <= 45))
      throw Error(`${f.name}: draft angle must be between 0 and 45 degrees`);
    if (f.type === "scale" && !(p.factor > 0.001 && p.factor <= 1000))
      throw Error(`${f.name}: invalid scale factor`);
    if (
      f.type === "extrude" &&
      p.endType === "up-to-face" &&
      !p.upTo
    )
      throw Error(`${f.name}: select the face to extrude up to`);
    for (const key of ["sketchId", "profileSketchId", "pathSketchId"])
      if (p[key] && !d.sketches.some((s) => s.id === p[key]))
        throw Error(`${f.name}: its sketch was deleted`);
    for (const sid of p.sketchIds ?? [])
      if (!d.sketches.some((s) => s.id === sid))
        throw Error(`${f.name}: a profile sketch was deleted`);
    for (const fid of p.featureIds ?? [])
      if (!d.features.some((x) => x.id === fid))
        throw Error(`${f.name}: a referenced feature was deleted`);
    if (f.type === "fillet" && p.profiles) {
      if (!p.profiles.length) throw Error("Variable fillet needs an edge");
      for (const profile of p.profiles) {
        const points = profile.points;
        if (
          points.length < 2 ||
          points[0].position !== 0 ||
          points.at(-1).position !== 1 ||
          points.some(
            (v: any, i: number) =>
              !Number.isFinite(v.radius) ||
              v.radius <= 0 ||
              v.radius > 10000 ||
              !Number.isFinite(v.position) ||
              (i > 0 && v.position <= points[i - 1].position),
          )
        )
          throw Error("Invalid variable radius law");
      }
    }
    if (f.type === "pattern" && p.kind === "circular") {
      if (
        (!p.axisRef &&
          (!finiteVector(p.axisOrigin) ||
            !finiteVector(p.axis) ||
            Math.hypot(...p.axis) < 1e-8)) ||
        !Number.isFinite(p.angle) ||
        p.angle <= 0 ||
        p.angle > 360 ||
        (p.skippedInstances ?? []).some((i: number) => i < 2 || i > p.count)
      )
        throw Error("Invalid circular pattern");
    }
    if (f.type === "hole") {
      if (!!p.counterboreDiameter !== !!p.counterboreDepth)
        throw Error("Counterbore requires diameter and depth");
      if (p.counterboreDiameter && p.counterboreDiameter <= p.diameter)
        throw Error("Counterbore diameter must exceed hole diameter");
      if (p.depth && p.counterboreDepth > p.depth)
        throw Error("Counterbore depth cannot exceed hole depth");
    }
  }
}

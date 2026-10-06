// Section View PropertyManager: cut the displayed model with a principal plane.
import { Check as CheckIcon, X } from "lucide-react";
import type { Geometry, Vec3 } from "../../cad/types.ts";
import { Icons } from "../cad-icons.tsx";
import { Check, NumberField, Segmented } from "../ui.tsx";

export interface SectionState {
  plane: "XY" | "XZ" | "YZ";
  offset: number;
  flip: boolean;
}
/** Toward the viewer of the matching standard view: the side a section removes. */
const normals: Record<SectionState["plane"], Vec3> = { XY: [0, 0, 1], XZ: [0, -1, 0], YZ: [1, 0, 0] };

/** Range of offsets that cut through the visible bodies along a plane's normal. */
export function sectionRange(geometry: Geometry, plane: SectionState["plane"]): [number, number] {
  const n = normals[plane];
  let lo = Infinity,
    hi = -Infinity;
  for (const b of geometry.bodies.filter((b) => !b.hidden))
    for (const x of [b.bounds[0][0], b.bounds[1][0]])
      for (const y of [b.bounds[0][1], b.bounds[1][1]])
        for (const z of [b.bounds[0][2], b.bounds[1][2]]) {
          const d = n[0] * x + n[1] * y + n[2] * z;
          lo = Math.min(lo, d);
          hi = Math.max(hi, d);
        }
  return Number.isFinite(lo) ? [lo, hi] : [-50, 50];
}
export function defaultSection(geometry: Geometry, plane: SectionState["plane"] = "XZ"): SectionState {
  const [lo, hi] = sectionRange(geometry, plane);
  return { plane, offset: Math.round(((lo + hi) / 2) * 100) / 100, flip: false };
}
/** The cut as the viewport takes it: keep normal · p ≤ offset. */
export function sectionCut(s: SectionState): { normal: Vec3; offset: number } {
  const n = normals[s.plane];
  return s.flip ? { normal: n.map((x) => -x) as Vec3, offset: -s.offset } : { normal: n, offset: s.offset };
}

export function SectionPanel({
  value,
  geometry,
  onChange,
  onAccept,
  onCancel,
}: {
  value: SectionState;
  geometry: Geometry;
  onChange: (s: SectionState) => void;
  onAccept: () => void;
  onCancel: () => void;
}) {
  const [lo, hi] = sectionRange(geometry, value.plane);
  return (
    <div className="property-manager" aria-label="Section View PropertyManager">
      <header>
        <Icons.section3d size={18} />
        <strong>Section View</strong>
        <span className="pm-actions">
          <button className="pm-accept" aria-label="Keep section view" title="Keep the section (Enter)" onClick={onAccept}>
            <CheckIcon size={18} />
          </button>
          <button className="pm-cancel" aria-label="Remove section view" title="Remove the section (Esc)" onClick={onCancel}>
            <X size={18} />
          </button>
        </span>
      </header>
      <div className="pm-body">
        <Segmented
          label="Plane"
          value={value.plane}
          options={[
            { value: "XZ", label: "Front" },
            { value: "XY", label: "Top" },
            { value: "YZ", label: "Right" },
          ]}
          onChange={(plane) => onChange({ ...defaultSection(geometry, plane), flip: value.flip })}
        />
        <NumberField label="Offset" value={value.offset} onChange={(offset) => onChange({ ...value, offset })} />
        <input
          type="range"
          aria-label="Section offset"
          min={lo}
          max={hi}
          step={Math.max((hi - lo) / 200, 0.01)}
          value={Math.min(hi, Math.max(lo, value.offset))}
          onChange={(e) => onChange({ ...value, offset: Math.round(Number(e.target.value) * 100) / 100 })}
        />
        <Check label="Flip side" value={value.flip} onChange={(flip) => onChange({ ...value, flip })} />
      </div>
    </div>
  );
}

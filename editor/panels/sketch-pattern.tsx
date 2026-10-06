// Sketch Pattern PropertyManager: repeat selected sketch geometry along a
// direction or around a center, with a live preview in the sketch.
import { useEffect, useState } from "react";
import { Check as CheckIcon, X } from "lucide-react";
import type { PatternOptions } from "../../cad/sketch-tools.ts";
import type { SketchSession } from "../sketch/session.ts";
import { Icons } from "../cad-icons.tsx";
import { NumberField, Segmented, SelectionBox } from "../ui.tsx";

export function SketchPatternPanel({ session, revision, onClose }: { session: SketchSession; revision: number; onClose: () => void }) {
  const [kind, setKind] = useState<"linear" | "circular">("linear"),
    [count, setCount] = useState(3),
    [spacing, setSpacing] = useState(20),
    [direction, setDirection] = useState(0),
    [angle, setAngle] = useState(360),
    [center, setCenter] = useState<string | undefined>(undefined),
    [picking, setPicking] = useState(false),
    [error, setError] = useState("");
  const selected = session.selection.entities.size;
  const options: PatternOptions =
    kind === "linear" ? { kind, count, spacing, direction } : { kind, count, angle, ...(center ? { center } : {}) };
  useEffect(() => {
    session.previewPattern(selected ? options : null);
  }, [JSON.stringify(options), selected, revision]);
  useEffect(() => () => session.previewPattern(null), []);
  const centerName = center ? (session.current.entities.find((e) => e.id === center)?.type ?? "Point") : "Origin";
  const accept = () => {
    setError("");
    void session
      .commitPattern(options)
      .then(onClose)
      .catch((e) => setError((e as Error).message));
  };
  return (
    <div className="property-manager" aria-label="Sketch Pattern PropertyManager">
      <header>
        <Icons.linearPattern size={18} />
        <strong>Sketch Pattern</strong>
        <span className="pm-actions">
          <button className="pm-accept" aria-label="Accept Sketch Pattern" title="Accept (Enter)" disabled={!selected} onClick={accept}>
            <CheckIcon size={18} />
          </button>
          <button className="pm-cancel" aria-label="Cancel" title="Cancel (Esc)" onClick={onClose}>
            <X size={18} />
          </button>
        </span>
      </header>
      <div className="pm-body">
        <SelectionBox
          label="Entities to pattern"
          active={!picking}
          placeholder="Select sketch geometry"
          onActivate={() => setPicking(false)}
          items={selected ? [{ key: "selection", label: `${selected} ${selected === 1 ? "entity" : "entities"}` }] : []}
          onRemove={() => {
            session.clearSelection();
          }}
        />
        <Segmented
          label="Type"
          value={kind}
          options={[
            { value: "linear", label: "Linear" },
            { value: "circular", label: "Circular" },
          ]}
          onChange={setKind}
        />
        <NumberField label="Instances" unit="" integer min={2} max={100} value={count} onChange={setCount} />
        {kind === "linear" ? (
          <>
            <NumberField label="Spacing" min={0.001} value={spacing} onChange={setSpacing} />
            <NumberField label="Direction" unit="°" value={direction} onChange={setDirection} />
          </>
        ) : (
          <>
            <NumberField label="Angle" unit="°" min={0.01} max={360} value={angle} onChange={setAngle} />
            <SelectionBox
              label="Center"
              active={picking}
              placeholder="Select a point, circle or arc"
              onActivate={() => {
                setPicking(true);
                session.centerPick = (id) => {
                  setCenter(id);
                  setPicking(false);
                };
              }}
              items={[{ key: center ?? "origin", label: centerName[0].toUpperCase() + centerName.slice(1) }]}
              onRemove={() => setCenter(undefined)}
            />
          </>
        )}
        {error && (
          <p className="pm-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

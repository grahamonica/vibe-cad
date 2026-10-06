// Interference Detection: every pair of parts that overlap, with the volume they share.
import { useEffect, useState } from "react";
import { Check as CheckIcon, X } from "lucide-react";
import type { View } from "../../cad/types.ts";
import { Icons } from "../cad-icons.tsx";
import { formatMm } from "../sketch/model.ts";
import { toDisplay, unitLabel } from "../units.ts";
import type { Cad } from "../state.ts";

interface Interferences {
  interferes: boolean;
  pairs: { a: string; b: string; aName: string; bName: string; volume: number }[];
  bodies: number;
  checked: number;
}
export function InterferencePanel({ cad, view, onClose, onShow }: { cad: Cad; view: View; onClose: () => void; onShow: (bodyIds: string[]) => void }) {
  const [result, setResult] = useState<Interferences | null>(null),
    [running, setRunning] = useState(false);
  useEffect(() => {
    setRunning(true);
    void cad
      .execute<Interferences>("check_interference", {})
      .then(setResult)
      .catch((e) => cad.setError((e as Error).message))
      .finally(() => setRunning(false));
  }, [view.document.revision]);
  return (
    <div className="property-manager" aria-label="Interference Detection">
      <header>
        <Icons.interference size={18} />
        <strong>Interference Detection</strong>
        <span className="pm-actions">
          <button className="pm-accept" aria-label="Close interference detection" title="Close (Enter)" onClick={onClose}>
            <CheckIcon size={18} />
          </button>
          <button className="pm-cancel" aria-label="Close interference detection" title="Close (Esc)" onClick={onClose}>
            <X size={18} />
          </button>
        </span>
      </header>
      <div className="pm-body">
        {running && <p className="muted">Checking…</p>}
        {result && !running && (
          <section>
            {result.pairs.length ? (
              result.pairs.map((p) => (
                <button className="info-row error link-row" key={`${p.a}|${p.b}`} onClick={() => onShow([p.a, p.b])}>
                  <span>
                    {p.aName} and {p.bName}
                  </span>
                  <b>
                    {formatMm(toDisplay(p.volume, 3))} {unitLabel(3)}
                  </b>
                </button>
              ))
            ) : (
              <div className="info-row">
                <span>Interferences</span>
                <b>None</b>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

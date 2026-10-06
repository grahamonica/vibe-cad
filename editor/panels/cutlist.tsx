// Weldment cut list: members by profile, with each length and the total to buy.
import { useEffect, useState } from "react";
import { Check as CheckIcon, X } from "lucide-react";
import type { View } from "../../cad/types.ts";
import { Icons } from "../cad-icons.tsx";
import { formatLength, unitLabel } from "../units.ts";
import type { Cad } from "../state.ts";

interface CutList {
  items: { profile: string; count: number; lengths: number[]; total: number; bodies: string[] }[];
}
export function CutListPanel({ cad, view, onClose }: { cad: Cad; view: View; onClose: () => void }) {
  const [list, setList] = useState<CutList | null>(null);
  useEffect(() => {
    void cad
      .execute<CutList>("cut_list", {})
      .then(setList)
      .catch((e) => cad.setError((e as Error).message));
  }, [view.document.revision]);
  const len = (mm: number) => `${formatLength(mm)} ${unitLabel()}`;
  return (
    <div className="property-manager" aria-label="Cut List">
      <header>
        <Icons.cutList size={18} />
        <strong>Cut List</strong>
        <span className="pm-actions">
          <button className="pm-accept" aria-label="Close cut list" title="Close (Enter)" onClick={onClose}>
            <CheckIcon size={18} />
          </button>
          <button className="pm-cancel" aria-label="Close cut list" title="Close (Esc)" onClick={onClose}>
            <X size={18} />
          </button>
        </span>
      </header>
      <div className="pm-body">
        {list?.items.map((item) => (
          <section key={item.profile}>
            <h3>{item.profile}</h3>
            {item.lengths.map((l, i) => (
              <div className="info-row" key={i}>
                <span>{item.bodies[i]}</span>
                <b>{len(l)}</b>
              </div>
            ))}
            <div className="info-row">
              <span>
                {item.count} member{item.count === 1 ? "" : "s"}
              </span>
              <b>{len(item.total)}</b>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

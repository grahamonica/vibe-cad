import { useRef } from "react";

type Side = "left" | "right";
const defaults = { left: 264, right: 284 };

/** Drag the divider to an edge to collapse, or away from the edge to reopen. */
export function SidebarResize({ side, shown, width, onChange }: {
  side: Side;
  shown: boolean;
  width: number;
  onChange: (shown: boolean, width: number) => void;
}) {
  const drag = useRef<{ x: number; width: number; max: number } | null>(null);
  const resize = (raw: number, max: number) => {
    if (raw < 72) onChange(false, width);
    else onChange(true, Math.max(Math.min(160, max), Math.min(raw, max)));
  };
  return <div
    className={`sidebar-resizer ${side}-resizer`}
    role="separator"
    aria-label={`Resize ${side === "left" ? "feature" : "properties"} sidebar`}
    aria-orientation="vertical"
    aria-controls={`${side}-sidebar`}
    aria-valuemin={0}
    aria-valuemax={500}
    aria-valuenow={shown ? Math.round(width) : 0}
    tabIndex={0}
    title="Drag to resize or collapse; double-click to toggle"
    onPointerDown={e => {
      if (e.button !== 0) return;
      const workspace = e.currentTarget.parentElement!;
      const available = workspace.getBoundingClientRect().width;
      const narrow = window.innerWidth <= 760;
      const other = workspace.querySelector<HTMLElement>(`#${side === "left" ? "right" : "left"}-sidebar`)!;
      const panel = workspace.querySelector<HTMLElement>(`#${side}-sidebar`)!;
      drag.current = {
        x: e.clientX,
        width: shown ? panel.getBoundingClientRect().width : 0,
        max: Math.max(72, Math.min(500, narrow ? available * .86 : available - other.getBoundingClientRect().width - 180)),
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.classList.add("dragging");
      e.preventDefault();
    }}
    onPointerMove={e => {
      if (!drag.current) return;
      const delta = (e.clientX - drag.current.x) * (side === "left" ? 1 : -1);
      resize(drag.current.width + delta, drag.current.max);
    }}
    onLostPointerCapture={e => {
      drag.current = null;
      e.currentTarget.classList.remove("dragging");
    }}
    onPointerUp={e => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    }}
    onDoubleClick={() => onChange(!shown, width)}
    onKeyDown={e => {
      if (e.key === "Home") onChange(false, width);
      else if (e.key === "End") onChange(true, defaults[side]);
      else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        resize((shown ? width : 0) + (e.key === "ArrowRight" ? 24 : -24) * (side === "left" ? 1 : -1), 500);
      } else return;
      e.preventDefault();
    }}
  />;
}

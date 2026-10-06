// Display units. Documents, geometry and assistant tools always use
// millimeters; inches change only what the editor shows and accepts.
import { useSyncExternalStore } from "react";

export type Units = "mm" | "in";
const MM_PER_IN = 25.4;
let current: Units = "mm";
const listeners = new Set<() => void>();

export const getUnits = () => current;
/** Set the display units; may run while the editor renders, so subscribers hear about it afterwards. */
export function setUnits(units: Units) {
  if (units === current) return;
  current = units;
  queueMicrotask(() => {
    for (const listener of listeners) listener();
  });
}
/** Re-render when the display units change. */
export const useUnits = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
/** Millimeters (or mm², mm³ with `power`) in display units, and back. */
export const toDisplay = (mm: number, power = 1) => (current === "in" ? mm / MM_PER_IN ** power : mm);
export const fromDisplay = (value: number, power = 1) => (current === "in" ? value * MM_PER_IN ** power : value);
export const unitLabel = (power = 1) => `${current}${power === 2 ? "²" : power === 3 ? "³" : ""}`;
/** A length for reading: hundredths of a millimeter, thousandths of an inch. */
export function formatLength(mm: number) {
  const digits = current === "in" ? 3 : 2;
  const r = Math.round(toDisplay(mm) * 10 ** digits) / 10 ** digits;
  return Number.isInteger(r) ? String(r) : r.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}

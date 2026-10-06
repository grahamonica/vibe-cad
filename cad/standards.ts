// ISO metric fastener data for the hole wizard. Values in millimeters.
// Clearance holes follow ISO 273 (fine/medium/coarse series); counterbores fit
// ISO 4762 socket head cap screws; countersinks fit ISO 10642 (90°) heads.
export interface MetricSize {
  size: string;
  diameter: number;
  pitch: number;
  tapDrill: number;
  clearance: { close: number; normal: number; loose: number };
  counterbore: { diameter: number; depth: number };
  countersink: { diameter: number };
}
const row = (
  size: string,
  diameter: number,
  pitch: number,
  tapDrill: number,
  close: number,
  normal: number,
  loose: number,
  cbD: number,
  cbDepth: number,
  csD: number,
): MetricSize => ({
  size,
  diameter,
  pitch,
  tapDrill,
  clearance: { close, normal, loose },
  counterbore: { diameter: cbD, depth: cbDepth },
  countersink: { diameter: csD },
});
export const metricSizes: MetricSize[] = [
  row("M1.6", 1.6, 0.35, 1.25, 1.7, 1.8, 2.0, 3.5, 1.8, 3.6),
  row("M2", 2, 0.4, 1.6, 2.2, 2.4, 2.6, 4.4, 2.3, 4.4),
  row("M2.5", 2.5, 0.45, 2.05, 2.7, 2.9, 3.1, 5.4, 2.8, 5.5),
  row("M3", 3, 0.5, 2.5, 3.2, 3.4, 3.6, 6.5, 3.3, 6.9),
  row("M4", 4, 0.7, 3.3, 4.3, 4.5, 4.8, 8.0, 4.4, 9.2),
  row("M5", 5, 0.8, 4.2, 5.3, 5.5, 5.8, 10.0, 5.4, 11.4),
  row("M6", 6, 1.0, 5.0, 6.4, 6.6, 7.0, 11.0, 6.5, 13.7),
  row("M8", 8, 1.25, 6.8, 8.4, 9.0, 10.0, 15.0, 8.6, 18.2),
  row("M10", 10, 1.5, 8.5, 10.5, 11.0, 12.0, 18.0, 10.8, 22.7),
  row("M12", 12, 1.75, 10.2, 13.0, 13.5, 14.5, 20.0, 13.0, 27.2),
  row("M14", 14, 2.0, 12.0, 15.0, 15.5, 16.5, 24.0, 15.0, 31.7),
  row("M16", 16, 2.0, 14.0, 17.0, 17.5, 18.5, 26.0, 17.5, 34.0),
  row("M20", 20, 2.5, 17.5, 21.0, 22.0, 24.0, 33.0, 21.5, 40.8),
  row("M24", 24, 3.0, 21.0, 25.0, 26.0, 28.0, 40.0, 25.5, 48.0),
];
export const metricSize = (size: string) => {
  const found = metricSizes.find((s) => s.size === size);
  if (!found) throw Error(`Unknown metric size ${size}`);
  return found;
};
export type HoleType = "simple" | "counterbore" | "countersink" | "tapped";
/** Resolved hole dimensions from a standard size; explicit values win. */
export function holeDimensions(p: {
  holeType?: HoleType;
  size?: string;
  fit?: "close" | "normal" | "loose";
  diameter?: number;
  counterboreDiameter?: number;
  counterboreDepth?: number;
  countersinkDiameter?: number;
  countersinkAngle?: number;
}) {
  const type =
    p.holeType ??
    (p.counterboreDiameter
      ? "counterbore"
      : p.countersinkDiameter
        ? "countersink"
        : "simple");
  const std = p.size ? metricSize(p.size) : undefined;
  const diameter =
    p.diameter ??
    (std
      ? type === "tapped"
        ? std.tapDrill
        : std.clearance[p.fit ?? "normal"]
      : undefined);
  if (!diameter) throw Error("Hole needs a diameter or a standard size");
  return {
    type,
    diameter,
    thread: type === "tapped" && std ? { diameter: std.diameter, pitch: std.pitch, size: std.size } : undefined,
    counterbore:
      type === "counterbore"
        ? {
            diameter: p.counterboreDiameter ?? std?.counterbore.diameter ?? diameter * 1.8,
            depth: p.counterboreDepth ?? std?.counterbore.depth ?? diameter,
          }
        : undefined,
    countersink:
      type === "countersink"
        ? {
            diameter: p.countersinkDiameter ?? std?.countersink.diameter ?? diameter * 2,
            angle: p.countersinkAngle ?? 90,
          }
        : undefined,
  };
}

/**
 * Engineering materials with typical room-temperature properties: density
 * (g/cm³), elastic modulus (GPa), yield and ultimate tensile strength (MPa) and
 * Poisson's ratio. Only density is used today (mass, center of mass, inertia);
 * the rest is stored for later analysis and shown in the editor. Values are
 * typical handbook figures for the named condition, not certified minimums.
 * `printed` materials are 3D-printing filaments whose parts are partly hollow:
 * set an infill percentage and wall thickness on the part.
 */
export interface Material {
  name: string;
  category: "Aluminum" | "Steel" | "Stainless steel" | "Iron" | "Copper alloy" | "Titanium" | "Plastic" | "Composite" | "3D print";
  density: number;
  modulus?: number;
  yield?: number;
  tensile?: number;
  poisson?: number;
  printed?: boolean;
}
const m = (
  name: string,
  category: Material["category"],
  density: number,
  modulus?: number,
  yieldStrength?: number,
  tensile?: number,
  poisson?: number,
  printed = false,
): Material => ({
  name,
  category,
  density,
  ...(modulus !== undefined ? { modulus } : {}),
  ...(yieldStrength !== undefined ? { yield: yieldStrength } : {}),
  ...(tensile !== undefined ? { tensile } : {}),
  ...(poisson !== undefined ? { poisson } : {}),
  ...(printed ? { printed } : {}),
});
export const materials: Material[] = [
  m("Aluminum 6061-T6", "Aluminum", 2.7, 68.9, 276, 310, 0.33),
  m("Aluminum 7075-T6", "Aluminum", 2.81, 71.7, 503, 572, 0.33),
  m("Aluminum 5052-H32", "Aluminum", 2.68, 70.3, 193, 228, 0.33),
  m("Steel 1018", "Steel", 7.87, 205, 370, 440, 0.29),
  m("Steel 1045", "Steel", 7.85, 206, 530, 625, 0.29),
  m("Steel 4140", "Steel", 7.85, 205, 655, 1020, 0.29),
  m("AR500 armor steel", "Steel", 7.85, 200, 1250, 1600, 0.29),
  m("Tool steel S7 (hardened)", "Steel", 7.83, 207, 1450, 1950, 0.29),
  m("Tool steel D2 (hardened)", "Steel", 7.7, 210, 1650, 1900, 0.29),
  m("Tool steel A2 (hardened)", "Steel", 7.86, 203, 1300, 1800, 0.29),
  m("Stainless steel 304", "Stainless steel", 8.0, 193, 215, 505, 0.29),
  m("Stainless steel 316", "Stainless steel", 8.0, 193, 205, 515, 0.3),
  m("Stainless steel 17-4 PH (H900)", "Stainless steel", 7.81, 197, 1170, 1310, 0.27),
  m("Iron (wrought)", "Iron", 7.75, 190, 210, 340, 0.29),
  m("Cast iron (gray, class 40)", "Iron", 7.15, 110, undefined, 290, 0.26),
  m("Cast iron (ductile 65-45-12)", "Iron", 7.1, 168, 310, 448, 0.28),
  m("Bronze (SAE 660 bearing)", "Copper alloy", 8.93, 100, 125, 240, 0.34),
  m("Phosphor bronze C510", "Copper alloy", 8.86, 110, 345, 455, 0.34),
  m("Brass C360", "Copper alloy", 8.5, 97, 310, 385, 0.31),
  m("Copper C110", "Copper alloy", 8.94, 115, 69, 220, 0.33),
  m("Titanium grade 5 (Ti-6Al-4V)", "Titanium", 4.43, 113.8, 880, 950, 0.34),
  m("Titanium grade 2", "Titanium", 4.51, 105, 275, 345, 0.37),
  m("UHMW polyethylene", "Plastic", 0.93, 0.69, 21, 40, 0.46),
  m("HDPE", "Plastic", 0.95, 1.1, 26, 32, 0.46),
  m("Polycarbonate", "Plastic", 1.2, 2.38, 62, 69, 0.37),
  m("Acetal (POM)", "Plastic", 1.41, 2.9, 64, 70, 0.35),
  m("Nylon 6/6", "Plastic", 1.14, 2.8, 70, 80, 0.39),
  m("ABS", "Plastic", 1.04, 2.2, 40, 44, 0.35),
  m("Carbon fiber sheet (quasi-isotropic)", "Composite", 1.55, 60, undefined, 600, 0.3),
  m("Carbon fiber tube (unidirectional)", "Composite", 1.6, 135, undefined, 1500, 0.3),
  m("G10 / FR4 fiberglass", "Composite", 1.85, 18.6, undefined, 310, 0.12),
  m("PLA (printed)", "3D print", 1.24, 3.5, 50, 55, 0.36, true),
  m("PETG (printed)", "3D print", 1.27, 2.1, 45, 50, 0.38, true),
  m("ABS (printed)", "3D print", 1.04, 2.0, 35, 40, 0.35, true),
  m("TPU 95A (printed)", "3D print", 1.21, 0.026, undefined, 35, 0.48, true),
  m("Nylon PA12 (printed)", "3D print", 1.01, 1.7, 45, 50, 0.4, true),
  m("Nylon PA6 (printed)", "3D print", 1.14, 2.2, 55, 70, 0.39, true),
  m("Nylon carbon fiber PA-CF (printed)", "3D print", 1.18, 5.5, 75, 90, 0.36, true),
];
/** Default printed walls: perimeters and top/bottom layers together, in mm. */
export const defaultPrintWall = 1.2;
/**
 * Mass of a printed part (g) from its volume (mm³) and surface area (mm²):
 * solid walls of the given thickness around an interior filled to `infill` (0–1).
 */
export function printedMass(volume: number, area: number, density: number, infill: number, wall = defaultPrintWall) {
  const shell = Math.min(volume, area * wall);
  return ((shell + infill * (volume - shell)) * density) / 1000;
}

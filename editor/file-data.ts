// Reading local files for import tools.
/** File contents as base64, encoded in chunks so large files do not overflow the call stack. */
export async function fileBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
export const isMesh = (name: string) => /\.stl$/i.test(name);
/** File types the Import commands accept. */
export const importAccept = ".step,.stp,.stl,.STEP,.STP,.STL";
export type MeshUnits = "mm" | "cm" | "m" | "in";
export const meshUnitNames: [MeshUnits, string][] = [
  ["mm", "Millimeters"],
  ["cm", "Centimeters"],
  ["m", "Meters"],
  ["in", "Inches"],
];

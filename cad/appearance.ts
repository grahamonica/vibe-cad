// Display styles and appearance textures shared by the tools, the editor and
// captured pictures. Both are display only: geometry, mass and exports never
// depend on them.
import type { DisplayStyle, Texture } from "./types.ts";

/** In SolidWorks' order and wording. */
export const displayStyles: { id: DisplayStyle; name: string }[] = [
  { id: "shaded-edges", name: "Shaded With Edges" },
  { id: "shaded", name: "Shaded" },
  { id: "hidden-removed", name: "Hidden Lines Removed" },
  { id: "hidden-visible", name: "Hidden Lines Visible" },
  { id: "wireframe", name: "Wireframe" },
];
export const displayStyleIds = displayStyles.map((s) => s.id) as [DisplayStyle, ...DisplayStyle[]];

export interface TextureInfo {
  id: Texture;
  name: string;
  /** The color it is applied with; any color can tint it afterwards. */
  color: string;
  /** Millimeters covered by one repeat of the pattern. */
  tile: number;
  roughness: number;
  metalness: number;
  /** The pattern also raises the surface (bump), as tread plate does. */
  relief?: boolean;
}
export const textures: TextureInfo[] = [
  { id: "brushed-metal", name: "Brushed metal", color: "#A9ADB3", tile: 60, roughness: 0.42, metalness: 0.45 },
  { id: "carbon-fiber", name: "Carbon fiber", color: "#3A3B3E", tile: 12, roughness: 0.32, metalness: 0.1 },
  { id: "diamond-plate", name: "Diamond plate", color: "#B4B7BC", tile: 28, roughness: 0.38, metalness: 0.5, relief: true },
  { id: "wood", name: "Wood", color: "#B8976F", tile: 140, roughness: 0.7, metalness: 0 },
];
export const textureIds = textures.map((t) => t.id) as [Texture, ...Texture[]];
export const textureInfo = (id: Texture) => textures.find((t) => t.id === id)!;

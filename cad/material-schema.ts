import { z } from "zod";

export const materialProps = {
  density: z.number().finite().gt(0).max(30).describe("g/cm³"),
  category: z.string().trim().min(1).max(40).optional(),
  modulus: z.number().finite().positive().max(2000).optional().describe("Elastic modulus, GPa"),
  yield: z.number().finite().positive().max(10000).optional().describe("Yield strength, MPa"),
  tensile: z.number().finite().positive().max(10000).optional().describe("Ultimate tensile strength, MPa"),
  poisson: z.number().finite().min(0).max(0.5).optional(),
  printed: z.boolean().optional().describe("A 3D-printing material: parts take an infill and wall thickness"),
};

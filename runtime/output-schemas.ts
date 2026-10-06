import { z } from "zod";
const id = z.string(),
  vector = z.tuple([z.number(), z.number(), z.number()]);
const document = z
  .object({
    id,
    name: z.string(),
    revision: z.number().int(),
    units: z.literal("mm"),
    sketches: z.array(
      z
        .object({
          id,
          name: z.string(),
          plane: z.string(),
          entities: z.array(
            z
              .object({
                id,
                type: z.string(),
                values: z.record(z.string(), z.number()),
              })
              .passthrough(),
          ),
          constraints: z.array(
            z
              .object({ id, type: z.string(), entityIds: z.array(id) })
              .passthrough(),
          ),
        })
        .passthrough(),
    ),
    features: z.array(
      z
        .object({
          id,
          name: z.string(),
          type: z.string(),
          bodyId: id,
          params: z.record(z.string(), z.unknown()),
          suppressed: z.boolean(),
        })
        .passthrough(),
    ),
    bodies: z.array(
      z.object({ id, name: z.string(), hidden: z.boolean() }).passthrough(),
    ),
    selection: z.array(
      z
        .object({ id, bodyId: id, kind: z.enum(["face", "edge"]) })
        .passthrough(),
    ),
  })
  .passthrough();
const view = z
  .object({
    document,
    geometry: z.array(
      z
        .object({
          id,
          name: z.string(),
          volume: z.number(),
          surfaceArea: z.number(),
          bounds: z.tuple([vector, vector]),
          centerOfMass: vector,
          faceCount: z.number().int(),
          edgeCount: z.number().int(),
        })
        .passthrough(),
    ),
    warnings: z.array(z.string()),
    definition: z.object({ status: z.enum(["full", "under", "over"]), notes: z.array(z.string()) }).optional(),
  })
  .passthrough();
const names = [
  "create_document",
  "inspect_document",
  "open_cad",
  "set_selection",
  "set_viewport",
  "create_sketch",
  "add_sketch_entity",
  "add_sketch_constraint",
  "remove_sketch_constraint",
  "set_dimension",
  "extrude",
  "revolve",
  "create_hole",
  "set_hole_positions",
  "set_hole_counterbore",
  "fillet_edges",
  "fillet_faces",
  "fillet_body",
  "variable_fillet_edges",
  "set_variable_fillet_profile",
  "create_circular_pattern",
  "chamfer_edges",
  "create_linear_pattern",
  "mirror_body",
  "boolean_bodies",
  "shell_body",
  "move_body",
  "rename_object",
  "set_body_visibility",
  "suppress_feature",
  "delete_feature",
  "delete_sketch_entity",
  "add_design_intent",
  "undo",
  "redo",
  "restore_history",
  "preview_dimension",
  "apply_preview",
  "dismiss_preview",
];
export const viewOutput = view;
export const outputSchemas: Record<
  string,
  z.ZodObject<any>
> = Object.fromEntries(names.map((name) => [name, view]));
outputSchemas.get_tool_schema = z.object({
  tools: z.array(z.object({
    name: id,
    description: z.string(),
    inputSchema: z.record(z.string(), z.unknown()),
  })),
});
outputSchemas.list_documents = z.object({
  documents: z.array(
    z.object({
      id,
      name: z.string(),
      revision: z.number().int(),
      updatedAt: z.string(),
      bodyCount: z.number().int(),
    }),
  ),
});
outputSchemas.inspect_document_state = z.object({
  documentId: id,
  revision: z.number().int(),
  selection: z.array(
    z.object({ id, bodyId: id, kind: z.enum(["face", "edge"]) }).passthrough(),
  ),
  viewport: z.object({ position: vector, target: vector }).optional(),
  previewId: id.nullable(),
});
outputSchemas.inspect_selection = z.object({
  revision: z.number().int(),
  selection: z.array(
    z
      .object({
        id,
        bodyId: id,
        kind: z.enum(["face", "edge"]),
        geomType: z.string(),
        center: vector,
      })
      .passthrough(),
  ),
  viewport: z.object({ position: vector, target: vector }).optional(),
});
outputSchemas.inspect_feature = z.object({
  revision: z.number().int(),
  feature: z.object({ id, name: z.string() }).passthrough().nullable(),
  intents: z.array(
    z
      .object({ id, text: z.string(), kind: z.enum(["hard", "soft"]) })
      .passthrough(),
  ),
});
outputSchemas.inspect_geometry = z
  .object({
    revision: z.number().int(),
    id,
    volume: z.number(),
    surfaceArea: z.number(),
    topology: z.array(
      z
        .object({
          id,
          bodyId: id,
          kind: z.enum(["face", "edge"]),
          geomType: z.string(),
          center: vector,
        })
        .passthrough(),
    ),
  })
  .passthrough();
outputSchemas.flat_pattern = z
  .object({
    width: z.number().optional(),
    height: z.number().optional(),
    path: z.string().optional(),
    filename: z.string().optional(),
  })
  .passthrough();
const materialList = z.object({
  materials: z.array(z.object({ name: z.string(), density: z.number(), category: z.string().optional() }).passthrough()),
});
outputSchemas.list_materials = materialList;
outputSchemas.save_material = materialList;
outputSchemas.delete_material = materialList;
outputSchemas.check_motion = z.object({
  kind: z.string(),
  steps: z.array(z.object({ value: z.number(), clearance: z.number().nullable(), closest: z.string(), interference: z.array(z.object({ with: z.string(), volume: z.number(), by: z.string().optional() })) })),
  collides: z.boolean(),
  collisions: z.array(z.object({ value: z.number(), with: z.array(z.string()), volume: z.number() })),
  minimumClearance: z.object({ value: z.number().nullable(), at: z.number(), with: z.string() }),
  limit: z.object({ value: z.number(), reason: z.string() }).optional(),
});
outputSchemas.run_steps = z
  .object({
    ok: z.boolean(),
    steps: z.array(z.object({ step: z.number().int(), tool: z.string(), ok: z.boolean() }).passthrough()),
    error: z.string().optional(),
    failedStep: z.number().int().optional(),
    rolledBack: z.boolean().optional(),
    createdDocuments: z.array(id).optional(),
    document: z.object({ id, name: z.string(), revision: z.number().int() }).optional(),
    definition: z.object({ status: z.enum(["full", "under", "over"]), notes: z.array(z.string()) }).passthrough().optional(),
    warnings: z.array(z.string()).optional(),
  })
  .passthrough();
outputSchemas.capture_view = z
  .object({
    document: z.object({ id, name: z.string(), revision: z.number().int() }),
    views: z.array(z.object({ name: z.string(), width: z.number().int(), height: z.number().int(), direction: vector })),
    legend: z.array(z.object({ color: z.string(), meaning: z.string() })),
    images: z.array(z.object({ name: z.string(), mimeType: z.string() }).passthrough()),
  })
  .passthrough();
outputSchemas.check_definition = z
  .object({ status: z.enum(["full", "under", "over"]), sketches: z.array(z.object({}).passthrough()), components: z.array(z.object({}).passthrough()), mates: z.array(z.object({}).passthrough()), notes: z.array(z.string()) })
  .passthrough();
outputSchemas.check_interference = z
  .object({ interferes: z.boolean(), pairs: z.array(z.object({ a: id, b: id, aName: z.string(), bName: z.string(), volume: z.number() })), bodies: z.number().int(), checked: z.number().int() })
  .passthrough();
outputSchemas.belt_length = z.object({
  belt: z.string(),
  centerDistance: z.number(),
  pitchLength: z.number(),
  teeth: z.number(),
  standardTeeth: z.number(),
  standardLength: z.number(),
  centerForStandard: z.number(),
});
outputSchemas.cut_list = z.object({
  items: z.array(z.object({ profile: z.string(), count: z.number(), lengths: z.array(z.number()), total: z.number(), bodies: z.array(z.string()) })),
});
outputSchemas.export_face_dxf = z
  .object({ filename: z.string(), width: z.number(), height: z.number(), thickness: z.number().optional(), units: z.string() })
  .passthrough();
outputSchemas.measure = z
  .object({
    units: z.string(),
    distance: z.number().optional(),
    length: z.number().optional(),
    area: z.number().optional(),
    volume: z.number().optional(),
    surfaceArea: z.number().optional(),
    centerOfMass: vector.optional(),
  })
  .passthrough();
outputSchemas.analyze_interference = z.object({
  interferes: z.boolean(),
  volume: z.number(),
  units: z.literal("mm³"),
});
outputSchemas.analyze_printability = z.object({
  method: z.string(),
  limitations: z.string(),
  faces: z.array(
    z.object({ id, bodyId: id, normal: vector.optional() }).passthrough(),
  ),
  units: z.string(),
});
outputSchemas.export_file = z.object({
  filename: z.string(),
  mimeType: z.string(),
  path: z.string(),
  bytes: z.number().int(),
});

for (const name of [
  "create_reference_plane",
  "set_reference_plane",
  "create_component",
  "insert_component",
  "delete_component",
  "pattern_component",
  "delete_component_pattern",
  "set_component_transform",
  "set_component_grounded",
  "add_mate",
  "set_mate_suppressed",
  "delete_mate",
  "set_explode_offset",
  "auto_explode",
  "set_material",
  "set_units",
  "set_variable",
  "delete_variable",
  "set_mass_properties",
  "move_face",
  "import_stl",
  "import_part",

  "create_drawing",
  "update_drawing",
  "add_drawing_dimension",
  "remove_drawing_dimension",
  "add_drawing_callout",
])
  outputSchemas[name] = view;
outputSchemas.inspect_assembly = z.object({
  revision: z.number(),
  components: z.array(
    z.object({ id, name: z.string(), bodyIds: z.array(id) }).passthrough(),
  ),
  mates: z.array(z.object({ id, type: z.string() }).passthrough()),
  placements: z.record(
    z.string(),
    z.object({
      position: vector,
      quaternion: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    }),
  ),
  bom: z.array(
    z.object({
      item: z.number(),
      name: z.string(),
      quantity: z.number(),
      bodyIds: z.array(id),
      componentIds: z.array(id),
      partDocumentId: id.optional(),
      volume: z.number(),
    }),
  ),
});
const gitStatus = z.object({
  branch: z.string(),
  upstream: z.string().optional(),
  ahead: z.number(),
  behind: z.number(),
  merging: z.boolean(),
  changes: z.array(z.object({ path: z.string(), change: z.string(), document: z.string().optional(), object: z.string().optional() })),
  problems: z.array(z.string()).optional(),
});
for (const name of ["git_status", "git_commit", "git_create_branch", "git_switch", "git_merge", "git_resolve", "git_abort_merge", "git_pull", "git_push"]) outputSchemas[name] = gitStatus;
outputSchemas.git_branches = z.object({
  current: z.string(),
  branches: z.array(z.object({ name: z.string(), current: z.boolean(), upstream: z.string().optional(), remote: z.boolean() })),
});
outputSchemas.mass_properties = z.object({
  mass: z.number(),
  centerOfMass: vector,
  inertia: z.object({ tensor: z.array(z.number()).length(6), principal: vector }),
  items: z.array(z.object({ bodyId: id, name: z.string(), mass: z.number(), source: z.string() })),
  missing: z.array(z.string()),
  weightLimit: z.number().optional(),
  remaining: z.number().optional(),
  spin: z
    .object({
      rpm: z.number(),
      inertia: z.number(),
      offset: z.number(),
      radius: z.number(),
      energy: z.number(),
      tipSpeed: z.number(),
      imbalanceForce: z.number(),
    })
    .optional(),
});
const vec2 = z.tuple([z.number(), z.number()]);
outputSchemas.render_drawing = z
  .object({
    drawingId: id,
    revision: z.number(),
    svg: z.string(),
    projection: z.string(),
    width: z.number(),
    height: z.number(),
    views: z.array(
      z
        .object({
          name: z.string(),
          id: z.string().optional(),
          label: z.string().optional(),
          kind: z.string().optional(),
          bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]),
          measureBounds: z.tuple([z.number(), z.number(), z.number(), z.number()]),
          circles: z.array(
            z
              .object({
                reference: z.object({ id, bodyId: id, kind: z.literal("edge") }).passthrough(),
                center: vec2,
                radius: z.number().positive(),
              })
              .passthrough(),
          ),
          scale: z.number().optional(),
          origin: vec2.optional(),
          edges: z
            .array(
              z
                .object({
                  ref: z.object({ id, bodyId: id }).passthrough(),
                  points: z.array(vec2),
                  visible: z.boolean(),
                })
                .passthrough(),
            )
            .optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
outputSchemas.export_drawing = outputSchemas.export_file;

outputSchemas.preview_feature = view;

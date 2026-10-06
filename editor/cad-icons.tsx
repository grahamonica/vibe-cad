// Line icons for CAD commands. 20×20 grid, 1.4px strokes, currentColor.
import type { CSSProperties, ReactNode } from "react";

const icon = (children: ReactNode) =>
  function Icon({ size = 20, style }: { size?: number; style?: CSSProperties }) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={style}
        aria-hidden="true"
      >
        {children}
      </svg>
    );
  };
const dot = (x: number, y: number, r = 1.3) => (
  <circle cx={x} cy={y} r={r} fill="currentColor" stroke="none" />
);

const cubeFaces = (
  <g stroke="none" fill="currentColor">
    <path d="M3 7h9v9H3z" fillOpacity={0.45} />
    <path d="M3 7l4-4h9l-4 4z" fillOpacity={0.2} />
    <path d="M12 7l4-4v9l-4 4z" fillOpacity={0.7} />
  </g>
);
const cubeEdges = <path d="M3 7h9v9H3z M3 7l4-4h9v9l-4 4 M12 7l4-4" />;
const cubeHidden = "M7 3v9h9 M7 12l-4 4";

export const Icons = {
  sketch: icon(
    <>
      <path d="M3 16V6h8" />
      <path d="M3 16h10" strokeDasharray="0" />
      <path d="M15.5 3.5l1.9 1.9-7.6 7.6-2.6.7.7-2.6z" />
    </>,
  ),
  line: icon(
    <>
      <path d="M4 16L16 4" />
      {dot(4, 16)}
      {dot(16, 4)}
    </>,
  ),
  rectangle: icon(
    <>
      <rect x="3" y="5" width="14" height="10" />
      {dot(3, 5)}
      {dot(17, 15)}
    </>,
  ),
  centerRectangle: icon(
    <>
      <rect x="3" y="5" width="14" height="10" />
      <path d="M3 5l14 10" strokeDasharray="1.5 1.5" />
      {dot(10, 10)}
    </>,
  ),
  circle: icon(
    <>
      <circle cx="10" cy="10" r="6.5" />
      {dot(10, 10)}
    </>,
  ),
  arc: icon(
    <>
      <path d="M3.5 15A7.5 7.5 0 0 1 16.5 15" />
      {dot(3.5, 15)}
      {dot(16.5, 15)}
      {dot(10, 7.6, 1)}
    </>,
  ),
  tangentArc: icon(
    <>
      <path d="M2.5 15H9a5 5 0 0 0 5-5V4" />
      {dot(9, 15, 1)}
      {dot(14, 4)}
    </>,
  ),
  polygon: icon(<path d="M10 3l6 3.5v7L10 17l-6-3.5v-7z" />),
  slot: icon(
    <>
      <path d="M6 6.5h8a3.5 3.5 0 0 1 0 7H6a3.5 3.5 0 0 1 0-7z" />
      {dot(6, 10, 1)}
      {dot(14, 10, 1)}
    </>,
  ),
  spline: icon(
    <>
      <path d="M3 14C5 6 8 5 10 9.5S15 14 17 5" />
      {dot(3, 14)}
      {dot(10, 9.5, 1)}
      {dot(17, 5)}
    </>,
  ),
  point: icon(
    <>
      <path d="M10 5v10M5 10h10" strokeWidth={1} />
      {dot(10, 10, 1.8)}
    </>,
  ),
  construction: icon(<path d="M3 17L17 3" strokeDasharray="2.4 2" />),
  trim: icon(
    <>
      <path d="M3 10h5" />
      <path d="M12 10h5" strokeDasharray="1.6 1.6" />
      <path d="M10 3v14" />
    </>,
  ),
  offset: icon(
    <>
      <path d="M3 15c3-6 8-9 14-9" />
      <path d="M3 18c3-5 8-8 14-8" strokeDasharray="1.8 1.6" />
    </>,
  ),
  // A flat sheet with its thickness.
  baseFlange: icon(
    <>
      <path d="M2 11l6-4h10l-6 4z" />
      <path d="M2 11v2l10 0 6-4V7" />
      <path d="M12 11v2" />
    </>,
  ),
  // A sheet with a wall bent up along one edge.
  edgeFlange: icon(
    <>
      <path d="M2 15l5-3h8" />
      <path d="M15 12c1.5 0 2-1 2-2.5V3" />
      <path d="M2 17l5-3h7c2.5 0 4.5-1.5 4.5-4.5V3" strokeDasharray="1.4 1.4" />
    </>,
  ),
  // A thin web standing in the corner of an L-bracket.
  rib: icon(
    <>
      <path d="M3 17h14M3 17V3" />
      <path d="M3 6l9 11" />
      <path d="M5 6.5l8.5 10.5" strokeDasharray="1.4 1.4" />
    </>,
  ),
  // A model face whose front edge drops into the sketch.
  convert: icon(
    <>
      <path d="M3 7l4-4h10l-4 4z" />
      <path d="M3 7h10" strokeWidth={2} />
      <path d="M3 10v4M13 10v4" strokeDasharray="1.4 1.4" />
      <path d="M3 17h10" />
    </>,
  ),
  sketchMirror: icon(
    <>
      <path d="M10 2v16" strokeDasharray="2 1.6" />
      <path d="M8 5L3 14h5z" />
      <path d="M12 5l5 9h-5z" />
    </>,
  ),
  sketchFillet: icon(
    <>
      <path d="M4 16V9a5 5 0 0 1 5-5h7" />
      <path d="M4 4h3M4 4v3" strokeDasharray="1.2 1.2" />
    </>,
  ),
  dimension: icon(
    <>
      <path d="M3 6v8M17 6v8" />
      <path d="M3 10h14" />
      <path d="M5.5 8.2L3.2 10l2.3 1.8M14.5 8.2l2.3 1.8-2.3 1.8" />
    </>,
  ),
  ordinate: icon(
    <>
      <path d="M3 17h14" />
      <path d="M4.5 17V8M10 17v-6M15.5 17V6" />
      <circle cx="4.5" cy="5" r="1.6" />
    </>,
  ),
  relation: icon(
    <>
      <path d="M3 15L12 3" />
      <path d="M8 17l9-12" />
      <path d="M8.5 9.5l3 2" />
    </>,
  ),
  horizontal: icon(
    <>
      <path d="M3 10h14" />
      {dot(3, 10)}
      {dot(17, 10)}
    </>,
  ),
  vertical: icon(
    <>
      <path d="M10 3v14" />
      {dot(10, 3)}
      {dot(10, 17)}
    </>,
  ),
  coincident: icon(
    <>
      <path d="M3 15l6-5M17 15l-8-5" />
      <circle cx="9" cy="10" r="2.2" />
    </>,
  ),
  parallel: icon(<path d="M5 16L11 4M9 16l6-12" />),
  perpendicular: icon(<path d="M4 16h12M9 16V4" />),
  tangent: icon(
    <>
      <circle cx="10" cy="11" r="5" />
      <path d="M2.5 6h15" />
    </>,
  ),
  equal: icon(<path d="M4 7.5h12M4 12.5h12" />),
  concentric: icon(
    <>
      <circle cx="10" cy="10" r="7" />
      <circle cx="10" cy="10" r="3.5" />
    </>,
  ),
  midpoint: icon(
    <>
      <path d="M3 14L17 6" />
      <path d="M10 6.5l1.6 2.8H8.4z" fill="currentColor" stroke="none" />
    </>,
  ),
  collinear: icon(
    <>
      <path d="M2 15l6-4.3M12 7.9L18 3.6" />
      <path d="M8 10.7l4-2.8" strokeDasharray="1.2 1.4" />
    </>,
  ),
  symmetric: icon(
    <>
      <path d="M10 2v16" strokeDasharray="2 1.6" />
      {dot(5, 10, 1.6)}
      {dot(15, 10, 1.6)}
    </>,
  ),
  fix: icon(
    <>
      <path d="M10 3v9" />
      <path d="M5 12h10" />
      <path d="M6 15h8M8 18h4" />
    </>,
  ),
  extrude: icon(
    <>
      <path d="M3.5 14.5l5 2.5 8-4-5-2.5z" />
      <path d="M10 10.5V3M7.6 5.4L10 3l2.4 2.4" />
    </>,
  ),
  cut: icon(
    <>
      <path d="M3 8l7-3.5L17 8v6l-7 3.5L3 14z" />
      <path d="M7 9.2l3 1.5 3-1.5" />
      <path d="M10 10.7v4.5" strokeDasharray="1.3 1.3" />
    </>,
  ),
  revolve: icon(
    <>
      <path d="M10 2v16" strokeDasharray="2 1.6" />
      <path d="M12 5h3v6h-3" />
      <path d="M4.5 13.5a6 2.5 0 0 0 11 0" />
      <path d="M14.2 11.4l1.3 2.1-2.3.6" />
    </>,
  ),
  sweep: icon(
    <>
      <circle cx="5" cy="14" r="2.5" />
      <path d="M5 11.5C5 5 10 4 16 4" strokeDasharray="1.8 1.4" />
      <circle cx="16" cy="4" r="0.9" fill="currentColor" stroke="none" />
    </>,
  ),
  loft: icon(
    <>
      <path d="M3 15.5l4-2 5 1-4 2z" />
      <path d="M8 5.5l3-1.5 3.5.8-3 1.5z" />
      <path d="M3 15.5L8 5.5M12 14.5l2.5-9.7" />
    </>,
  ),
  fillet: icon(
    <>
      <path d="M3 17V9a6 6 0 0 1 6-6h8" />
      <path d="M7 17V11a2 2 0 0 1 2-2h8" strokeDasharray="1.4 1.4" />
    </>,
  ),
  chamfer: icon(
    <>
      <path d="M3 17V8l5-5h9" />
      <path d="M7 17v-6l3-3h7" strokeDasharray="1.4 1.4" />
    </>,
  ),
  shell: icon(
    <>
      <path d="M3 7l7-3.5L17 7v7l-7 3.5L3 14z" />
      <path d="M6 8.2l4-2 4 2-4 2z" />
      <path d="M6 8.2v4.3l4 2 4-2V8.2" strokeDasharray="1.2 1.2" />
    </>,
  ),
  motion: icon(
    <>
      <path d="M15.5 6.2A7 7 0 1 0 17 10" />
      <path d="M17.5 3.5V7h-3.5" />
      {dot(10, 10, 1.4)}
    </>,
  ),
  mass: icon(
    <>
      <path d="M6.5 7h7l2.5 10h-12z" />
      <circle cx="10" cy="4.8" r="2" />
    </>,
  ),
  gear: icon(
    <>
      <path d="M10 2.8l1.3 2.1 2.4-.7.4 2.5 2.4.8-1 2.3 1.7 1.8-2.1 1.3.7 2.4-2.5.4-.8 2.4-2.3-1-1.8 1.7-1.3-2.1-2.4.7-.4-2.5-2.4-.8 1-2.3L2.8 8.8l2.1-1.3-.7-2.4 2.5-.4.8-2.4 2.3 1z" />
      <circle cx="10" cy="10" r="2.2" />
    </>,
  ),
  pulley: icon(
    <>
      <circle cx="10" cy="10" r="6.5" />
      <circle cx="10" cy="10" r="2" />
      <path d="M10 3.5v1.5M10 15v1.5M3.5 10H5M15 10h1.5M5.4 5.4l1 1M13.6 13.6l1 1M5.4 14.6l1-1M13.6 6.4l1-1" />
    </>,
  ),
  belt: icon(
    <>
      <circle cx="5.5" cy="10" r="3" />
      <circle cx="15" cy="10" r="2" />
      <path d="M5.5 6.2L15 7.4M5.5 13.8l9.5-1.2" />
    </>,
  ),
  bend: icon(
    <>
      <path d="M2.5 15h7.5l6-7" />
      <path d="M10 3v14" strokeDasharray="1.4 1.4" />
    </>,
  ),
  member: icon(
    <>
      <path d="M3 5h14v3H3zM3 12h14v3H3z" />
      <path d="M5 8v4M15 8v4" />
    </>,
  ),
  weld: icon(
    <>
      <path d="M3 16h14M4 16V5" />
      <path d="M4 16l6-6" strokeDasharray="1.4 1.4" />
    </>,
  ),
  cutList: icon(
    <>
      <path d="M4 4h12M4 8h9M4 12h12M4 16h7" />
    </>,
  ),
  tangentEdges: icon(
    <>
      <path d="M4 3v9a5 5 0 0 0 5 5h8" />
      <path d="M2 12h4M9 15v4" />
    </>,
  ),
  // Display styles: one cube drawn each way, as on SolidWorks' view toolbar.
  shadedEdges: icon(
    <>
      {cubeFaces}
      {cubeEdges}
    </>,
  ),
  shaded: icon(cubeFaces),
  hiddenRemoved: icon(cubeEdges),
  hiddenVisible: icon(
    <>
      {cubeEdges}
      <path d={cubeHidden} strokeDasharray="1.4 1.6" strokeOpacity={0.7} />
    </>,
  ),
  wireframe: icon(
    <>
      {cubeEdges}
      <path d={cubeHidden} />
    </>,
  ),
  closedCorner: icon(
    <>
      <path d="M3 17V4h13" />
      <path d="M6.5 17V7.5H16" />
      <path d="M3 4l3.5 3.5" />
    </>,
  ),
  hem: icon(
    <>
      <path d="M3 15h11a3 3 0 0 0 0-6H8" />
      <path d="M3 13h11" strokeDasharray="1.4 1.4" />
    </>,
  ),
  thread: icon(
    <>
      <path d="M6 3.5h8v13H6z" />
      <path d="M6 6.5l8 1.5M6 9.5l8 1.5M6 12.5l8 1.5" />
    </>,
  ),
  equations: icon(<path d="M15 4.5H5l5.5 5.5L5 15.5h10" />),
  moveFace: icon(
    <>
      <path d="M3 13l7-3.5 7 3.5-7 3.5z" />
      <path d="M10 13V3.5M7.5 6L10 3.5 12.5 6" />
    </>,
  ),
  draft: icon(
    <>
      <path d="M5 16l2-12h6l2 12z" />
      <path d="M7 4L5 16" />
      <path d="M3 16h14" strokeDasharray="1.6 1.4" />
    </>,
  ),
  hole: icon(
    <>
      <path d="M2.5 9.5l7.5-4 7.5 4-7.5 4z" />
      <ellipse cx="10" cy="9.5" rx="2.6" ry="1.4" />
      <path d="M7.4 9.5v5M12.6 9.5v5" strokeDasharray="1.2 1.2" />
      <path d="M2.5 9.5v3l7.5 4 7.5-4v-3" />
    </>,
  ),
  linearPattern: icon(
    <>
      <rect x="2.5" y="7" width="4" height="6" />
      <rect x="8" y="7" width="4" height="6" />
      <rect x="13.5" y="7" width="4" height="6" strokeDasharray="1.2 1.2" />
    </>,
  ),
  circularPattern: icon(
    <>
      <circle cx="10" cy="10" r="1" fill="currentColor" stroke="none" />
      <circle cx="10" cy="3.8" r="1.8" />
      <circle cx="15.4" cy="13.1" r="1.8" />
      <circle cx="4.6" cy="13.1" r="1.8" strokeDasharray="1.1 1.1" />
    </>,
  ),
  mirror: icon(
    <>
      <path d="M10 2v16" strokeDasharray="2 1.6" />
      <path d="M8 5H3v10h5z" />
      <path d="M12 5h5v10h-5z" strokeDasharray="1.4 1.3" />
    </>,
  ),
  combine: icon(
    <>
      <rect x="3" y="3" width="9" height="9" />
      <rect x="8" y="8" width="9" height="9" />
    </>,
  ),
  split: icon(
    <>
      <path d="M3 7l7-3.5L17 7v7l-7 3.5L3 14z" />
      <path d="M1.5 11.5l17-3" strokeDasharray="1.8 1.4" />
    </>,
  ),
  move: icon(
    <>
      <path d="M10 2v16M2 10h16" />
      <path d="M8 4l2-2 2 2M8 16l2 2 2-2M4 8l-2 2 2 2M16 8l2 2-2 2" />
    </>,
  ),
  scale: icon(
    <>
      <rect x="3" y="9" width="8" height="8" />
      <path d="M7 3h10v10" strokeDasharray="1.4 1.3" />
      <path d="M11 9l5-5M12.5 4H16v3.5" />
    </>,
  ),
  plane: icon(<path d="M2.5 13.5l4-7h11l-4 7z" />),
  axis: icon(
    <>
      <path d="M3 17L17 3" strokeDasharray="3 1.5 0.5 1.5" />
      {dot(10, 10, 1.4)}
    </>,
  ),
  measure: icon(
    <>
      <path d="M3 13.5L13.5 3l3.5 3.5L6.5 17z" />
      <path d="M6 10.5l1.5 1.5M8.5 8l2 2M11 5.5l1.5 1.5" />
    </>,
  ),
  mate: icon(
    <>
      <rect x="2.5" y="9" width="7" height="7" />
      <rect x="10.5" y="4" width="7" height="7" />
      <path d="M9.5 9H12.5" />
      <circle cx="9.5" cy="9" r="1.2" fill="currentColor" stroke="none" />
    </>,
  ),
  component: icon(
    <>
      <path d="M3 6.5L10 3l7 3.5v7.5L10 17.5 3 14z" />
      <path d="M3 6.5L10 10l7-3.5M10 10v7.5" />
    </>,
  ),
  insert: icon(
    <>
      <path d="M3 6.5L10 3l7 3.5v7.5L10 17.5 3 14z" />
      <path d="M10 7.5v6M7 10.5h6" />
    </>,
  ),
  explode: icon(
    <>
      <rect x="7" y="7.5" width="6" height="5" />
      <path d="M10 6V2.5M8.5 4L10 2.5 11.5 4M10 14v3.5M8.5 16l1.5 1.5 1.5-1.5" />
      <path d="M5.5 10H2.5M4 8.5L2.5 10 4 11.5M14.5 10h3M16 8.5l1.5 1.5-1.5 1.5" />
    </>,
  ),
  interference: icon(
    <>
      <rect x="3" y="3" width="9" height="9" />
      <rect x="8" y="8" width="9" height="9" />
      <path d="M8 10l2-2M8 12l4-4M10 12l2-2" strokeWidth={1} />
    </>,
  ),
  bom: icon(
    <>
      <rect x="3" y="3" width="14" height="14" />
      <path d="M3 7.5h14M3 12h14M7 3v14" />
    </>,
  ),
  drawingView: icon(
    <>
      <rect x="2.5" y="3.5" width="15" height="13" />
      <path d="M6 13V7.5h4.5V13zM10.5 9.5H14V13h-3.5" />
    </>,
  ),
  projectedView: icon(
    <>
      <rect x="2.5" y="3" width="6.5" height="6.5" />
      <rect x="11" y="3" width="6.5" height="6.5" strokeDasharray="1.4 1.2" />
      <rect x="2.5" y="11" width="6.5" height="6.5" strokeDasharray="1.4 1.2" />
    </>,
  ),
  sectionView: icon(
    <>
      <path d="M3 10h14" strokeDasharray="3 1.5 0.5 1.5" />
      <path d="M3 10V6M17 10V6M1.5 7.5L3 6l1.5 1.5M15.5 7.5L17 6l1.5 1.5" />
      <path d="M5 13l3-3M8 14l4-4M11 14l3-3" strokeWidth={1} />
    </>,
  ),
  detailView: icon(
    <>
      <circle cx="8" cy="8" r="5" />
      <path d="M11.6 11.6L17 17" />
    </>,
  ),
  note: icon(
    <>
      <path d="M4 16L10 3l6 13M6.3 11.5h7.4" />
    </>,
  ),
  balloon: icon(
    <>
      <circle cx="12" cy="8" r="5" />
      <path d="M8.5 11.5L3 17" />
      {dot(3, 17, 1)}
    </>,
  ),
  centerline: icon(<path d="M2 10h16" strokeDasharray="4 1.5 1 1.5" />),
  centerMark: icon(
    <>
      <circle cx="10" cy="10" r="5.5" />
      <path d="M10 2v5M10 13v5M2 10h5M13 10h5" />
    </>,
  ),
  holeCallout: icon(
    <>
      <circle cx="6" cy="13" r="3" />
      <path d="M8 11l5-6h5" />
    </>,
  ),
  surfaceFinish: icon(<path d="M3 12l3 5 7-14h5" />),
  datum: icon(
    <>
      <rect x="6" y="3" width="8" height="7" />
      <path d="M10 10v4M7 17l3-3 3 3z" />
    </>,
  ),
  gdt: icon(
    <>
      <rect x="2" y="6" width="16" height="8" />
      <path d="M7 6v8M12 6v8M3.5 10h2" />
    </>,
  ),
  sheet: icon(
    <>
      <rect x="3" y="2.5" width="14" height="15" />
      <path d="M3 13.5h14M10 13.5v4" />
    </>,
  ),
  normalTo: icon(
    <>
      <rect x="4" y="6" width="12" height="8" />
      <path d="M10 2v6M8.2 6.3L10 8.1l1.8-1.8" />
    </>,
  ),
  section3d: icon(
    <>
      <path d="M3 7l7-3.5L17 7v7l-7 3.5L3 14z" />
      <path d="M10 3.5v14" />
      <path d="M10 10l7-3" />
    </>,
  ),
  intent: icon(
    <>
      <path d="M4 3h12v10H9l-4 4v-4H4z" />
      <path d="M7 7h6M7 10h4" />
    </>,
  ),
};
export type IconName = keyof typeof Icons;

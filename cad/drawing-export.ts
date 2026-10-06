// Drawing writers: SVG for the editor, vector PDF for printing, DXF for CAM/CAD exchange.
import { arcCenter, type Cmd, type Prim } from "./drawing.ts";
import type { Vec2 } from "./types.ts";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const n = (v: number) => (Math.abs(v) < 1e-9 ? "0" : String(Math.round(v * 1000) / 1000));
function svgPath(cmds: Cmd[]) {
  return cmds
    .map((c) => (c[0] === "Z" ? "Z" : `${c[0]} ${c.slice(1).map((v) => n(v as number)).join(" ")}`))
    .join(" ");
}
export function toSVG(prims: Prim[], width: number, height: number, title: string) {
  let body = "",
    clipId = 0;
  const open: string[] = [];
  for (const p of prims) {
    if (p.k === "group") {
      const attrs = { ...(p.id ? { "data-view": p.id } : {}), ...(p.attrs ?? {}) };
      body += `<g${Object.entries(attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join("")}>`;
      open.push("g");
    } else if (p.k === "endgroup") {
      body += "</g>";
      open.pop();
    } else if (p.k === "clip") {
      const id = `clip${clipId++}`;
      body += `<clipPath id="${id}"><circle cx="${n(p.center[0])}" cy="${n(p.center[1])}" r="${n(p.radius)}"/></clipPath><g clip-path="url(#${id})">`;
    } else if (p.k === "unclip") body += "</g>";
    else if (p.k === "path") {
      const s = p.style;
      body += `<path d="${svgPath(p.cmds)}" fill="${s.fill ?? "none"}" stroke="${s.color ?? "#1E1E1E"}" stroke-width="${n(s.width)}"${s.dash ? ` stroke-dasharray="${s.dash.map(n).join(" ")}"` : ""} stroke-linecap="round" stroke-linejoin="round"${s.layer ? ` data-layer="${s.layer}"` : ""}/>`;
    } else if (p.k === "text") {
      const t = p.rotate ? ` transform="rotate(${n(p.rotate)} ${n(p.at[0])} ${n(p.at[1])})"` : "";
      body += `<text x="${n(p.at[0])}" y="${n(p.at[1])}" font-size="${n(p.size)}" text-anchor="${p.anchor}"${p.bold ? ' font-weight="700"' : ""}${t}>${esc(p.text)}</text>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}mm" height="${n(height)}mm" viewBox="0 0 ${n(width)} ${n(height)}" role="img" aria-label="${esc(title)}"><rect width="${n(width)}" height="${n(height)}" fill="#FFFFFF"/><g font-family="Arial, Helvetica, sans-serif" fill="#1E1E1E">${body}</g></svg>`;
}

// ---------------------------------------------------------------------------
// PDF
const helvetica: Record<string, number> = {};
"278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584"
  .split(" ")
  .forEach((w, i) => (helvetica[String.fromCharCode(32 + i)] = Number(w)));
Object.assign(helvetica, { "Ø": 778, "±": 584, "°": 400, "×": 584, "µ": 556 });
const winAnsi: Record<string, number> = { "Ø": 0xd8, "±": 0xb1, "°": 0xb0, "×": 0xd7, "µ": 0xb5, "·": 0xb7, "–": 0x96, "—": 0x97 };
export function textWidth(text: string, size: number, bold = false) {
  let w = 0;
  for (const ch of text) w += helvetica[ch] ?? 556;
  return (w / 1000) * size * (bold ? 1.05 : 1);
}
function pdfString(text: string) {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (ch === "(" || ch === ")" || ch === "\\") out += "\\" + ch;
    else if (code >= 32 && code < 127) out += ch;
    else if (winAnsi[ch]) out += "\\" + winAnsi[ch].toString(8).padStart(3, "0");
    else out += "?";
  }
  return `(${out})`;
}
/** SVG arc to cubic Bézier segments (each ≤ 90°). */
function arcToBeziers(from: Vec2, c: Extract<Cmd, ["A", ...number[]]>): number[][] {
  const { cx, cy, rx, ry, a0, delta } = arcCenter(from, c);
  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  const step = delta / segments,
    k = (4 / 3) * Math.tan(step / 4);
  const out: number[][] = [];
  for (let i = 0; i < segments; i++) {
    const t0 = a0 + i * step,
      t1 = t0 + step;
    const p0 = [cx + rx * Math.cos(t0), cy + ry * Math.sin(t0)],
      p1 = [cx + rx * Math.cos(t1), cy + ry * Math.sin(t1)];
    out.push([
      p0[0] - k * rx * Math.sin(t0),
      p0[1] + k * ry * Math.cos(t0),
      p1[0] + k * rx * Math.sin(t1),
      p1[1] - k * ry * Math.cos(t1),
      p1[0],
      p1[1],
    ]);
  }
  return out;
}
export function toPDF(prims: Prim[], width: number, height: number, title: string): Uint8Array {
  const pt = 72 / 25.4;
  const X = (x: number) => (x * pt).toFixed(3),
    Y = (y: number) => ((height - y) * pt).toFixed(3);
  let content = "1 J 1 j\n";
  for (const p of prims) {
    if (p.k === "clip") {
      const r = p.radius,
        c = p.center,
        k = 0.5523 * r;
      content += `q ${X(c[0] + r)} ${Y(c[1])} m ${X(c[0] + r)} ${Y(c[1] + k)} ${X(c[0] + k)} ${Y(c[1] + r)} ${X(c[0])} ${Y(c[1] + r)} c ${X(c[0] - k)} ${Y(c[1] + r)} ${X(c[0] - r)} ${Y(c[1] + k)} ${X(c[0] - r)} ${Y(c[1])} c ${X(c[0] - r)} ${Y(c[1] - k)} ${X(c[0] - k)} ${Y(c[1] - r)} ${X(c[0])} ${Y(c[1] - r)} c ${X(c[0] + k)} ${Y(c[1] - r)} ${X(c[0] + r)} ${Y(c[1] - k)} ${X(c[0] + r)} ${Y(c[1])} c h W n\n`;
    } else if (p.k === "unclip") content += "Q\n";
    else if (p.k === "path") {
      const s = p.style;
      content += `${(s.width * pt).toFixed(3)} w [${(s.dash ?? []).map((d) => (d * pt).toFixed(2)).join(" ")}] 0 d\n`;
      let at: Vec2 = [0, 0],
        start: Vec2 = [0, 0];
      for (const c of p.cmds) {
        if (c[0] === "M") {
          content += `${X(c[1])} ${Y(c[2])} m `;
          at = start = [c[1], c[2]];
        } else if (c[0] === "L") {
          content += `${X(c[1])} ${Y(c[2])} l `;
          at = [c[1], c[2]];
        } else if (c[0] === "C") {
          content += `${X(c[1])} ${Y(c[2])} ${X(c[3])} ${Y(c[4])} ${X(c[5])} ${Y(c[6])} c `;
          at = [c[5], c[6]];
        } else if (c[0] === "A") {
          for (const b of arcToBeziers(at, c)) content += `${X(b[0])} ${Y(b[1])} ${X(b[2])} ${Y(b[3])} ${X(b[4])} ${Y(b[5])} c `;
          at = [c[6], c[7]];
        } else if (c[0] === "Z") {
          content += "h ";
          at = start;
        }
      }
      content += s.fill ? "0.118 0.118 0.118 rg B\n" : "S\n";
    } else if (p.k === "text") {
      const size = p.size * pt,
        w = textWidth(p.text, p.size, p.bold);
      const shift = p.anchor === "middle" ? -w / 2 : p.anchor === "end" ? -w : 0;
      const a = (-(p.rotate ?? 0) * Math.PI) / 180,
        cos = Math.cos(a),
        sin = Math.sin(a);
      const x = p.at[0] + shift * Math.cos(((p.rotate ?? 0) * Math.PI) / 180),
        y = p.at[1] + shift * Math.sin(((p.rotate ?? 0) * Math.PI) / 180);
      content += `BT /${p.bold ? "F2" : "F1"} ${size.toFixed(2)} Tf 0.118 0.118 0.118 rg ${cos.toFixed(5)} ${sin.toFixed(5)} ${(-sin).toFixed(5)} ${cos.toFixed(5)} ${X(x)} ${Y(y)} Tm ${pdfString(p.text)} Tj ET\n`;
    }
  }
  const objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  objects.push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${(width * pt).toFixed(2)} ${(height * pt).toFixed(2)}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
  );
  objects.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  objects.push(`<< /Title ${pdfString(title)} /Producer (Vibe CAD) >>`);
  let pdf = "%PDF-1.4\n%âãÏÓ\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Latin-1 bytes; content is ASCII apart from the binary marker comment.
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}

// ---------------------------------------------------------------------------
// DXF (R12)
export function toDXF(prims: Prim[], height: number): string {
  const out: string[] = [];
  const g = (code: number, value: string | number) => out.push(String(code), typeof value === "number" ? n(value) : value);
  const layerOf = (l?: string) => (l ?? "ANNOTATION").toUpperCase();
  const layers = new Set(["0"]);
  const entities: (() => void)[] = [];
  const Y = (y: number) => height - y;
  for (const p of prims) {
    if (p.k === "path") {
      const layer = layerOf(p.style.layer);
      layers.add(layer);
      let at: Vec2 = [0, 0],
        start: Vec2 = [0, 0];
      const pts: Vec2[] = [];
      for (const c of p.cmds) {
        if (c[0] === "M") {
          at = start = [c[1], c[2]];
          pts.length = 0;
          pts.push(at);
        } else if (c[0] === "L" || c[0] === "Z") {
          const to: Vec2 = c[0] === "L" ? [c[1], c[2]] : start;
          const from = at;
          if (p.style.fill) pts.push(to);
          else
            entities.push(() => {
              g(0, "LINE");
              g(8, layer);
              g(10, from[0]);
              g(20, Y(from[1]));
              g(11, to[0]);
              g(21, Y(to[1]));
            });
          at = to;
        } else if (c[0] === "A") {
          const from = at;
          const { cx, cy, rx, a0, delta } = arcCenter(from, c);
          // DXF arcs run counter-clockwise in y-up space; y flip reverses direction.
          const s = (-a0 * 180) / Math.PI,
            e = (-(a0 + delta) * 180) / Math.PI;
          const [startAngle, endAngle] = delta > 0 ? [e, s] : [s, e];
          entities.push(() => {
            g(0, "ARC");
            g(8, layer);
            g(10, cx);
            g(20, Y(cy));
            g(40, rx);
            g(50, startAngle);
            g(51, endAngle);
          });
          at = [c[6], c[7]];
        } else if (c[0] === "C") {
          const from = at,
            to: Vec2 = [c[5], c[6]];
          entities.push(() => {
            let prev = from;
            for (let i = 1; i <= 8; i++) {
              const t = i / 8,
                u = 1 - t;
              const q: Vec2 = [
                u * u * u * from[0] + 3 * u * u * t * c[1] + 3 * u * t * t * c[3] + t * t * t * c[5],
                u * u * u * from[1] + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6],
              ];
              g(0, "LINE");
              g(8, layer);
              g(10, prev[0]);
              g(20, Y(prev[1]));
              g(11, q[0]);
              g(21, Y(q[1]));
              prev = q;
            }
          });
          at = to;
        }
      }
      if (p.style.fill && pts.length >= 3) {
        const q = [...pts.slice(0, 3), pts[3] ?? pts[2]];
        entities.push(() => {
          g(0, "SOLID");
          g(8, layer);
          [10, 11, 12, 13].forEach((code, i) => {
            g(code, q[i][0]);
            g(code + 10, Y(q[i][1]));
          });
        });
      }
    } else if (p.k === "text") {
      layers.add("TEXT");
      entities.push(() => {
        g(0, "TEXT");
        g(8, "TEXT");
        g(10, p.at[0]);
        g(20, Y(p.at[1]));
        g(40, p.size * 0.72);
        g(1, p.text.replace(/Ø/g, "%%c").replace(/±/g, "%%p").replace(/°/g, "%%d"));
        if (p.rotate) g(50, -p.rotate);
        const h = p.anchor === "middle" ? 1 : p.anchor === "end" ? 2 : 0;
        if (h) {
          g(72, h);
          g(11, p.at[0]);
          g(21, Y(p.at[1]));
        }
      });
    }
  }
  g(0, "SECTION");
  g(2, "HEADER");
  g(9, "$INSUNITS");
  g(70, 4);
  g(0, "ENDSEC");
  g(0, "SECTION");
  g(2, "TABLES");
  g(0, "TABLE");
  g(2, "LTYPE");
  g(70, 3);
  for (const [name, desc, pattern] of [
    ["CONTINUOUS", "Solid line", [] as number[]],
    ["HIDDEN", "Hidden __ __ __", [3.2, -1.6]],
    ["CENTER", "Center ____ _ ____", [10, -2, 2, -2]],
  ] as const) {
    g(0, "LTYPE");
    g(2, name);
    g(70, 0);
    g(3, desc);
    g(72, 65);
    g(73, pattern.length);
    g(40, pattern.reduce((s, x) => s + Math.abs(x), 0));
    for (const x of pattern) g(49, x);
  }
  g(0, "ENDTAB");
  g(0, "TABLE");
  g(2, "LAYER");
  g(70, layers.size);
  for (const l of layers) {
    g(0, "LAYER");
    g(2, l);
    g(70, 0);
    g(62, l === "HIDDEN" ? 8 : l === "CENTER" ? 1 : 7);
    g(6, l === "HIDDEN" ? "HIDDEN" : l === "CENTER" ? "CENTER" : "CONTINUOUS");
  }
  g(0, "ENDTAB");
  g(0, "ENDSEC");
  g(0, "SECTION");
  g(2, "ENTITIES");
  for (const e of entities) e();
  g(0, "ENDSEC");
  g(0, "EOF");
  return out.join("\n") + "\n";
}

/** Flat pattern as DXF for cutting: the outline on CUT, bend centerlines and their notes on BEND. */
export function flatPatternDXF(flat: {
  segments: [[number, number], [number, number]][];
  bends: { a: [number, number]; b: [number, number]; label: string }[];
}): string {
  const out: string[] = [];
  const g = (code: number, value: string | number) => out.push(String(code), typeof value === "number" ? n(value) : value);
  g(0, "SECTION");
  g(2, "HEADER");
  g(9, "$INSUNITS");
  g(70, 4);
  g(0, "ENDSEC");
  g(0, "SECTION");
  g(2, "TABLES");
  g(0, "TABLE");
  g(2, "LTYPE");
  g(70, 2);
  for (const [name, desc, pattern] of [
    ["CONTINUOUS", "Solid line", [] as number[]],
    ["CENTER", "Center ____ _ ____", [10, -2, 2, -2]],
  ] as const) {
    g(0, "LTYPE");
    g(2, name);
    g(70, 0);
    g(3, desc);
    g(72, 65);
    g(73, pattern.length);
    g(40, pattern.reduce((s, x) => s + Math.abs(x), 0));
    for (const x of pattern) g(49, x);
  }
  g(0, "ENDTAB");
  g(0, "TABLE");
  g(2, "LAYER");
  g(70, 2);
  for (const [name, color, type] of [
    ["CUT", 7, "CONTINUOUS"],
    ["BEND", 1, "CENTER"],
  ] as const) {
    g(0, "LAYER");
    g(2, name);
    g(70, 0);
    g(62, color);
    g(6, type);
  }
  g(0, "ENDTAB");
  g(0, "ENDSEC");
  g(0, "SECTION");
  g(2, "ENTITIES");
  const line = (layer: string, a: [number, number], b: [number, number]) => {
    g(0, "LINE");
    g(8, layer);
    g(10, a[0]);
    g(20, a[1]);
    g(11, b[0]);
    g(21, b[1]);
  };
  for (const [a, b] of flat.segments) line("CUT", a, b);
  for (const bend of flat.bends) {
    line("BEND", bend.a, bend.b);
    g(0, "TEXT");
    g(8, "BEND");
    g(10, (bend.a[0] + bend.b[0]) / 2);
    g(20, (bend.a[1] + bend.b[1]) / 2 + 1.5);
    g(40, 2.5);
    g(1, bend.label.replace(/°/g, "%%d"));
    g(72, 1);
    g(11, (bend.a[0] + bend.b[0]) / 2);
    g(21, (bend.a[1] + bend.b[1]) / 2 + 1.5);
  }
  g(0, "ENDSEC");
  g(0, "EOF");
  return out.join("\n") + "\n";
}

/**
 * A plate outline at 1:1 for waterjet, laser or router cutting: one CUT layer
 * of lines, arcs, circles and polylines, in millimeters or inches.
 */
export function profileDXF(
  outline: {
    entities: (
      | { kind: "line"; a: [number, number]; b: [number, number] }
      | { kind: "circle"; center: [number, number]; radius: number }
      | { kind: "arc"; center: [number, number]; radius: number; start: number; end: number }
      | { kind: "polyline"; points: [number, number][] }
    )[];
  },
  units: "mm" | "in" = "mm",
): string {
  const k = units === "in" ? 1 / 25.4 : 1;
  const out: string[] = [];
  // Cutting files keep a micron (or a few hundred-thousandths of an inch).
  const fine = (v: number) => (Math.abs(v) < 1e-9 ? "0" : String(Math.round(v * 1e6) / 1e6));
  const g = (code: number, value: string | number) => out.push(String(code), typeof value === "number" ? fine(value) : value);
  g(0, "SECTION");
  g(2, "HEADER");
  g(9, "$INSUNITS");
  g(70, units === "in" ? 1 : 4);
  g(9, "$MEASUREMENT");
  g(70, units === "in" ? 0 : 1);
  g(0, "ENDSEC");
  g(0, "SECTION");
  g(2, "TABLES");
  g(0, "TABLE");
  g(2, "LAYER");
  g(70, 1);
  g(0, "LAYER");
  g(2, "CUT");
  g(70, 0);
  g(62, 7);
  g(6, "CONTINUOUS");
  g(0, "ENDTAB");
  g(0, "ENDSEC");
  g(0, "SECTION");
  g(2, "ENTITIES");
  for (const e of outline.entities) {
    if (e.kind === "line") {
      g(0, "LINE");
      g(8, "CUT");
      g(10, e.a[0] * k);
      g(20, e.a[1] * k);
      g(11, e.b[0] * k);
      g(21, e.b[1] * k);
    } else if (e.kind === "circle" || e.kind === "arc") {
      g(0, e.kind === "circle" ? "CIRCLE" : "ARC");
      g(8, "CUT");
      g(10, e.center[0] * k);
      g(20, e.center[1] * k);
      g(40, e.radius * k);
      if (e.kind === "arc") {
        g(50, e.start);
        g(51, e.end);
      }
    } else {
      g(0, "LWPOLYLINE");
      g(8, "CUT");
      g(90, e.points.length);
      g(70, 0);
      for (const p of e.points) {
        g(10, p[0] * k);
        g(20, p[1] * k);
      }
    }
  }
  g(0, "ENDSEC");
  g(0, "EOF");
  return out.join("\n") + "\n";
}

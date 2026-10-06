// The Display section shared by body and component properties: color,
// texture, transparency and display mode, as SolidWorks' Appearance,
// Change Transparency and Display Mode.
import type { DisplayStyle, Texture } from "../../cad/types.ts";
import { displayStyles, textures } from "../../cad/appearance.ts";
import { Choice, NumberField } from "../ui.tsx";
import { textureSwatch } from "../viewport/textures.ts";
import type { Cad } from "../state.ts";

export function AppearanceFields({
  cad,
  objectId,
  color,
  opacity,
  style,
  texture,
}: {
  cad: Cad;
  objectId: string;
  color: string;
  opacity?: number;
  style?: DisplayStyle;
  texture?: Texture;
}) {
  const appearance = (change: { color?: string; texture?: Texture | "none"; transparency?: number }) => void cad.run("set_appearance", { objectId, ...change });
  return (
    <>
      <label className="field">
        <span>Color</span>
        <input type="color" aria-label="Color" value={color.toLowerCase()} onChange={(e) => appearance({ color: e.target.value.toUpperCase() })} />
      </label>
      <div className="field">
        <span>Texture</span>
        <div className="swatches" role="radiogroup" aria-label="Texture">
          <button
            type="button"
            role="radio"
            aria-checked={!texture}
            title="None"
            className={`swatch ${texture ? "" : "on"}`}
            style={{ background: color }}
            onClick={() => texture && appearance({ texture: "none" })}
          />
          {textures.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={texture === t.id}
              title={t.name}
              className={`swatch ${texture === t.id ? "on" : ""}`}
              style={{ backgroundImage: `url(${textureSwatch(t.id)})` }}
              onClick={() => texture !== t.id && appearance({ texture: t.id })}
            />
          ))}
        </div>
      </div>
      <NumberField
        label="Transparency"
        unit="%"
        value={Math.round((1 - (opacity ?? 1)) * 100)}
        min={0}
        max={100}
        step={5}
        onChange={(transparency) => appearance({ transparency })}
      />
      <Choice<DisplayStyle | "default">
        label="Display mode"
        value={style ?? "default"}
        options={[{ value: "default", label: "Default" }, ...displayStyles.map((s) => ({ value: s.id, label: s.name }))]}
        onChange={(next) => void cad.run("set_display_style", { objectId, style: next })}
      />
    </>
  );
}

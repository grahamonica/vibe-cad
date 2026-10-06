// Shared controls: numeric fields, segmented choices, selection boxes, menus.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { fromDisplay, toDisplay, unitLabel, useUnits } from "./units.ts";

/** Evaluate a numeric field: numbers with + - * / and parentheses (no eval). */
export function evaluate(text: string): number | undefined {
  const src = text.replace(/mm|°|deg/gi, "").replace(/\s+/g, "");
  if (!src) return undefined;
  let i = 0;
  const peek = () => src[i];
  const number = (): number => {
    if (peek() === "(") {
      i++;
      const v = sum();
      if (peek() !== ")") throw Error();
      i++;
      return v;
    }
    if (peek() === "-") {
      i++;
      return -number();
    }
    if (peek() === "+") {
      i++;
      return number();
    }
    const m = /^\d*\.?\d+(?:e[+-]?\d+)?/i.exec(src.slice(i));
    if (!m) throw Error();
    i += m[0].length;
    return Number(m[0]);
  };
  const product = (): number => {
    let v = number();
    while (peek() === "*" || peek() === "/") {
      const op = src[i++],
        rhs = number();
      v = op === "*" ? v * rhs : v / rhs;
    }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (peek() === "+" || peek() === "-") {
      const op = src[i++],
        rhs = product();
      v = op === "+" ? v + rhs : v - rhs;
    }
    return v;
  };
  try {
    const v = sum();
    return i === src.length && Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
const show = (n: number) => String(Math.round(n * 1e4) / 1e4);
export function NumberField({
  label,
  value,
  onChange,
  unit = "mm",
  min,
  max,
  step = 1,
  integer = false,
  disabled = false,
  autoFocus = false,
  expression,
  onExpression,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  /** Equation driving the value; typing `=…` sets one when onExpression is given. */
  expression?: string;
  onExpression?: (expression: string) => void;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  // Lengths are stored in millimeters and shown in the document's units.
  const units = useUnits(),
    length = unit === "mm",
    shown = length ? toDisplay(value) : value,
    displayStep = length && units === "in" ? 0.05 : step;
  const [draft, setDraft] = useState(show(shown)),
    [invalid, setInvalid] = useState(false),
    focused = useRef(false),
    // Enter commits and then blurs; the blur must not send the same edit again.
    sent = useRef<number | undefined>(undefined);
  useEffect(() => {
    sent.current = undefined;
  }, [value]);
  useEffect(() => {
    if (!focused.current) setDraft(show(shown));
  }, [shown]);
  const commit = (text = draft) => {
    const typed = text.trim();
    if (onExpression && typed.startsWith("=")) {
      const expr = typed.slice(1).trim();
      setInvalid(!expr);
      setDraft(show(shown));
      if (expr && expr !== expression) onExpression(expr);
      return;
    }
    let v = evaluate(text);
    if (v === undefined) {
      setInvalid(true);
      return;
    }
    if (integer) v = Math.round(v);
    if (length) v = fromDisplay(v!);
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    setInvalid(false);
    setDraft(show(length ? toDisplay(v) : v));
    if (Math.abs(v - value) > 1e-12 && sent.current !== v) {
      sent.current = v;
      onChange(v);
    }
  };
  return (
    <label className={`field ${invalid ? "invalid" : ""}`}>
      <span>{label}</span>
      <span className="field-input">
        <input
          aria-label={label}
          value={draft}
          disabled={disabled}
          autoFocus={autoFocus}
          inputMode="decimal"
          onFocus={(e) => {
            focused.current = true;
            // An equation is edited as written, not as its current value.
            if (expression) setDraft(`=${expression}`);
            const input = e.currentTarget;
            requestAnimationFrame(() => input.select());
          }}
          onChange={(e) => {
            setDraft(e.target.value);
            setInvalid(false);
          }}
          onBlur={() => {
            focused.current = false;
            commit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit();
              (e.currentTarget as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              setDraft(show(shown));
              (e.currentTarget as HTMLInputElement).blur();
            } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const base = evaluate(draft) ?? shown,
                next = base + (e.key === "ArrowUp" ? 1 : -1) * displayStep * (e.shiftKey ? 10 : 1);
              commit(show(next));
            }
            e.stopPropagation();
          }}
        />
        {expression && <small className="equation">Σ</small>}
        {unit && <small>{length ? unitLabel() : unit}</small>}
      </span>
    </label>
  );
}
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? "on" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
export function Check({ label, value, onChange, disabled = false }: { label: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="check">
      <input type="checkbox" checked={value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
export function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
export interface BoxItem {
  key: string;
  label: string;
}
export function SelectionBox({
  label,
  items,
  active,
  placeholder,
  onActivate,
  onRemove,
}: {
  label: string;
  items: BoxItem[];
  active: boolean;
  placeholder: string;
  onActivate: () => void;
  onRemove: (key: string) => void;
}) {
  return (
    <div
      className={`selection-box ${active ? "active" : ""}`}
      role="listbox"
      aria-label={label}
      tabIndex={0}
      onClick={onActivate}
      onFocus={onActivate}
    >
      <div className="selection-box-label">{label}</div>
      {items.length ? (
        items.map((item) => (
          <div className="selection-item" key={item.key} role="option" aria-selected="true">
            <span>{item.label}</span>
            <button
              type="button"
              aria-label={`Remove ${item.label}`}
              onClick={(e) => {
                e.stopPropagation();
                onRemove(item.key);
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))
      ) : (
        <div className="selection-placeholder">{placeholder}</div>
      )}
    </div>
  );
}
export interface MenuItem {
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  shortcut?: string;
  onSelect?: () => void;
  separator?: boolean;
  /** The current choice in a menu of alternatives. */
  checked?: boolean;
}
/** Floating command menu (context menus and drop-downs). */
export function Menu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null),
    [position, setPosition] = useState({ x, y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPosition({
      x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    });
  }, [x, y, items.length]);
  useEffect(() => {
    const close = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  return (
    <div className="menu" role="menu" ref={ref} style={{ left: position.x, top: position.y }}>
      {items.map((item, i) =>
        item.separator ? (
          <div className="menu-separator" key={i} role="separator" />
        ) : (
          <button
            key={i}
            role={item.checked === undefined ? "menuitem" : "menuitemradio"}
            aria-checked={item.checked}
            className={item.danger ? "danger" : item.checked ? "checked" : ""}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect?.();
            }}
          >
            <span className="menu-icon">{item.icon}</span>
            <span>{item.label}</span>
            {item.shortcut && <kbd>{item.shortcut}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}

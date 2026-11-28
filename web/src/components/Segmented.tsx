import type { ReactNode } from "react";
import { cn } from "../lib/format";

/** A row of mutually exclusive choices (theme, language, speed…). */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  dense,
}: {
  label: string;
  /** Tighter buttons, for many short options. */
  dense?: boolean;
  value: T;
  options: [T, ReactNode][];
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-full bg-surface-1 p-1 ring-1 ring-line">
      {options.map(([v, content]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cn(
            "flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full text-[13px] font-medium transition-colors duration-200",
            dense ? "px-1 tabular-nums" : "px-3",
            value === v ? "bg-surface-4 text-fg shadow-[inset_0_1px_0_var(--highlight)]" : "text-fg-2 hover:text-fg",
          )}
        >
          {content}
        </button>
      ))}
    </div>
  );
}

import { Children, isValidElement, type ComponentProps, type ReactNode } from "react";
import { Button as ShadButton } from "@/components/ui/button";
import { Badge, Button as KitButton, Kbd as KitKbd, SegmentedControl, Switch as KitSwitch, TextField } from "@/components/affect";
import { dangerOutline } from "@/components/dass";

/**
 * Settings' controls drawn by the affectUI kit (components/affect, merged 0e53bfb7), under the names and props the Settings
 * sections already use (shadcn's Button, Switch and Input, Dass's Choice and StateBadge), so a section swaps one import line
 * rather than every call. Only lazily loaded pages import this (Settings, Usage): the kit's styles come with them, never with
 * the first screen or a session.
 */

/** An icon, as a button's children start or end with one: lucide's components, Friday's Icon, a bare <svg>. */
const isIcon = (n: ReactNode) => isValidElement(n) && (typeof n.type !== "string" || n.type === "svg");

type ShadProps = ComponentProps<typeof ShadButton>;

/**
 * shadcn's Button props on the kit's: default is the kit's primary, outline and secondary its secondary, ghost its ghost, a
 * destructive one (or an outline with dangerOutline's red words) its destructive; xs is the kit's 24px sm, every other size its
 * 28px md. A leading or trailing icon in the children becomes the kit's icon or iconRight. asChild and link keep shadcn's.
 */
export function Button({ variant = "default", size = "default", asChild, children, className, ...rest }: ShadProps) {
  if (asChild || variant === "link") return <ShadButton variant={variant} size={size} asChild={asChild} className={className} {...rest}>{children}</ShadButton>;
  const kids = Children.toArray(children);
  const icon = kids.length && isIcon(kids[0]) ? kids.shift() : undefined;
  const iconRight = kids.length && isIcon(kids[kids.length - 1]) ? kids.pop() : undefined;
  const danger = variant === "destructive" || (className ?? "").includes(dangerOutline);
  const tone = danger ? "destructive" : variant === "default" ? "primary" : variant === "ghost" ? "ghost" : "secondary";
  const label = kids.length === 1 ? kids[0] : kids.length ? kids : undefined;
  return (
    <KitButton
      variant={tone}
      size={size === "xs" || size === "icon-xs" ? "sm" : "md"}
      icon={icon}
      iconRight={iconRight}
      className={danger ? (className ?? "").replace(dangerOutline, "").trim() || undefined : className}
      {...(rest as ComponentProps<typeof KitButton>)}
    >
      {label}
    </KitButton>
  );
}

/**
 * shadcn's Switch props on the kit's switch (a real checkbox with role="switch", 26×16): checked and onCheckedChange, and
 * aria-checked said out loud as Radix did, which the specs read. Its "on" colour is the app's green (settings-polish.css).
 */
export function Switch({
  checked,
  defaultChecked,
  onCheckedChange,
  disabled,
  id,
  className,
  title,
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
  "aria-describedby": describedBy,
}: {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (on: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  title?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  size?: "sm" | "default";
}) {
  return (
    <KitSwitch
      size="sm"
      className={["set-switch", className].filter(Boolean).join(" ")}
      {...(checked !== undefined ? { checked, "aria-checked": checked } : { defaultChecked })}
      onChange={(e) => onCheckedChange?.(e.currentTarget.checked)}
      disabled={disabled}
      id={id}
      title={title}
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
    />
  );
}

/**
 * Dass's Choice on the kit's segmented control: separate quiet chips, the chosen one filled, its fill sliding to the next. An
 * option that can't be chosen stays visible and disabled; why is said in the control's own title.
 */
export function Choice<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
  className,
  full,
}: {
  value: T;
  options: readonly (readonly [T, ReactNode] | readonly [T, ReactNode, { disabled?: boolean; title?: string }])[];
  onChange: (v: T) => void;
  label?: string;
  disabled?: boolean;
  className?: string;
  /** Equal segments across the row (a dialog's choice). */
  full?: boolean;
}) {
  return (
    <SegmentedControl<T>
      fullWidth={full}
      value={value}
      onChange={onChange}
      aria-label={label}
      disabled={disabled}
      className={["set-choice", className].filter(Boolean).join(" ")}
      options={options.map(([v, text, o]) => ({ value: v, label: text, ...(o?.disabled ? { disabled: true } : {}) }))}
    />
  );
}

/** Dass's StateBadge on the kit's badge: live is info, needs is warning, danger is danger, the rest neutral. */
export function StateBadge({ tone, children, className, title }: { tone?: "live" | "needs" | "danger"; children: ReactNode; className?: string; title?: string }) {
  return (
    <Badge tone={tone === "live" ? "info" : tone === "needs" ? "warning" : tone === "danger" ? "danger" : "neutral"} className={className} title={title}>
      {children}
    </Badge>
  );
}

/** shadcn's Input on the kit's text field (32 tall, radius 8, a ring); a mono field keeps its mono. */
export function Input({ className, ...rest }: Omit<ComponentProps<"input">, "size" | "prefix">) {
  const mono = /\bfont-mono\b/.test(className ?? "");
  return <TextField className={["set-field", className].filter(Boolean).join(" ")} {...(mono ? { inputClassName: "font-mono" } : {})} {...rest} />;
}

export { KitKbd as Kbd };

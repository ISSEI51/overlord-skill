import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("mb-3", className)}>
      <div className="mb-1 block text-[11px] tracking-[0.04em] text-faint">{label}</div>
      {children}
    </div>
  );
}

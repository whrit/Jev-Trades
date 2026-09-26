import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Header strip shared by every terminal panel. */
export function PanelHeader({
  title,
  children,
  className,
}: {
  title: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-8 shrink-0 items-center justify-between gap-2 border-b px-3",
        className,
      )}
    >
      <h2 className="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      {children}
    </div>
  );
}

export function Empty({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      className={cn("px-3 py-6 text-center text-muted-foreground", className)}
      {...props}
    />
  );
}

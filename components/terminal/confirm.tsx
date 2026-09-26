"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

export type ConfirmOptions = {
  title: string;
  /** Key/value facts the user is agreeing to; rendered as a compact table. */
  rows?: [string, ReactNode][];
  /** Risk notes shown under the facts. */
  notes?: string[];
  action: string;
  tone?: "default" | "buy" | "sell" | "danger";
};

const ConfirmContext = createContext<
  (options: ConfirmOptions) => Promise<boolean>
>(() => Promise.resolve(false));

/** Promise-based replacement for window.confirm, rendered as an AlertDialog. */
export const useConfirm = () => useContext(ConfirmContext);

const toneClass = {
  default: "",
  buy: "bg-up text-background hover:bg-up/85",
  sell: "bg-down text-background hover:bg-down/85",
  danger: "bg-down text-background hover:bg-down/85",
};

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((next: ConfirmOptions) => {
    resolver.current?.(false);
    setOptions(next);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOptions(null);
  };

  return (
    <ConfirmContext value={confirm}>
      {children}
      <AlertDialog
        open={options !== null}
        onOpenChange={(open) => {
          if (!open) settle(false);
        }}
      >
        {options && (
          <AlertDialogContent className="sm:max-w-md">
            <AlertDialogHeader>
              <AlertDialogTitle>{options.title}</AlertDialogTitle>
              <AlertDialogDescription className="sr-only">
                Review the details before confirming.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {!!options.rows?.length && (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border bg-background/60 p-2.5 text-xs">
                {options.rows.map(([label, value]) => (
                  <div key={label} className="contents">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="text-right font-mono break-all">{value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {options.notes?.map((note) => (
              <p
                key={note}
                className="text-xs leading-relaxed text-muted-foreground"
              >
                {note}
              </p>
            ))}
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className={cn(toneClass[options.tone ?? "default"])}
                onClick={() => settle(true)}
              >
                {options.action}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </ConfirmContext>
  );
}

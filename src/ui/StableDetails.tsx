import { useEffect, useState, type ReactNode } from "react";

// Activity is deliberately not an input: only the reader controls disclosure.
export function StableDetails({ storageKey, className, revealKey = "", children }: {
  storageKey: string; className: string; revealKey?: string; children: ReactNode;
}) {
  const [open, setOpen] = useState(() => {
    try { return Boolean(revealKey) || localStorage.getItem(storageKey) === "open"; }
    catch { return Boolean(revealKey); }
  });
  useEffect(() => { if (revealKey) setOpen(true); }, [revealKey]);
  useEffect(() => {
    try { localStorage.setItem(storageKey, open ? "open" : "closed"); } catch { /* Optional view preference. */ }
  }, [open, storageKey]);
  return <details className={className} open={open} onToggle={event => {
    if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
  }}>{children}</details>;
}

import { useEffect, useRef, type ReactNode } from "react";
import { readingReceipt } from "../core/conversation-attention.js";

export function ReadMessage({ messageKey, unread, onRead, children }: { messageKey: string; unread: boolean; onRead?: (keys: string[]) => void; children: ReactNode }) {
  const end = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!unread || !onRead || !end.current || typeof IntersectionObserver === "undefined") return;
    let visible = false;
    const receipt = readingReceipt(() => onRead([messageKey]), action => { const timer = setTimeout(action, 700); return () => clearTimeout(timer); });
    const check = () => receipt.update(visible, document.visibilityState === "visible" && document.hasFocus());
    const observer = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting === true; check(); });
    observer.observe(end.current);
    window.addEventListener("focus", check); window.addEventListener("blur", check); document.addEventListener("visibilitychange", check);
    return () => { receipt.dispose(); observer.disconnect(); window.removeEventListener("focus", check); window.removeEventListener("blur", check); document.removeEventListener("visibilitychange", check); };
  }, [messageKey, unread, onRead]);
  return <>{children}<span className="message-read-sentinel" ref={end} aria-hidden="true" /></>;
}

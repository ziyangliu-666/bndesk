import { useEffect, useId, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { Drawer, UnstyledButton } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import type { NavState } from "../../store";

/**
 * A bottom sheet for short, supplementary things: a definition, a picker, a quick look at one record.
 * Closes on the overlay, Escape, the close button, a drag down on the grab handle (or on the body when it is
 * scrolled to the top), and the phone's back (opening pushes a history entry). Don't open a sheet from a
 * sheet; the one exception is the definition sheet (`above`), which opens over any other and back returns
 * to the one below.
 */
export function Sheet({
  opened,
  onClose,
  title,
  above,
  children,
}: {
  opened: boolean;
  onClose: () => void;
  title?: ReactNode;
  above?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const close = useRef(onClose);
  close.current = onClose;
  const open = useRef(opened);
  open.current = opened;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => void (mounted.current = false);
  }, []);

  // back closes the sheet: its own entry while open, dropped again when it closes some other way
  useEffect(() => {
    if (!opened) return;
    if ((history.state as NavState)?.sheet !== id) history.pushState({ ...(history.state ?? {}), sheet: id }, "", location.href);
    // a back that closed the sheet over this one lands on this one's entry: stay open
    const onPop = () => (history.state as NavState)?.sheet !== id && close.current();
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      // deferred: StrictMode re-runs this effect at once, and a page opened from the sheet replaced the entry
      setTimeout(() => {
        if (!(mounted.current && open.current) && (history.state as NavState)?.sheet === id) history.back();
      });
    };
  }, [opened, id]);

  const content = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; t: number; dy: number } | null>(null);
  const move = (dy: number, animate: boolean) => {
    const el = content.current;
    if (!el) return;
    el.style.transition = animate ? "transform 160ms cubic-bezier(0.2, 0.8, 0.2, 1)" : "none";
    el.style.transform = dy > 0 ? `translateY(${dy}px)` : "";
  };
  const onDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, t: e.timeStamp, dy: 0 };
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    d.dy = Math.max(0, e.clientY - d.y);
    move(d.dy, false);
  };
  const onUp = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const v = d.dy / Math.max(1, e.timeStamp - d.t); // px per ms
    if (d.dy > 80 || (d.dy > 16 && v > 0.5)) onClose();
    else move(0, true);
  };

  // the body drags the sheet down too, from the top of its scroll: touch events, so the pull can be told
  // from a scroll before the browser takes it
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!el) return;
    let from: { x: number; y: number; t: number } | null = null;
    let mode: "drag" | "scroll" | null = null;
    let dy = 0;
    const start = (e: TouchEvent) => {
      const t = e.touches[0];
      from = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY, t: e.timeStamp } : null;
      mode = null;
      dy = 0;
    };
    const moveT = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!from || !t) return;
      const dx = t.clientX - from.x;
      const d = t.clientY - from.y;
      if (mode == null) {
        if (Math.abs(d) < 6 && Math.abs(dx) < 6) return;
        mode = d > 0 && Math.abs(d) > Math.abs(dx) && el.scrollTop <= 0 ? "drag" : "scroll";
        if (mode === "drag") {
          from = { ...from, y: t.clientY, t: e.timeStamp };
          el.classList.add("dragging");
        }
      }
      if (mode !== "drag") return;
      e.preventDefault();
      dy = Math.max(0, t.clientY - from.y);
      move(dy, false);
    };
    const end = (e: TouchEvent) => {
      const f = from;
      from = null;
      if (mode !== "drag" || !f) return;
      el.classList.remove("dragging");
      const v = dy / Math.max(1, e.timeStamp - f.t);
      if (dy > 80 || (dy > 16 && v > 0.5)) close.current();
      else move(0, true);
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", moveT, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", moveT);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el]);

  return (
    <Drawer.Root
      zIndex={above ? 310 : undefined}
      opened={opened}
      onClose={onClose}
      position="bottom"
      size="auto"
      transitionProps={{ transition: "slide-up", duration: 160, timingFunction: "cubic-bezier(0.2, 0.8, 0.2, 1)" }}
      removeScrollProps={{ allowPinchZoom: true }}
      onExitTransitionEnd={() => move(0, false)}
      classNames={{ content: "m-sheet", overlay: "m-sheet-overlay" }}
    >
      <Drawer.Overlay backgroundOpacity={0.6} />
      <Drawer.Content ref={content} radius={0}>
        <div className="m-sheet-grip" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <div className="m-sheet-head">
            {title != null && <h2 className="m-sheet-title">{title}</h2>}
            <UnstyledButton className="m-sheet-close" onClick={onClose} aria-label="Close" ml="auto">
              <IconX size={18} stroke={2} />
            </UnstyledButton>
          </div>
        </div>
        <div className="m-sheet-body" ref={setEl}>
          {children}
        </div>
      </Drawer.Content>
    </Drawer.Root>
  );
}

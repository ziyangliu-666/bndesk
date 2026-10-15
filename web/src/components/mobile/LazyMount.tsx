import type { ReactNode } from "react";
import { useInView } from "../../hooks";

/** Mounts its children once scrolled within `margin` of the screen; until then a placeholder of `height`
 *  keeps the page length. For charts below the fold. */
export function LazyMount({ height, margin, children }: { height: number | string; margin?: string; children: ReactNode }) {
  const [ref, seen] = useInView<HTMLDivElement>(margin);
  return (
    <div ref={ref} style={seen ? undefined : { minHeight: height }}>
      {seen ? children : null}
    </div>
  );
}

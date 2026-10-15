// Breakpoints. A phone gets its own shell and pages; tablets and desktops share the desktop tree.
//
// By design, any viewport under 48em (768 px) wide gets the phone layout, whatever the device: that includes an
// iPad mini held upright (744 px), a split-screen tablet app and a narrow desktop window. The desktop's grids
// need ~1000 px and its pages do not fold below 768 px; the phone pages read well up to ~760 px (landscape
// phones cap their column, shell.css). Wider tablets (iPad 820 px and up, portrait) get the desktop tree.

const NARROW_Q = "(max-width: 47.99em)";
const COARSE_Q = "(pointer: coarse)";
/** A touch screen whose short side is under 30em is a phone, however it is held. */
const PHONE_SCREEN = 480;

/** Phone: narrower than Mantine's sm (48em), or a touch screen whose short side is under 30em, held either way
 *  (landscape phones are ~850 px wide). The sideways test reads the screen, not the viewport: an on-screen
 *  keyboard shrinks a landscape tablet's viewport to phone height. Mirrored in mobile.css as `html.is-phone`.
 *  `PHONE_WATCH`: the media queries whose changes can flip the answer (useIsMobile listens to them). */
export const PHONE_WATCH = [NARROW_Q, COARSE_Q];

export function isPhoneNow(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia(NARROW_Q).matches) return true;
  return window.matchMedia(COARSE_Q).matches && Math.min(screen.width, screen.height) <= PHONE_SCREEN;
}

let phoneLayout = isPhoneNow();
/** The layout the app mounted (set by useIsMobile); navigation follows it. */
export const isPhoneLayout = () => phoneLayout;
export const setPhoneLayout = (v: boolean) => void (phoneLayout = v);

/** A focused text field: on a touch screen the keyboard is probably up. */
export const TEXT_FIELD = "input:not([type=checkbox]):not([type=radio]):not([type=button]), textarea, select, [contenteditable]";
export const typingNow = () => {
  const a = typeof document !== "undefined" ? document.activeElement : null;
  return a instanceof HTMLElement && a.matches(TEXT_FIELD);
};

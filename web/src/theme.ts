import { createTheme, type MantineColorsTuple } from "@mantine/core";

export const C = {
  ground: "#000000",
  panel: "#07090c",
  raised: "#12161d",
  rule: "#20262f",
  ink: "#f5f7fa",
  ink2: "#c3cad5",
  muted: "#8a94a5",
  up: "#3ed6a2",
  down: "#ff6a5c",
  warn: "#e3a53b",
  crit: "#f05252",
  accent: "#7ea6f6",
} as const;

// Categorical series slots, validated with the dataviz palette validator
// (dark mode, surface #07090c, all pairs): blue, orange, aqua.
export const SERIES = ["#3987e5", "#d95926", "#199e70"] as const;
export const S1 = SERIES[0];
export const S2 = SERIES[1];
export const S3 = SERIES[2];

// One line per account (at most six), in this order. No green, red or amber (those mean gain, loss and warn), and
// no blue (the market-making line): mauves, violets, a grey teal. Picked for the widest worst-case separation
// (OKLab ΔE×100, normal / protanopia / deuteranopia, Machado 2009): 13.4 over the first four, 12.1 over all six.
// Lines this close carry their name: with three or more the chart labels each line (legend) and they keep it.
export const ACCOUNT_SERIES = ["#9980ee", "#e9cada", "#7fa3a6", "#846876", "#8654bc", "#c4a9fe"] as const;

export const SANS = `"IBM Plex Sans", system-ui, sans-serif`;

const slate: MantineColorsTuple = [
  C.ink,
  "#c7ced9",
  C.ink2,
  "#8893a5",
  C.muted,
  C.rule,
  C.raised,
  C.panel,
  C.ground,
  "#000000",
];
const accent: MantineColorsTuple = [
  "#eaf0fe",
  "#d3e0fd",
  "#b6cbfb",
  "#9ab8f8",
  C.accent,
  "#6a93e8",
  "#5680d6",
  "#456dc0",
  "#375aa3",
  "#2b4885",
];

export const theme = createTheme({
  fontFamily: SANS,
  fontFamilyMonospace: SANS,
  primaryColor: "accent",
  colors: { dark: slate, accent },
  defaultRadius: 3,
  fontSizes: { xs: "12px", sm: "12px", md: "14px", lg: "14px", xl: "20px" },
  headings: { fontFamily: SANS },
  cursorType: "pointer",
});

// The P&L split, one palette for every chart and size (desktop and phone): Day PnL is the area coloured by its
// sign (up / down); Trading (market making + inventory PnL) is the ink line; its parts and the rest each have a
// hue and a stroke of their own, so colour is never the only cue. No amber (warn), no green or red (gain / loss).
// Worst pair among the five parts, OKLab ΔE×100 under normal vision, protanopia and deuteranopia: 14.1
// (fix3.md has every pair). The same hue keeps its meaning on the neighbouring views: the inventory violet is the
// spot inventory on Exposure and History, the hedge teal is the futures notional.
export const PNL_COLORS = {
  trading: C.ink,
  mm: "#426ec2",
  inv: "#a8a6fb",
  hedge: "#5f97a0",
  reb: "#c9d2de",
  other: "#636363",
} as const;
export type Stroke = "solid" | "dashed" | "dotted" | "large" | "sparse";
export const PNL_STROKES: Record<keyof typeof PNL_COLORS, Stroke> = {
  trading: "solid",
  mm: "solid",
  inv: "large",
  hedge: "dashed",
  reb: "sparse",
  other: "dotted",
};
/** Spot inventory (value or quantity): the inventory hue. */
export const INV_COLOR = PNL_COLORS.inv;
/** Futures notional: the hedge hue. */
export const FUT_COLOR = PNL_COLORS.hedge;

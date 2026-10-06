import { createTheme, type MantineColorsTuple } from "@mantine/core";
import { themeQuartz } from "ag-grid-community";

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

// One line per account (at most six), in this order: the dataviz reference palette's dark steps, validated
// with scripts/validate_palette.js --mode dark --surface "#07090c" (adjacent pairs: worst CVD ΔE 8.4,
// normal-vision 19.3, all >= 3:1). With four or more lines the chart labels each line at its end.
export const ACCOUNT_SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300"] as const;

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
  fontSizes: { xs: "11px", sm: "12px", md: "13px", lg: "15px", xl: "18px" },
  headings: { fontFamily: SANS },
  cursorType: "pointer",
});

export const gridTheme = themeQuartz.withParams({
  backgroundColor: C.panel,
  foregroundColor: C.ink,
  headerBackgroundColor: C.panel,
  headerTextColor: C.ink2,
  headerFontWeight: 500,
  headerFontSize: 11,
  borderColor: C.rule,
  rowBorder: { color: "#11151b", width: 1, style: "solid" },
  columnBorder: false,
  headerColumnBorder: false,
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  borderRadius: 2,
  oddRowBackgroundColor: C.panel,
  rowHoverColor: "rgba(126,166,246,0.07)",
  selectedRowBackgroundColor: "rgba(126,166,246,0.16)",
  accentColor: C.accent,
  fontFamily: SANS,
  fontSize: 12,
  rowHeight: 24,
  headerHeight: 26,
  spacing: 4,
  cellHorizontalPadding: 6,
  iconSize: 11,
  pinnedRowBorder: { color: C.rule, width: 1, style: "solid" },
  cellTextColor: C.ink,
  inputBackgroundColor: C.ground,
  inputBorder: { color: C.rule },
  chromeBackgroundColor: C.panel,
  valueChangeValueHighlightBackgroundColor: "rgba(126,166,246,0.18)",
  pinnedRowBackgroundColor: C.raised,
  pinnedRowFontWeight: 600,
  headerCellHoverBackgroundColor: C.raised,
  rangeSelectionBorderColor: "transparent",
  headerColumnResizeHandleColor: C.rule,
});

// The real-money split: market making and the inventory PnL, the same colours on every chart.
export const MM_COLOR = S3;
export const INVPNL_COLOR = "#a47ef0";
export const HEDGE_COLOR = "#9aa3b2";
export const INV_COLOR = "#c98500";
export const FUT_COLOR = "#d55181";

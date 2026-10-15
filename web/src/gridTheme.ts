import { themeQuartz } from "ag-grid-community";
import { C, SANS } from "./theme";

// Apart from theme.ts, so pages without grids (the phone ones) do not load AG Grid for a colour.
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

/** Phones: finger-sized rows and readable type. */
export const gridThemePhone = gridTheme.withParams({
  rowHeight: 34,
  headerHeight: 32,
  fontSize: 13,
  headerFontSize: 12,
  cellHorizontalPadding: 8,
});

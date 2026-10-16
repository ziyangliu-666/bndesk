// The exchange-style building blocks (README.md here): one chart wrapper, its data helpers, and small
// presentational controls in bndesk's palette.
export {
  ExChart,
  volumePoints,
  closePoints,
  candlePoints,
  type ExChartProps,
  type ExSeries,
  type ExKind,
  type ExPoint,
  type ExOhlc,
  type ExMarker,
  type ExPriceLine,
  type ExLegendItem,
  type ExMode,
  type ExValue,
  type ExBoxRow,
} from "./ExChart";
export { ChartFullscreen, goFullscreen, useLandscapeFullscreen } from "./fullscreen";
export { Tabs, TextToggle, ChipRow, TickerStrip, TvAttribution, type Option, type Chip, type TickerItem, type Tone } from "./controls";
export { StatusFooter } from "./StatusFooter";
export { useKlines, barStart, aggregate, INTERVAL_MS, type Candle, type KInterval, type KlinesState, type KlineSource } from "./klines";
export { fillsByBar, fillMarkers, fillsText, fillsShort, type BarFills, type FillLike } from "./fills";
export { useExPref, useExHidden } from "./prefs";
export { UP, DOWN, rgba, signColor } from "./palette";

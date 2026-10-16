# ex/: exchange-style building blocks

Exchange layout, controls and chart grammar in bndesk's own pure-black palette (`theme.ts`). Import from
`components/ex` (the barrel `index.ts`). To try them, run the dev server and open `/ex-playground.html`
(`VITE_MOCK=1 npx vite`). It is a dev-only page: `vite build` only builds `index.html`.

## ExChart

Use one `ExChart` for every time-series chart, on desktop and phone. Its data goes in with each series,
and every time is in ms.

```tsx
const [iv, setIv] = useExPref("inst", "interval", "5m", ["line", "1m", "5m", "15m", "1h"]);
const k = useKlines(symbol, venue, iv === "line" ? "1m" : (iv as KInterval));
const byBar = useMemo(() => fillsByBar(fills, iv), [fills, iv]);

<ExChart
  id="inst"                                  // remembers hidden series + legend collapse
  series={[
    { key: "k", kind: "candles", label: symbol, data: k.bars, toggle: false },
    { key: "vol", kind: "histogram", label: "Vol(USDT)", pane: 1, data: volumePoints(k.bars, true), format: compact },
  ]}
  paneStretch={[1, 0.22]}
  intervals={[{ value: "line", label: "Line" }, { value: "1m", label: "1m" }, ...]}
  moreIntervals={[{ value: "4h", label: "4H" }, ...]}   // behind "More ▾" (phone)
  interval={iv} onInterval={setIv}
  modes={[{ label: "Range", value: r, onChange: setR, options: [{ value: "today", label: "Today" }, { value: "24h", label: "24h" }] }]}
  loading={k.loading} emptyText={k.error ?? undefined}
  height={360} initialBars={120} resetKey={symbol}
  fullscreen title={symbol}
  markers={fillMarkers(byBar, "k")}
  priceLines={[{ series: "k", key: "avg", price: avgCost, color: C.muted, title: "Avg cost", style: "large" }]}
  legendExtra={[{ key: "fills", label: "Fills", value: (t) => fillsText(byBar.get(t)), box: (t) => fillsShort(byBar.get(t)) }]}
  chips={[{ key: "fills", label: "Fills", color: UP }, { key: "avg", label: "Avg cost" }, "|", { key: "vol", label: "Vol" }]}
/>
```

- **Series** (`ExSeries`): `kind` is `line | area | baseline | histogram | candles`. Each series also takes
  `label`, `color` (`colors` [up, down] for baseline and candles), `pane`, `format` (used by the axis and
  the legend), `signColor`, `legend` (line number, or `false`), `toggle`, `hiddenByDefault`, `width`,
  `lineStyle`, `base` (baseline), `lastValue` (the axis tag; the default puts one on the first
  non-histogram series of each pane), `scale` (an overlay scale id), `margins` and `options` (raw lwc
  options).
- **Live data**: when you append or replace the last point and keep the earlier points as the same objects,
  ExChart calls `update()` on the tail. Otherwise it calls `setData`. `useKlines`, `volumePoints` and
  `closePoints` all keep earlier objects.
- **Legend**: the legend sits in the plot at the top left of each pane. Each item is a grey label with the
  value in the series colour. At rest it shows the latest bar; while hovering or tracking it shows the
  crosshair bar. Candles get O/H/L/C, plus Chg% and Range on desktop. A P&L candle series (one with a
  custom `format`) gets Chg in its own unit instead. On pane 0, a chevron folds lines 2 and up. Clicking an
  item toggles its key.
- **Hidden keys**: series and overlays share one set of hidden keys, `"vol"`, `"fills"`, `"quotes"` and so
  on. Markers and price lines with a `key` hide with it. The set is stored per `id` in the store
  (`hidden["ex.<id>"]`), or you can control it with `hidden` and `onToggle`. `useExHidden(id)` gives a
  separate `ChipRow` the same state. A pane whose series are all hidden folds away.
- **Interval change**: the old bars go at once, and the plot shows only the frame with a small "Loading"
  text. ExChart does this by itself when `interval` changes but `data` does not. `loading` forces it. The
  view resets when the new data arrives, when `resetKey` changes, or (on new data) with `initialBars`.
- **Gestures**: on desktop the crosshair follows hover, dragging pans and the wheel zooms. On touch
  (`touch`, which defaults to a coarse pointer), a long press starts tracking, which ends on the next tap. A
  value box then shows on the side away from the finger: the default rows come from the series, or you can
  pass `boxRows(t)` (for example `Time / Day PnL / MM / Inv / Hedge / Reb`). A horizontal drag pans, a pinch
  zooms, and a vertical swipe scrolls the page.
- **Chrome**: the right axis only, horizontal grid lines, and a `»` button that brings back the latest bar
  when the view is panned away. The TradingView logo is off: put `<TvAttribution/>` (already in
  `StatusFooter`) or an About link somewhere on every page.
- **Markers**: `fillMarkers` gives at most one small circle per bar per side, at our VWAP for that bar, with
  no text. All markers hide while bars are under 5 px apart. The legend and the box carry the figures
  (`B3 @ 2,480.64 · S1 @ 2,481.55`).
- **Fullscreen**: with `fullscreen` (true), ⤢ opens `ChartFullscreen` with a copy of the chart. The overlay
  fills the viewport in any orientation and closes with ✕, Back or Escape. On Android it also enters the
  browser fullscreen and locks to landscape. Pass a function to handle ⤢ yourself.
  `useLandscapeFullscreen(open, visible)` opens it when the phone turns sideways. Your own open handler must
  call `goFullscreen()` inside the click.
- **Chips**: `chips` set to `true` gives one chip per toggleable series. You can also pass your own list,
  with `"|"` for a divider.
- **Escape hatch**: `chartRef` hands you the `IChartApi`, and `onCrosshair(t)` reports the hovered bar's
  time.

Chart heights follow the spec. The phone's inline plot is 260 to 300 px plus about 64 px of volume, the
instrument plot about 360 + 80 px, and fullscreen takes everything (use `fill` in a flex column).

## Klines

`useKlines(symbol, venue, interval, { bars = 500, stream = true })` returns `{ bars, loading, error, live }`:

- History comes from `/api/klines`. In mock mode, `historyMock` generates bars around the instrument's mid.
- `30m` and `1w` come from the server too. When an older server answers 400, they are built here from `15m`
  and `1d`. Weeks start on Monday 00:00 UTC.
- The forming candle follows Binance's public `<sym>@kline_<i>` stream: spot on `stream.binance.com:9443/ws`,
  USD-M on `fstream.binance.com/market/ws`. When that stream is quiet, it falls back to the store's mid for
  the instrument, which it reads at most four times a second.
- A change of symbol or interval empties `bars` at once.

Helpers: `barStart(ms, interval)`, `aggregate(bars, interval)` and `INTERVAL_MS`.

## Controls (presentational)

- `Tabs`: text tabs. The active tab is ink with a short accent underline. Tabs take an optional `count`,
  and `right` places content at the right end of the row.
- `TextToggle`: interval and mode toggles. The active one is ink, the rest are muted. `{ value: "|" }` draws
  a divider.
- `ChipRow`: the flat, segmented chip row under a chart.
- `TickerStrip`: an optional `lead` slot for the big value, then pairs with a 12 px muted label over a
  12 px value (`size="md"` makes the value 14 px). `"|"` starts a new group, and `title` puts a dotted
  definition on a label.
- `StatusFooter`: the 28 px desktop footer. It shows `● Live / Stale / Disconnected`, feeds n/n, the session
  countdown, the clock, a UTC | Local toggle, a marquee of each instrument's trading P&L (`onInstrument` is
  called on click), and "Charts by TradingView".
- `useExPref(id, name, default, allowed?)` remembers a chart's interval or mode in localStorage.

## Format

`format.compact(v, d = 2, sign = false)` writes large aggregates with an uppercase suffix: `9.50K`,
`267.20M`, `1.23B`. Existing callers of `usd` and `usdShort` keep their lowercase `k` and `m` until their
page is redone.

## 24h ticker

`useTicker24h(symbol, venue)` returns Binance's rolling 24 h stats (`last open high low volume quoteVolume
change changePct t`) or null until the first message. The data comes from the public `<sym>@miniTicker` stream:
one combined-stream socket per venue (`stream.binance.com:9443/stream`, USD-M `fstream.binance.com/market/stream`)
serves every subscriber, and instruments are added and dropped with SUBSCRIBE and UNSUBSCRIBE. For a list, use
`useTickers24h(list)`, which returns a Map keyed by `tickerKey(symbol, venue)`. Outside React, use
`watchTicker24h`. In mock mode the stats come from `historyMock.mockTicker24h`.

## Fullscreen route

An ExChart with an `id` opens its fullscreen through the store (`openChart(id)`, `#/chart/<id>`). Back closes it,
and a reload brings it back over the page it was opened from.

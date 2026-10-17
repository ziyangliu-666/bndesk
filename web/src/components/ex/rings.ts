// Our fills on a kline chart as hollow rings: a coloured ring (buy up, sell down) around a black centre, with a
// dark halo so it reads on a candle of either colour, smaller than a candle body. A buy sits a little left of
// the bar's centre and a sell a little right, so the two never overlap into crescents. Lightweight Charts'
// own circle markers are filled discs, hence this small series primitive.
import type { IChartApi, IPrimitivePaneRenderer, ISeriesApi, ISeriesPrimitive, IPrimitivePaneView, SeriesAttachedParameter, SeriesType, Time, UTCTimestamp } from "lightweight-charts";
import { PLOT_BG } from "./palette";

type CanvasRenderingTarget2D = Parameters<IPrimitivePaneRenderer["draw"]>[0];

export interface Ring {
  /** Bar time, seconds. */
  time: UTCTimestamp;
  price: number;
  color: string;
  /** −1: left of the bar's centre (a buy), +1: right (a sell), 0: centred. */
  side: -1 | 0 | 1;
}

export class FillRings implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private update: (() => void) | null = null;
  private rings: Ring[] = [];
  private readonly views: readonly IPrimitivePaneView[];

  constructor() {
    this.views = [{ zOrder: () => "top", renderer: () => ({ draw: (t: CanvasRenderingTarget2D) => this.draw(t) }) }];
  }

  attached(p: SeriesAttachedParameter<Time, SeriesType>) {
    this.chart = p.chart as unknown as IChartApi;
    this.series = p.series as ISeriesApi<SeriesType>;
    this.update = p.requestUpdate;
  }

  detached() {
    this.chart = null;
    this.series = null;
    this.update = null;
  }

  set(rings: Ring[]) {
    this.rings = rings;
    this.update?.();
  }

  paneViews() {
    return this.views;
  }

  private draw(target: CanvasRenderingTarget2D) {
    const c = this.chart;
    const s = this.series;
    if (!c || !s || !this.rings.length) return;
    const ts = c.timeScale();
    const range = ts.getVisibleLogicalRange();
    const spacing = range ? ts.width() / Math.max(1, range.to - range.from) : 6;
    // under a candle body's half width (lightweight-charts draws bodies about 0.8 of the spacing)
    const r = Math.max(2, Math.min(4.5, spacing * 0.22));
    const dx = r + 0.75;
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      const pr = Math.max(hr, vr);
      for (const g of this.rings) {
        const x = ts.timeToCoordinate(g.time);
        const y = s.priceToCoordinate(g.price);
        if (x == null || y == null) continue;
        const cx = (x + g.side * dx) * hr;
        const cy = y * vr;
        ctx.beginPath();
        ctx.arc(cx, cy, r * pr, 0, Math.PI * 2);
        ctx.fillStyle = PLOT_BG;
        ctx.fill();
        // the halo: a dark ring outside the coloured one keeps it apart from a candle of its own colour
        ctx.lineWidth = 3 * pr;
        ctx.strokeStyle = "rgba(0,0,0,0.85)";
        ctx.stroke();
        ctx.lineWidth = 1.5 * pr;
        ctx.strokeStyle = g.color;
        ctx.stroke();
      }
    });
  }
}

// The tags each price axis canvas showed last, as [from, to] spans in its media px; the build's patch of
// Lightweight Charts' tick loop (vite.config.ts lwc-axis-tags) skips a tick label that would fall under one.
const spansOf = new WeakMap<HTMLCanvasElement, [number, number][]>();
/** A tick label is about 12 px tall: one whose middle is this close to a tag's edge would show cut. */
const LABEL_HALF = 7;
(globalThis as { __lwcSkipTick?: (c: HTMLCanvasElement, y: number) => boolean }).__lwcSkipTick = (c, y) => {
  const sp = spansOf.get(c);
  if (!sp) return false;
  for (const [a, b] of sp) if (y > a - LABEL_HALF && y < b + LABEL_HALF) return true;
  return false;
};

/** A price tag's height on the axis at the charts' 11 px font, px. */
const TAG_H = 17;

/**
 * Keeps the price axis' tick labels out from under its tags (a series' last value, a price line's label), so
 * none shows half covered (`+2̶0̶.00`): it tells the patched tick loop where the tags are. Lightweight Charts
 * draws a primitive's price-axis view after the tick labels and before the tags; a change of the tags redraws
 * once more so the labels follow at once. `tags()` gives the prices.
 */
export class AxisGuard implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<SeriesType> | null = null;
  private update: (() => void) | null = null;
  private last = "";
  private readonly views: readonly IPrimitivePaneView[];

  constructor(private readonly tags: () => number[]) {
    this.views = [{ zOrder: () => "normal", renderer: () => ({ draw: (t: CanvasRenderingTarget2D) => this.draw(t) }) }];
  }

  attached(p: SeriesAttachedParameter<Time, SeriesType>) {
    this.series = p.series as ISeriesApi<SeriesType>;
    this.update = p.requestUpdate;
  }

  detached() {
    this.series = null;
    this.update = null;
  }

  priceAxisPaneViews() {
    return this.views;
  }

  private draw(target: CanvasRenderingTarget2D) {
    const s = this.series;
    if (!s) return;
    const ys: number[] = [];
    for (const p of this.tags()) {
      const y = s.priceToCoordinate(p);
      if (y != null) ys.push(y);
    }
    // tags closer than a tag's height are pushed apart by the library (a stack around their middle): a stack's
    // whole height
    ys.sort((a, b) => a - b);
    const spans: [number, number][] = [];
    if (ys.length) {
      let run = [ys[0]!];
      const flush = () => {
        const mid = (run[0]! + run[run.length - 1]!) / 2;
        const half = Math.max((run[run.length - 1]! - run[0]!) / 2, (run.length * TAG_H) / 2);
        spans.push([mid - half, mid + half]);
      };
      for (let i = 1; i < ys.length; i++) {
        if (ys[i]! - ys[i - 1]! < TAG_H) run.push(ys[i]!);
        else {
          flush();
          run = [ys[i]!];
        }
      }
      flush();
    }
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      spansOf.set(ctx.canvas, spans);
    });
    const key = spans.map(([a, b]) => `${Math.round(a)}:${Math.round(b)}`).join(",");
    if (key !== this.last) {
      this.last = key;
      this.update?.();
    }
  }
}

/**
 * A faint vertical rule at each day start (`times`, seconds): where a chart that runs over several days restarts
 * its day figures, so the drop back to 0 reads as a new day. Drawn on the boundary before the day's first bar.
 */
export class DayDividers implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private update: (() => void) | null = null;
  private times: UTCTimestamp[] = [];
  private readonly views: readonly IPrimitivePaneView[];

  constructor(private readonly color: string) {
    this.views = [{ zOrder: () => "bottom", renderer: () => ({ draw: (t: CanvasRenderingTarget2D) => this.draw(t) }) }];
  }

  attached(p: SeriesAttachedParameter<Time, SeriesType>) {
    this.chart = p.chart as unknown as IChartApi;
    this.update = p.requestUpdate;
  }

  detached() {
    this.chart = null;
    this.update = null;
  }

  set(times: UTCTimestamp[]) {
    if (times.length === this.times.length && times.every((t, i) => t === this.times[i])) return;
    this.times = times;
    this.update?.();
  }

  paneViews() {
    return this.views;
  }

  private draw(target: CanvasRenderingTarget2D) {
    const c = this.chart;
    if (!c || !this.times.length) return;
    const ts = c.timeScale();
    const range = ts.getVisibleLogicalRange();
    const half = range ? ts.width() / Math.max(1, range.to - range.from) / 2 : 0;
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, bitmapSize }) => {
      ctx.fillStyle = this.color;
      const w = Math.max(1, Math.floor(hr));
      for (const t of this.times) {
        const x = ts.timeToCoordinate(t);
        if (x == null) continue;
        ctx.fillRect(Math.round((x - half) * hr), 0, w, bitmapSize.height);
      }
    });
  }
}

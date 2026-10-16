import { useStore } from "../../store";
import { useNow } from "../../hooks";
import { int } from "../../format";
import { KV, Section, Tag } from "../../components/mobile";
import type { Alert, Engine, Feed } from "../../protocol";
import { EngineFacts, EngineState, feedState, feedSummary, FeedRow, KillBar, LatencyTable, useRejectSpike, type FeedState } from "./shared";
import "./ops.css";
import "./rest/ops.css";
import { useExPref } from "../../components/ex";
import { Empty, PageTabs } from "./rest/ui";

const OK = ["up", "running", "live", "ok", "connected"];
const ORDER: Record<FeedState, number> = { down: 0, flapping: 1, silent: 2, up: 3 };

/** The market word of an engine venue ("binance usdm" -> "usdm"), to find the monitor's feeds of that market. */
const marketOf = (venue: string) => venue.trim().split(/\s+/).pop()!.toLowerCase();
const nameHas = (name: string, word: string) => name.toLowerCase().split(/\s+/).includes(word);

/**
 * A venue connection of the engine: its streams' state, then its error counters. "all up" only when the
 * engine's own connections are up and the monitor's feeds of the same market (classified as in Feeds above)
 * are too: a flapping user stream of that market is said here as well.
 */
function VenueBlock({ v, feeds, now, alerts }: { v: Engine["venues"][number]; feeds: Feed[]; now: number; alerts?: Alert[] }) {
  const states = (
    [
      ["market data", v.md],
      ["user", v.user],
      ["order", v.order],
    ] as const
  ).filter(([, s]) => s !== "n/a");
  const bad = states.filter(([, s]) => !OK.includes(s.toLowerCase())).map(([k, s]) => `${k} ${s}`);
  // the monitor's own feeds of this market, for the kinds this engine connection uses
  const market = marketOf(v.name);
  const kinds = new Set<Feed["kind"]>([...(v.md !== "n/a" ? ["public" as const] : []), ...(v.user !== "n/a" ? ["user" as const] : [])]);
  let worst: "warn" | "crit" | undefined = bad.length ? "crit" : undefined;
  for (const f of feeds) {
    if (!kinds.has(f.kind) || !nameHas(f.name, market)) continue;
    const st = feedState(f, now, alerts);
    if (st === "up") continue;
    bad.push(`${f.name} ${st}`);
    if (st === "down") worst = "crit";
    else worst ??= "warn";
  }
  return (
    <KV
      cols={3}
      items={[
        {
          label: v.name,
          info:
            "The engine's connections to this venue (market data, user data and order entry), and the monitor's feeds of the " +
            "same market, classified as in Feeds.",
          value: bad.length ? bad.join(", ") : states.length ? "all up" : "n/a",
          tone: worst,
          span: 3,
        },
        { label: "Reconnects", info: "Connection re-establishments since the engine started.", value: int(v.reconnects) },
        {
          label: "Cooldowns",
          info: "Rate-limit cooldowns the engine entered.",
          value: int(v.cooldowns),
          tone: v.cooldowns ? "warn" : undefined,
        },
        { label: "REST errors", info: "REST requests that returned an error.", value: int(v.rest_errors) },
      ]}
    />
  );
}

function EngineSection({ e, feeds, now, alerts }: { e: Engine; feeds: Feed[]; now: number; alerts?: Alert[] }) {
  const spike = useRejectSpike(e.name);
  return (
    <Section
      title={
        <>
          {e.name}
          <Tag>{e.strategy}</Tag>
        </>
      }
      right={<EngineState e={e} />}
    >
      {e.kill && (
        <div className="m-ops-kill">
          Kill active{e.kill_reason ? `: ${e.kill_reason}` : ""}
        </div>
      )}
      <KillBar e={e} />
      <EngineFacts e={e} spike={spike} />
      <LatencyTable e={e} />
      {e.rejects.some((r) => r.count > 0) && (
        <div className="m-ops-tbl" role="table">
          <div className="m-ops-tr head two" role="row">
            <span role="columnheader">Rejects by reason</span>
            <span role="columnheader">since start</span>
          </div>
          {e.rejects
            .filter((r) => r.count > 0)
            .sort((a, b) => b.count - a.count)
            .map((r) => (
              <div className="m-ops-tr two" role="row" key={r.reason}>
                <span role="cell">{r.reason}</span>
                <span role="cell" className="m-fig">{int(r.count)}</span>
              </div>
            ))}
        </div>
      )}
      {e.venues.map((v) => (
        <VenueBlock key={v.name} v={v} feeds={feeds} now={now} alerts={alerts} />
      ))}
    </Section>
  );
}

/** System: Engines | Feeds. The engines with their kill state, latency, rejects and venues; the monitor's feeds
 *  with the ones that need a look first. */
export function EngineM() {
  const engines = useStore((s) => s.snap?.engines);
  const feeds = useStore((s) => s.snap?.feeds) ?? [];
  const alerts = useStore((s) => s.snap?.alerts);
  const now = useNow(1000) + useStore.getState().skew;
  const [tab, setTab] = useExPref<"engines" | "feeds">("m-system", "tab", "engines", ["engines", "feeds"]);

  const states = new Map(feeds.map((f) => [f, feedState(f, now, alerts)]));
  // down first, then flapping, then silent
  const bad = feeds.filter((f) => states.get(f) !== "up").sort((a, b) => ORDER[states.get(a)!] - ORDER[states.get(b)!]);
  const good = feeds.filter((f) => states.get(f) === "up");
  const sum = feedSummary(feeds, now, alerts);
  const running = (engines ?? []).filter((e) => e.up && !e.kill && e.state === "running").length;
  const tone = (w: string) => (w === "crit" ? "crit-text" : w === "warn" ? "warn-text" : "");

  return (
    <div className="o-page">
      <PageTabs
        items={[
          {
            value: "engines",
            label: <span className={engines && running < engines.length ? "warn-text" : ""}>Engines</span>,
            count: engines ? `${running}/${engines.length}` : null,
          },
          { value: "feeds", label: <span className={tone(sum.worst)}>Feeds</span>, count: bad.length ? `${bad.length} off` : `${feeds.length}` },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "engines" ? (
        engines?.length ? (
          engines.map((e) => <EngineSection key={e.name} e={e} feeds={feeds} now={now} alerts={alerts} />)
        ) : (
          <Empty>No engine configured.</Empty>
        )
      ) : (
        <>
          {bad.length > 0 && (
            <Section title="Need a look" right={<span className={tone(sum.worst)}>{sum.text}</span>}>
              {bad.map((f) => (
                <FeedRow key={f.name} f={f} now={now} alerts={alerts} />
              ))}
            </Section>
          )}
          <Section
            title={bad.length ? "Up" : "All up"}
            info={
              "Connections and pollers the monitor runs: public market data, each account's user data stream, the REST pollers and the engines' metrics." +
              "\n\nUp: connected, messages arriving. Silent: connected, but nothing for a while (market data for 45 s; a poller or engine metrics for 10 s). " +
              "Flapping: connected, but it keeps reconnecting (an alert says so). Down: disconnected.\n\nTap a feed for its details."
            }
            right={`${good.length} of ${feeds.length}`}
          >
            {good.map((f) => (
              <FeedRow key={f.name} f={f} now={now} alerts={alerts} />
            ))}
          </Section>
        </>
      )}
    </div>
  );
}

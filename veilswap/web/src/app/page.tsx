"use client";

import { useCallback, useEffect, useState } from "react";
import { formatEther } from "viem";
import { addresses, ammAbi } from "@/generated/contracts";
import { publicClient, RPC, RPC_IS_LOCAL } from "@/lib/chain";
import {
  fmt,
  initDemo,
  resetPool,
  runBatch,
  runExposed,
  runSealed,
  type Beat,
  type RunResult,
} from "@/lib/demo";

type Lane = "exposed" | "sealed" | "batch";

const RUNNERS: Record<Lane, () => AsyncGenerator<import("@/lib/demo").RunEvent>> = {
  exposed: runExposed,
  sealed: runSealed,
  batch: runBatch,
};

/// Repeated beats with the same id (the reveal countdown) update in place.
function upsert(list: Beat[], beat: Beat) {
  const at = list.findIndex((b) => b.id === beat.id);
  if (at === -1) return [...list, beat];
  const next = [...list];
  next[at] = beat;
  return next;
}

export default function Page() {
  const [beats, setBeats] = useState<Record<Lane, Beat[]>>({ exposed: [], sealed: [], batch: [] });
  const [results, setResults] = useState<Record<Lane, RunResult | null>>({
    exposed: null,
    sealed: null,
    batch: null,
  });
  const [running, setRunning] = useState<Lane | null>(null);
  const [unsealed, setUnsealed] = useState(false);
  const [reserves, setReserves] = useState<{ weth: bigint; meme: bigint } | null>(null);
  const [offline, setOffline] = useState(false);

  const readReserves = useCallback(async () => {
    try {
      const [weth, meme] = await Promise.all([
        publicClient.readContract({ address: addresses.amm, abi: ammAbi, functionName: "reserveWeth" }),
        publicClient.readContract({ address: addresses.amm, abi: ammAbi, functionName: "reserveMeme" }),
      ]);
      setReserves({ weth, meme });
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await readReserves();
    })();
  }, [readReserves]);

  const run = async (lane: Lane) => {
    if (running) return;
    setRunning(lane);
    setBeats((b) => ({ ...b, [lane]: [] }));
    setResults((r) => ({ ...r, [lane]: null }));
    if (lane !== "exposed") setUnsealed(false);

    try {
      await initDemo();
      await resetPool();
      const stream = RUNNERS[lane]();
      for await (const event of stream) {
        if (event.type === "beat") {
          setBeats((b) => ({ ...b, [lane]: upsert(b[lane], event.beat) }));
          if (event.beat.id === "reveal" || event.beat.id === "revealed") setUnsealed(true);
        } else {
          setResults((r) => ({ ...r, [lane]: event.result }));
        }
      }
    } catch (err) {
      console.error(err);
      setOffline(true);
    } finally {
      setRunning(null);
      readReserves();
    }
  };

  const clearBoard = async () => {
    if (running) return;
    await resetPool();
    setBeats({ exposed: [], sealed: [], batch: [] });
    setResults({ exposed: null, sealed: null, batch: null });
    setUnsealed(false);
    readReserves();
  };

  return (
    <main className="shell">
      <header className="masthead">
        <div>
          <p className="eyebrow">Road to Devcon · NITK Surathkal</p>
          <h1 className="wordmark">
            <span className="veil">Veil</span>Swap
          </h1>
          <p className="thesis">
            The same 10 WETH trade, run against a live pool three ways: exposed to the public mempool,
            sealed behind a commit-reveal, and cleared inside a batch. Compare what you walk away with,
            and how much of it anyone else can see.
          </p>
        </div>
        <dl className="pool-readout">
          <div>
            <dt className="eyebrow">Pool WETH</dt>
            <dd>{reserves ? fmt(reserves.weth, 2) : "—"}</dd>
          </div>
          <div>
            <dt className="eyebrow">Pool MEME</dt>
            <dd>{reserves ? fmt(reserves.meme) : "—"}</dd>
          </div>
        </dl>
      </header>

      <div className="controls">
        <button className="btn btn-exposed" onClick={() => run("exposed")} disabled={running !== null}>
          {running === "exposed" ? "Running…" : "Run it exposed"}
        </button>
        <button className="btn btn-sealed" onClick={() => run("sealed")} disabled={running !== null}>
          {running === "sealed" ? "Running…" : "Run it sealed"}
        </button>
        <button className="btn btn-sealed" onClick={() => run("batch")} disabled={running !== null}>
          {running === "batch" ? "Running…" : "Run it as a batch"}
        </button>
        <button className="btn" onClick={clearBoard} disabled={running !== null}>
          Reset pool
        </button>
      </div>

      {offline &&
        (RPC_IS_LOCAL ? (
          <p className="banner">
            No chain at {new URL(RPC).host}. Start it with <code>anvil --block-time 2</code>, then deploy
            with <code>npm run deploy</code> from the project root.
          </p>
        ) : (
          <p className="banner">
            The demo chain at {new URL(RPC).host} is not answering. It is a disposable Anvil node and may
            be restarting — give it a moment and reload.
          </p>
        ))}

      <section className="track">
        <div className="lane lane-exposed">
          <div className="lane-head">
            <p className="eyebrow">Path A · public mempool</p>
            <h2 className="lane-title">Anyone can read your order</h2>
          </div>
          {beats.exposed.length === 0 ? (
            <p className="placeholder">
              Run it exposed to watch a searcher bracket your swap: buy ahead of you, let your trade fill
              at the worse price, then sell back into the pool you just moved.
            </p>
          ) : (
            <>
              <PriceTape beats={beats.exposed} lane="exposed" />
              {beats.exposed.map((beat) => (
                <BeatCard key={beat.id} beat={beat} open />
              ))}
            </>
          )}
        </div>

        <div className="clock" aria-hidden="true">
          <span className="clock-label">Same pool</span>
          <span className="clock-rail" />
        </div>

        <div className="lane lane-sealed">
          <div className="lane-head">
            <p className="eyebrow">Path B · commit-reveal</p>
            <h2 className="lane-title">Nobody can read it until it is done</h2>
          </div>
          {beats.sealed.length === 0 ? (
            <p className="placeholder">
              Run it sealed to publish only a hash of your order, wait two blocks, then reveal and execute
              in a single transaction. The searcher never sees a trade it can bracket.
            </p>
          ) : (
            <>
              <PriceTape beats={beats.sealed} lane="sealed" />
              {beats.sealed.map((beat) => (
                <BeatCard key={beat.id} beat={beat} open={unsealed} />
              ))}
            </>
          )}
        </div>
      </section>

      <section className="verdict">
        <Verdict
          lane="exposed"
          result={results.exposed}
          empty="No exposed run yet."
        />
        <div aria-hidden="true" />
        <Verdict lane="sealed" result={results.sealed} empty="No sealed run yet." />
      </section>

      <section className="second-gap">
        <div className="second-gap-intro">
          <p className="eyebrow">The second gap</p>
          <h2 className="second-gap-title">A settled trade is still a public trade</h2>
          <p className="thesis">
            Sealing the order removes the front-run, but once it executes the swap is on chain at full
            size, tagged with your address. Batching closes that: orders revealed together are matched
            against each other first, and only the leftover imbalance is sent to the pool. Whatever finds
            a counterparty inside the batch never becomes a swap at all.
          </p>
          <HiddenFigure result={results.batch} />
        </div>

        <div className="lane lane-batch">
          {beats.batch.length === 0 ? (
            <p className="placeholder">
              Run it as a batch to seal three orders at once — you buying, another buyer, and someone
              unwinding on the other side — then settle them together at one clearing price.
            </p>
          ) : (
            beats.batch.map((beat) => <BeatCard key={beat.id} beat={beat} open={unsealed} />)
          )}
        </div>
      </section>

      <p className="footnote">
        Everything above executes on a local Anvil chain against real Solidity, not a mock. The pool is a
        constant-product AMM seeded at 100 WETH / 1,000,000 MEME, and the sandwich reproduces the Session
        1 lab exactly. Neither defence is total: a validator can still censor or delay a reveal, a commit
        leaks that <em>some</em> order is coming, and batching hides flow from the pool while the reveal
        transactions themselves stay public. Together they remove the front-run and keep most of the
        order flow off the AMM&rsquo;s trade log.
      </p>
    </main>
  );
}

/// The pool price across a run, so the attack reads as a shape instead of a sentence.
///
/// The dashed line is the price the trade was quoted against. The trace is where the
/// pool actually sat at each step. On the exposed path the bot pushes the trace below
/// the line before the trade fills, and that gap is the whole theft; on the sealed path
/// nothing moves it, so the trace stays flat and there is no gap to draw.
function PriceTape({ beats, lane }: { beats: Beat[]; lane: Lane }) {
  const points = beats.filter((b) => b.price !== undefined);
  if (points.length < 2) return null;

  const values = points.map((b) => Number(formatEther(b.price!)));
  const opening = values[0];
  const fillAt = points.findIndex((b) => b.fill);

  const lo = Math.min(...values, opening);
  const hi = Math.max(...values, opening);
  const pad = (hi - lo) * 0.35 || opening * 0.02 || 1;
  const top = hi + pad;
  const bottom = lo - pad;

  const W = 320;
  const H = 104;
  const L = 14;
  const R = 14;
  const T = 16;
  const B = 26;

  const x = (i: number) => L + (i * (W - L - R)) / Math.max(1, points.length - 1);
  const y = (v: number) => T + ((top - v) / (top - bottom || 1)) * (H - T - B);

  const trace = points.map((b, i) => `${x(i)},${y(values[i])}`).join(" ");
  const openingY = y(opening);

  // How far the pool had been pushed by the moment the trade filled.
  const beforeFill = fillAt > 0 ? values[fillAt - 1] : opening;
  const displaced = opening - beforeFill;
  const showGap = fillAt > 0 && Math.abs(displaced) / opening > 0.001;

  return (
    <figure className={`tape tape-${lane}`}>
      <figcaption className="eyebrow tape-caption">
        Pool price · MEME per WETH
        <span className="tape-legend">
          <i className="tape-key tape-key-quote" /> quoted
          <i className="tape-key tape-key-actual" /> actual
        </span>
      </figcaption>

      <svg viewBox={`0 0 ${W} ${H}`} className="tape-svg" role="img"
        aria-label={
          showGap
            ? `Pool price fell ${Math.abs(displaced).toFixed(0)} MEME per WETH before the trade filled`
            : "Pool price did not move before the trade filled"
        }>
        <line x1={L} y1={openingY} x2={W - R} y2={openingY} className="tape-quote" />

        {showGap && (
          <>
            <rect
              x={x(fillAt - 1)}
              y={Math.min(openingY, y(beforeFill))}
              width={Math.max(2, x(fillAt) - x(fillAt - 1))}
              height={Math.abs(y(beforeFill) - openingY)}
              className="tape-gap"
            />
            <text x={x(fillAt) + 5} y={(openingY + y(beforeFill)) / 2 + 3} className="tape-gap-label">
              pushed by the bot
            </text>
          </>
        )}

        <polyline points={trace} className="tape-trace" />

        {points.map((b, i) => (
          <circle
            key={b.id}
            cx={x(i)}
            cy={y(values[i])}
            r={b.fill ? 4.5 : 2.5}
            className={`tape-dot tape-dot-${b.actor}${b.fill ? " tape-dot-fill" : ""}`}
          />
        ))}

        {fillAt >= 0 && (
          <text x={x(fillAt)} y={H - 9} className="tape-fill-label" textAnchor="middle">
            your fill
          </text>
        )}
      </svg>

      <p className="tape-note">
        {showGap ? (
          <>
            The bot moved the pool{" "}
            <strong>{((Math.abs(displaced) / opening) * 100).toFixed(1)}% against you</strong> before your
            trade filled.
          </>
        ) : (
          <>
            Nothing moved the pool between your quote and your fill. The step down after it is your own
            trade&rsquo;s impact, which every trade pays.
          </>
        )}
      </p>
    </figure>
  );
}

function BeatCard({ beat, open }: { beat: Beat; open: boolean }) {
  const detail = beat.sealed ? (
    <>
      <span className="redactable" data-open={open}>
        {beat.detail}
      </span>
      <span className="redaction-note">
        {open ? "Revealed after settlement" : "Sealed — on chain as a hash only"}
      </span>
    </>
  ) : (
    beat.detail
  );

  return (
    <article className={`beat beat-${beat.tone}${beat.targeted ? " beat-targeted" : ""}`}>
      {beat.targeted && <span className="watching">Bot watching</span>}
      <div className="beat-top">
        <p className="eyebrow">{beat.who ?? (beat.actor === "searcher" ? "Searcher bot" : "You")}</p>
        {beat.block !== undefined && <p className="eyebrow">Block {beat.block}</p>}
      </div>
      <h3 className="beat-title">{beat.title}</h3>
      <p className="beat-detail">{detail}</p>
      {beat.hash && <code className="beat-hash">{beat.hash}</code>}
    </article>
  );
}

/// How much of the batch's order flow the pool — and therefore any indexer — never saw.
function HiddenFigure({ result }: { result: RunResult | null }) {
  if (!result?.hidden) {
    return <p className="verdict-sub">No batch run yet.</p>;
  }

  const { submitted, observed } = result.hidden;
  const hiddenShare = submitted === 0n ? 0 : Number(((submitted - observed) * 100n) / submitted);

  return (
    <div className="hidden-figure">
      <p className="eyebrow">Order flow the pool never saw</p>
      <p className="verdict-figure figure-sealed">{hiddenShare}%</p>
      <p className="verdict-sub">
        {fmt(submitted, 0)} WETH of buying was submitted. Only {fmt(observed, 0)} WETH reached the pool.
      </p>
    </div>
  );
}

function Verdict({ lane, result, empty }: { lane: Lane; result: RunResult | null; empty: string }) {
  const tone = lane === "exposed" ? "figure-exposed" : "figure-sealed";

  if (!result) {
    return (
      <div className="verdict-cell">
        <p className="eyebrow">{lane === "exposed" ? "Path A result" : "Path B result"}</p>
        <p className="verdict-sub">{empty}</p>
      </div>
    );
  }

  // What arrived, as a share of what was quoted. The missing slice is the shortfall.
  const kept =
    result.fairOut > 0n ? Number((result.victimOut * 10_000n) / result.fairOut) / 100 : 100;

  return (
    <div className="verdict-cell">
      <p className="eyebrow">You received</p>
      <p className={`verdict-figure ${tone}`}>{fmt(result.victimOut)} MEME</p>

      <div className={`fillbar fillbar-${lane}`} role="img"
        aria-label={`${kept.toFixed(1)} percent of the quoted amount`}>
        <span className="fillbar-kept" style={{ width: `${Math.min(100, kept)}%` }} />
        {kept < 99.95 && <span className="fillbar-lost" style={{ width: `${100 - kept}%` }} />}
      </div>

      <p className="verdict-sub">
        {result.victimLoss > 0n
          ? `${kept.toFixed(1)}% of your quote arrived — ${fmt(result.victimLoss)} MEME short of ${fmt(result.fairOut)}`
          : `The full ${fmt(result.fairOut)} MEME you were quoted`}
      </p>
      <p className="verdict-sub">
        Bot took {Number(formatEther(result.searcherProfit)).toFixed(4)} WETH
      </p>
    </div>
  );
}

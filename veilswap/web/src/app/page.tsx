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
  type RunEvent,
  type RunResult,
} from "@/lib/demo";

type Lane = "exposed" | "sealed" | "batch";

const RUNNERS: Record<Lane, () => AsyncGenerator<RunEvent>> = {
  exposed: runExposed,
  sealed: runSealed,
  batch: runBatch,
};

/// The four beats both paths are pinned to, so the comparison can be read across.
const MOMENTS = [
  { n: 1, title: "Your order goes out" },
  { n: 2, title: "What a searcher can do with it" },
  { n: 3, title: "Your trade fills" },
  { n: 4, title: "What happens after" },
] as const;

/// The chart needs a different shape when the columns stack, or its labels end up
/// rendering at a few pixels tall.
function useNarrow() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 620px)");
    const sync = () => setNarrow(mq.matches);
    // Deferred so the first write is not synchronous inside the effect.
    void Promise.resolve().then(sync);
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return narrow;
}

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
  const [busy, setBusy] = useState(false);
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
    // Wrapped so the reserve write lands in a microtask rather than synchronously
    // inside the effect body.
    void (async () => {
      await readReserves();
    })();
  }, [readReserves]);

  const runLane = async (lane: Lane) => {
    setRunning(lane);
    setBeats((b) => ({ ...b, [lane]: [] }));
    setResults((r) => ({ ...r, [lane]: null }));
    if (lane !== "exposed") setUnsealed(false);

    try {
      await initDemo();
      await resetPool();
      for await (const event of RUNNERS[lane]()) {
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
      // Put the pool back before letting go. Leaving it moved would make it the
      // baseline for whoever loads the page next, and their numbers would drift
      // away from the ones this demo is supposed to reproduce.
      try {
        await resetPool();
      } catch {
        /* the run already reported whatever went wrong */
      }
      void readReserves();
    }
  };

  const guard = async (job: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await job();
    } finally {
      setBusy(false);
    }
  };

  const runComparison = () =>
    guard(async () => {
      await runLane("exposed");
      await runLane("sealed");
    });

  const clearBoard = () =>
    guard(async () => {
      await resetPool();
      setBeats({ exposed: [], sealed: [], batch: [] });
      setResults({ exposed: null, sealed: null, batch: null });
      setUnsealed(false);
      void readReserves();
    });

  const status =
    running === "exposed"
      ? "Sending your trade through the public mempool"
      : running === "sealed"
        ? "Sealing the same trade behind a commit"
        : running === "batch"
          ? "Clearing three sealed orders as one batch"
          : null;

  return (
    <main className="shell">
      <header className="masthead">
        <p className="eyebrow">Road to Devcon · NITK Surathkal</p>
        <div className="masthead-row">
          <h1 className="wordmark">
            <span className="veil">Veil</span>Swap
          </h1>
          <dl className="pool">
            <div>
              <dt className="eyebrow">Pool</dt>
              <dd className="num">{reserves ? fmt(reserves.weth, 2) : "—"} WETH</dd>
            </div>
            <div>
              <dt className="eyebrow" aria-hidden="true">
                &nbsp;
              </dt>
              <dd className="num">{reserves ? fmt(reserves.meme) : "—"} MEME</dd>
            </div>
          </dl>
        </div>
        <p className="thesis">
          One 10 WETH trade, routed two ways against the same live pool. Everything below executes on
          chain while you watch.
        </p>
      </header>

      {offline && (
        <p className="banner">
          {RPC_IS_LOCAL ? (
            <>
              No chain at {new URL(RPC).host}. Start it with <code>anvil --block-time 2</code>, then
              deploy with <code>npm run deploy</code>.
            </>
          ) : (
            <>
              The demo chain at {new URL(RPC).host} is not answering. It is a disposable node and may be
              restarting — give it a moment and reload.
            </>
          )}
        </p>
      )}

      <section className="scoreboard">
        <Outcome
          label="Through the public mempool"
          tone="exposed"
          result={results.exposed}
          running={running === "exposed"}
        />

        <Delta exposed={results.exposed} sealed={results.sealed} />

        <Outcome
          label="Sealed with VeilSwap"
          tone="sealed"
          result={results.sealed}
          running={running === "sealed"}
        />
      </section>

      <div className="controls">
        <button className="btn btn-primary" onClick={runComparison} disabled={busy}>
          {busy && running !== "batch" ? "Running…" : "Run the comparison"}
        </button>
        <button className="btn" onClick={() => guard(() => runLane("batch"))} disabled={busy}>
          {running === "batch" ? "Running…" : "Run the batch"}
        </button>
        <button className="btn btn-quiet" onClick={clearBoard} disabled={busy}>
          Reset
        </button>
        {status && <span className="status">{status}…</span>}
      </div>

      <Tape exposed={beats.exposed} sealed={beats.sealed} />

      <section className="moments">
        <div className="moments-head">
          <span />
          <p className="eyebrow col-exposed">Public mempool</p>
          <p className="eyebrow col-sealed">Commit-reveal</p>
        </div>

        {MOMENTS.map((m) => (
          <div className="moment" key={m.n}>
            <div className="moment-label">
              <span className="moment-n num">{String(m.n).padStart(2, "0")}</span>
              <h2 className="moment-title">{m.title}</h2>
            </div>
            <Cell beats={beats.exposed.filter((b) => b.moment === m.n)} open lane="exposed" />
            <Cell
              beats={beats.sealed.filter((b) => b.moment === m.n)}
              open={unsealed}
              lane="sealed"
            />
          </div>
        ))}
      </section>

      <section className="act">
        <div className="act-label">
          <p className="eyebrow">The second gap</p>
          <h2 className="act-title">A settled trade is still a public trade</h2>
        </div>

        <p className="act-lede">
          Sealing the order removes the front-run, but once it executes the swap is on chain at full
          size, tagged with your address. Batching closes that: orders revealed together are matched
          against each other first, and only the leftover imbalance reaches the pool.
        </p>

        <div className="act-figure">
          <Hidden result={results.batch} />
        </div>

        {beats.batch.length > 0 && (
          <ol className="feed">
            {beats.batch.map((b) => (
              <li key={b.id}>
                <BeatLine beat={b} open={unsealed} />
              </li>
            ))}
          </ol>
        )}
      </section>

      <Adversary />

      <footer className="footnote">
        <p>
          The pool is a constant-product AMM seeded at 100 WETH / 1,000,000 MEME, and the sandwich
          reproduces the Session 1 lab to the wei. Neither defence is total: a validator can still censor
          or delay a reveal, a commit leaks that <em>some</em> order is coming, and the reveal
          transactions themselves stay public. Together they remove the front-run and keep most of the
          order flow off the pool&rsquo;s trade log.
        </p>
      </footer>
    </main>
  );
}

/* ---------- scoreboard ---------- */

function Outcome({
  label,
  tone,
  result,
  running,
}: {
  label: string;
  tone: "exposed" | "sealed";
  result: RunResult | null;
  running: boolean;
}) {
  const kept =
    result && result.fairOut > 0n ? Number((result.victimOut * 10_000n) / result.fairOut) / 100 : null;

  return (
    <div className={`outcome outcome-${tone}${running ? " is-running" : ""}`}>
      <p className="eyebrow">{label}</p>
      <p className={`outcome-figure${result ? "" : " is-empty"}`}>
        {result ? fmt(result.victimOut) : "—"}
        {result && <span className="outcome-unit">MEME</span>}
      </p>

      {kept === null ? (
        <span className="fillbar-idle" aria-hidden="true" />
      ) : (
        <div className="fillbar" role="img" aria-label={`${kept.toFixed(1)}% of the quote`}>
          <span className="fillbar-kept" style={{ width: `${Math.min(100, kept)}%` }} />
        </div>
      )}

      <p className="outcome-sub">
        {result ? (
          result.victimLoss > 0n ? (
            <>
              {kept!.toFixed(1)}% of your quote · bot took{" "}
              <strong>{Number(formatEther(result.searcherProfit)).toFixed(4)} WETH</strong>
            </>
          ) : (
            <>Every MEME you were quoted · bot took nothing</>
          )
        ) : (
          "Awaiting a run"
        )}
      </p>
    </div>
  );
}

/// The money that changed hands between the two routes.
function Delta({ exposed, sealed }: { exposed: RunResult | null; sealed: RunResult | null }) {
  const gap = exposed && sealed ? sealed.victimOut - exposed.victimOut : null;

  return (
    <div className="delta" aria-hidden={gap === null}>
      <span className="delta-rule" />
      {gap !== null && gap > 0n ? (
        <>
          <span className="delta-value num">{fmt(gap)}</span>
          <span className="eyebrow">MEME difference</span>
        </>
      ) : (
        <span className="eyebrow delta-idle">vs</span>
      )}
      <span className="delta-rule" />
    </div>
  );
}

/* ---------- price tape ---------- */

/// Both routes on one axis. The pool starts and ends in the same place either way;
/// the exposed line takes a detour through a dip, and the trade fills inside it.
function Tape({ exposed, sealed }: { exposed: Beat[]; sealed: Beat[] }) {
  const narrow = useNarrow();
  const series = (list: Beat[]) => {
    const out: (number | null)[] = [];
    let last: number | null = null;
    for (let m = 1; m <= 4; m++) {
      const priced = list.filter((b) => b.moment === m && b.price !== undefined);
      const v: number | null = priced.length
        ? Number(formatEther(priced[priced.length - 1].price!))
        : last;
      out.push(v);
      if (v !== null) last = v;
    }
    return out;
  };

  const a = series(exposed);
  const b = series(sealed);
  const known = [...a, ...b].filter((v): v is number => v !== null);
  if (known.length < 2) return null;

  const opening = a[0] ?? b[0] ?? known[0];
  const lo = Math.min(...known);
  const hi = Math.max(...known, opening);
  const pad = (hi - lo) * 0.3 || opening * 0.02 || 1;
  const top = hi + pad;
  const bottom = lo - pad;

  // Stacked layouts get a squarer box so the type inside it stays legible.
  const W = narrow ? 360 : 720;
  const H = narrow ? 230 : 190;
  const L = narrow ? 44 : 52;
  const R = narrow ? 14 : 116;
  const T = narrow ? 18 : 22;
  const B = narrow ? 30 : 34;

  const x = (i: number) => L + (i * (W - L - R)) / 3;
  const y = (v: number) => T + ((top - v) / (top - bottom || 1)) * (H - T - B);

  const path = (vals: (number | null)[]) =>
    vals
      .map((v, i) => (v === null ? null : `${i === 0 ? "M" : "L"}${x(i)},${y(v)}`))
      .filter(Boolean)
      .join(" ");

  const openY = y(opening);
  const fillIdx = 2;
  const dipped = a[1] !== null && a[1] < opening;

  // Both routes leave the pool in the same place, so the end labels land on top of
  // each other unless they are pushed apart.
  const endLabels = (() => {
    const ya = a[3] !== null ? y(a[3]) + 3 : 0;
    const yb = b[3] !== null ? y(b[3]) + 3 : 0;
    if (a[3] === null || b[3] === null || Math.abs(ya - yb) >= 13) return { a: ya, b: yb };
    const mid = (ya + yb) / 2;
    return { a: mid + 8, b: mid - 8 };
  })();

  return (
    <figure className="tape">
      <figcaption className="tape-caption">
        <span className="eyebrow">Pool price · MEME per WETH</span>
        <span className="tape-legend">
          <b className="k k-quote" /> quoted
          <b className="k k-exposed" /> exposed
          <b className="k k-sealed" /> sealed
        </span>
      </figcaption>

      <svg viewBox={`0 0 ${W} ${H}`} className="tape-svg" role="img"
        aria-label="Pool price across the four moments for both routes">
        <line x1={L} y1={openY} x2={W - R} y2={openY} className="t-quote" />
        <text x={L - 8} y={openY + 3} className="t-axis" textAnchor="end">
          {Math.round(opening).toLocaleString()}
        </text>

        {dipped && (
          <rect
            x={x(1)}
            y={openY}
            width={x(fillIdx) - x(1)}
            height={Math.max(0, y(a[1]!) - openY)}
            className="t-gap"
          />
        )}

        {MOMENTS.map((m, i) => (
          <text key={m.n} x={x(i)} y={H - 12} className="t-axis" textAnchor="middle">
            {String(m.n).padStart(2, "0")}
          </text>
        ))}

        <path d={path(b)} className="t-line t-sealed" />
        <path d={path(a)} className="t-line t-exposed" />

        {a.map((v, i) =>
          v === null ? null : (
            <circle key={`a${i}`} cx={x(i)} cy={y(v)} r={i === fillIdx ? 5 : 3} className="t-dot t-dot-exposed" />
          ),
        )}
        {b.map((v, i) =>
          v === null ? null : (
            <circle key={`b${i}`} cx={x(i)} cy={y(v)} r={i === fillIdx ? 5 : 3} className="t-dot t-dot-sealed" />
          ),
        )}

        {!narrow && a[3] !== null && (
          <text x={x(3) + 10} y={endLabels.a} className="t-tag t-tag-exposed">
            exposed
          </text>
        )}
        {!narrow && b[3] !== null && (
          <text x={x(3) + 10} y={endLabels.b} className="t-tag t-tag-sealed">
            sealed
          </text>
        )}
      </svg>

      <p className="tape-note">
        {dipped ? (
          <>
            The bot pushed the pool{" "}
            <strong>{(((opening - a[1]!) / opening) * 100).toFixed(1)}% against you</strong> before your
            trade filled. The drop that follows on both lines is your own trade&rsquo;s impact, which
            every trade pays.
          </>
        ) : (
          <>Nothing moved the pool between the quote and the fill.</>
        )}
      </p>
    </figure>
  );
}

/* ---------- moments ---------- */

const PATH_NAME: Partial<Record<Lane, string>> = {
  exposed: "Public mempool",
  sealed: "Commit-reveal",
};

function Cell({ beats, open, lane }: { beats: Beat[]; open: boolean; lane: Lane }) {
  if (beats.length === 0) {
    return <div className={`cell cell-${lane} is-empty`} data-path={PATH_NAME[lane]} />;
  }
  return (
    <div className={`cell cell-${lane}`} data-path={PATH_NAME[lane]}>
      {beats.map((b) => (
        <BeatLine key={b.id} beat={b} open={open} />
      ))}
    </div>
  );
}

function BeatLine({ beat, open }: { beat: Beat; open: boolean }) {
  return (
    <article className={`beat beat-${beat.tone}${beat.targeted ? " is-targeted" : ""}`}>
      <header className="beat-head">
        <span className="eyebrow">
          {beat.who ?? (beat.actor === "searcher" ? "Searcher bot" : "You")}
        </span>
        {beat.block !== undefined && <span className="eyebrow num">#{beat.block}</span>}
      </header>

      <p className="beat-title">{beat.title}</p>

      {beat.detail && (
        <p className="beat-detail">
          {beat.sealed ? (
            <>
              <span className="redactable" data-open={open}>
                {beat.detail}
              </span>
              <span className="redaction-note">
                {open ? "Revealed after settlement" : "On chain as a hash only"}
              </span>
            </>
          ) : (
            beat.detail
          )}
        </p>
      )}

      {beat.hash && <p className="beat-hash num">{beat.hash}</p>}
    </article>
  );
}

/* ---------- adversary ---------- */

/// Two defects a real searcher found in this project, and what closed them.
/// Both numbers below came out of the bot, not out of an argument.
const FINDINGS = [
  {
    n: "01",
    title: "The reveal gave the order away",
    body: (
      <>
        The commit is genuinely opaque — the bot logged it and moved on. But{" "}
        <code>reveal()</code> has to spell the order out in calldata, and that transaction sits in the
        mempool like any other. The bot read it and bracketed the reveal itself.
      </>
    ),
    cost: "Bot took 0.6977 WETH",
    fix: "Execution is now anchored to the price recorded at commit time, so shifting the pool enough to be worth attacking makes the reveal revert instead.",
    test: "test_frontRunningTheRevealMakesItRevert",
  },
  {
    n: "02",
    title: "Settlement could be bought",
    body: (
      <>
        <code>settleBatch</code> is permissionless and read the pool&rsquo;s live price to decide how
        much of the batch matched internally. So whoever called it could move the pool and settle in
        one transaction, choosing the rate their own order cleared at.
      </>
    ),
    cost: "Settler took 2.965 WETH · honest buyer lost 30% of their fill",
    fix: "The batch now matches at the price recorded when its first order was revealed, and refuses to settle if the pool has drifted more than 1% since.",
    test: "test_settlerCannotBuyTheSettlementPrice",
  },
];

/// Verbatim from a run against the fixed contracts.
const TRANSCRIPT: [string, string][] = [
  ["SEEN", "a sealed commit — hash only, no size or direction. Nothing to act on."],
  ["TARGET", "veil reveal: 10 WETH in, min out 81818.18 (9090.90 MEME of slippage room)"],
  ["FRONT-RUN", "buying with 5 WETH at 3600000024 wei gas"],
  ["LOSS", "-0.000000000000000001 WETH — the attack did not pay"],
];

function Adversary() {
  return (
    <section className="adversary">
      <div className="adversary-label">
        <p className="eyebrow">The adversary</p>
        <h2 className="act-title">We pointed a real searcher at it</h2>
      </div>

      <p className="adversary-lede">
        <code>scripts/searcher-bot.mjs</code> is a separate process. It polls the pending pool, decodes
        whatever it finds and decides for itself what is worth attacking — nothing about the demo is
        scripted into it. Left on the unprotected path it takes 0.970654627539503385 WETH, the Session 1
        figure to the last wei, arrived at on its own. It also broke two versions of this project.
      </p>

      <ol className="findings">
        {FINDINGS.map((f) => (
          <li className="finding" key={f.n}>
            <p className="eyebrow">Finding {f.n}</p>
            <h3 className="finding-title">{f.title}</h3>
            <p className="finding-body">{f.body}</p>
            <p className="finding-cost">{f.cost}</p>
            <p className="finding-fix">{f.fix}</p>
            <p className="finding-test num">{f.test}</p>
          </li>
        ))}
      </ol>

      <figure className="transcript">
        <figcaption className="eyebrow">The bot, run against the fixed contracts</figcaption>
        <pre>
          {TRANSCRIPT.map(([tag, line]) => (
            <span className="tr-line" key={tag}>
              <span className={`tr-tag tr-${tag.toLowerCase().replace("-", "")}`}>{tag}</span>
              {line}
            </span>
          ))}
        </pre>
      </figure>
    </section>
  );
}

/* ---------- batch ---------- */

function Hidden({ result }: { result: RunResult | null }) {
  if (!result?.hidden) {
    return <p className="act-empty">Run the batch to see how little of it reaches the pool.</p>;
  }

  const { submitted, observed } = result.hidden;
  const share = submitted === 0n ? 0 : Number(((submitted - observed) * 100n) / submitted);

  return (
    <div className="hidden-figure">
      <p className="eyebrow">Order flow the pool never saw</p>
      <p className="hidden-value">
        {share}
        <span className="outcome-unit">%</span>
      </p>
      <p className="outcome-sub">
        {fmt(submitted, 0)} WETH of buying was submitted. Only {fmt(observed, 0)} WETH reached the pool.
      </p>
    </div>
  );
}

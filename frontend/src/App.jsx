import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CONTRACT_ADDRESS,
  CHAIN,
  ZERO,
  GRACE_PERIOD,
  hasWallet,
  connectWallet,
  ensureChain,
  getChainOk,
  send,
  receiptFailed,
  loadAll,
  parseGen,
  formatGen,
} from "./genlayer.js";

const MIN_COLLATERAL_PCT = 150;
const MAX_INTEREST_PCT = 20;
const MIN_PRINCIPAL_WEI = 10n ** 12n;
const ASSETS = ["ETH", "BTC", "SOL"];
const DURATIONS = [
  { label: "10 minutes (test)", seconds: 600 },
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86400 },
  { label: "7 days", seconds: 7 * 86400 },
  { label: "30 days", seconds: 30 * 86400 },
];

const short = (a) => (a ? a.slice(0, 6) + "..." + a.slice(-4) : "");
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const nowSec = () => Math.floor(Date.now() / 1000);
const pref = (k, d) => {
  try { return localStorage.getItem("gll_" + k) || d; } catch (e) { return d; }
};
const FILTERS = ["all", "open", "active", "repaid", "liquidated", "cancelled"];

function fmtDuration(sec) {
  const s = Number(sec);
  if (s % 86400 === 0) return s / 86400 + " day" + (s / 86400 === 1 ? "" : "s");
  if (s % 3600 === 0) return s / 3600 + " hour" + (s / 3600 === 1 ? "" : "s");
  return Math.round(s / 60) + " min";
}

function fmtDate(sec) {
  return new Date(Number(sec) * 1000).toLocaleString();
}

function fmtUsd(e6) {
  return (Number(e6) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------------------
// Loan card
// ---------------------------------------------------------------------------

function LoanCard({ loan, account, busy, onAction }) {
  const [collateral, setCollateral] = useState(formatGen(loan.required_collateral, 6));
  const isLender = same(account, loan.lender);
  const isBorrower = same(account, loan.borrower);
  const active = loan.status === "active";
  const open = loan.status === "open";
  const due = Number(loan.due_at);
  const overdue = active && nowSec() > due + GRACE_PERIOD;
  const hasTrigger = BigInt(loan.min_price_e6) > 0n;
  const id = loan.id;

  return (
    <div className="card">
      <div className="card-head">
        <strong>Loan #{id}</strong>
        <span className={"badge " + loan.status}>{loan.status}</span>
      </div>

      <div className="grid">
        <div>
          <span className="k">Principal</span>
          <span className="v">{formatGen(loan.principal)} GEN</span>
        </div>
        <div>
          <span className="k">Interest</span>
          <span className="v">{Number(loan.interest_bps) / 100}% flat</span>
        </div>
        <div>
          <span className="k">To repay</span>
          <span className="v">{formatGen(loan.repay_amount)} GEN</span>
        </div>
        <div>
          <span className="k">Term</span>
          <span className="v">{fmtDuration(loan.duration)}</span>
        </div>
        <div>
          <span className="k">{open ? "Required collateral" : "Collateral"}</span>
          <span className="v">
            {formatGen(open ? loan.required_collateral : loan.collateral)} GEN
          </span>
        </div>
        <div>
          <span className="k">Price trigger</span>
          <span className="v">
            {hasTrigger ? `${loan.price_ref} < $${fmtUsd(loan.min_price_e6)}` : "none"}
          </span>
        </div>
      </div>

      <div className="meta">
        Lender {short(loan.lender)}
        {loan.borrower !== ZERO && <> &middot; Borrower {short(loan.borrower)}</>}
        {isLender && <span className="you"> (you are lender)</span>}
        {isBorrower && <span className="you"> (you are borrower)</span>}
      </div>
      {active && (
        <div className="meta">
          Due {fmtDate(due)}
          {overdue && <span className="warn"> &middot; overdue</span>}
        </div>
      )}
      {Number(loan.last_price_e6) > 0 && (
        <div className="meta">
          Oracle price at last liquidation: {loan.price_ref} ${fmtUsd(loan.last_price_e6)}
        </div>
      )}

      <div className="actions">
        {open && !isLender && (
          <>
            <input
              className="input"
              value={collateral}
              onChange={(e) => setCollateral(e.target.value)}
              inputMode="decimal"
              aria-label="Collateral in GEN"
            />
            <button
              className="btn primary"
              disabled={!account || busy}
              onClick={() =>
                onAction(`Accept loan #${id}`, "accept_offer", [Number(id)], parseGen(collateral))
              }
            >
              Accept with collateral
            </button>
          </>
        )}
        {open && isLender && (
          <button
            className="btn"
            disabled={busy}
            onClick={() => onAction(`Cancel offer #${id}`, "cancel_offer", [Number(id)], 0n)}
          >
            Cancel offer
          </button>
        )}
        {active && isBorrower && (
          <button
            className="btn primary"
            disabled={busy}
            onClick={() =>
              onAction(`Repay loan #${id}`, "repay", [Number(id)], BigInt(loan.repay_amount))
            }
          >
            Repay {formatGen(loan.repay_amount)} GEN
          </button>
        )}
        {overdue && account && (
          <button
            className="btn danger"
            disabled={busy}
            onClick={() =>
              onAction(`Liquidate overdue #${id}`, "liquidate_overdue", [Number(id)], 0n)
            }
          >
            Liquidate overdue
          </button>
        )}
        {active && isLender && hasTrigger && (
          <button
            className="btn danger"
            disabled={busy}
            onClick={() =>
              onAction(`Liquidate by price #${id}`, "liquidate_by_price", [Number(id)], 0n)
            }
          >
            Liquidate by price (oracle)
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create offer form
// ---------------------------------------------------------------------------

function CreateOffer({ account, busy, paused, onAction }) {
  const [principal, setPrincipal] = useState("1");
  const [interest, setInterest] = useState("5");
  const [duration, setDuration] = useState(600);
  const [collateralPct, setCollateralPct] = useState("150");
  const [useTrigger, setUseTrigger] = useState(false);
  const [asset, setAsset] = useState("ETH");
  const [triggerUsd, setTriggerUsd] = useState("2000");
  const [error, setError] = useState("");

  const preview = useMemo(() => {
    try {
      const p = parseGen(principal);
      const i = Math.round(Number(interest) * 100);
      const c = Math.round(Number(collateralPct) * 100);
      return {
        repay: p + (p * BigInt(i)) / 10000n,
        collateral: (p * BigInt(c)) / 10000n,
      };
    } catch (e) {
      return null;
    }
  }, [principal, interest, collateralPct]);

  function submit() {
    setError("");
    try {
      const p = parseGen(principal);
      const interestNum = Number(interest);
      const collNum = Number(collateralPct);
      if (p < MIN_PRINCIPAL_WEI) throw new Error("Principal is too small.");
      if (!(interestNum >= 0 && interestNum <= MAX_INTEREST_PCT))
        throw new Error(`Interest must be between 0 and ${MAX_INTEREST_PCT}%.`);
      if (!(collNum >= MIN_COLLATERAL_PCT))
        throw new Error(`Collateral ratio must be at least ${MIN_COLLATERAL_PCT}%.`);
      let minPrice = 0n;
      let ref = "NONE";
      if (useTrigger) {
        const usd = Number(triggerUsd);
        if (!(usd > 0)) throw new Error("Enter a trigger price above 0.");
        minPrice = BigInt(Math.round(usd * 1e6));
        ref = asset;
      }
      onAction(
        "Create offer",
        "create_offer",
        [Math.round(interestNum * 100), Number(duration), Math.round(collNum * 100), minPrice, ref],
        p
      );
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <strong>Create a loan offer</strong>
      </div>
      <p className="hint">
        You lend GEN. It is held in escrow until a borrower posts collateral. You can cancel
        while the offer is open.
      </p>

      <label>Amount to lend (GEN)</label>
      <input className="input" value={principal} onChange={(e) => setPrincipal(e.target.value)} inputMode="decimal" />

      <label>Interest for the whole term (%, max {MAX_INTEREST_PCT})</label>
      <input className="input" value={interest} onChange={(e) => setInterest(e.target.value)} inputMode="decimal" />

      <label>Term</label>
      <select className="input" value={duration} onChange={(e) => setDuration(e.target.value)}>
        {DURATIONS.map((d) => (
          <option key={d.seconds} value={d.seconds}>
            {d.label}
          </option>
        ))}
      </select>

      <label>Required collateral (% of amount, min {MIN_COLLATERAL_PCT})</label>
      <input className="input" value={collateralPct} onChange={(e) => setCollateralPct(e.target.value)} inputMode="decimal" />

      <label className="check">
        <input type="checkbox" checked={useTrigger} onChange={(e) => setUseTrigger(e.target.checked)} />
        Add oracle price trigger
      </label>
      {useTrigger && (
        <div className="trigger">
          <p className="hint">
            If the reference asset price falls below your trigger, you can liquidate. Validators
            fetch the price independently and must agree on the price and on the outcome.
            Testnet GEN has no market price, so the trigger tracks a reference asset.
          </p>
          <label>Reference asset</label>
          <select className="input" value={asset} onChange={(e) => setAsset(e.target.value)}>
            {ASSETS.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          <label>Trigger price (USD)</label>
          <input className="input" value={triggerUsd} onChange={(e) => setTriggerUsd(e.target.value)} inputMode="decimal" />
        </div>
      )}

      {preview && (
        <div className="preview">
          Borrower repays <strong>{formatGen(preview.repay)} GEN</strong> and posts at least{" "}
          <strong>{formatGen(preview.collateral)} GEN</strong> collateral.
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {paused && <div className="error">The protocol is paused: new offers are disabled.</div>}

      <button className="btn primary wide" disabled={!account || busy || paused} onClick={submit}>
        {account ? "Lend and create offer" : "Connect wallet first"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  const [account, setAccount] = useState("");
  const [chainOk, setChainOk] = useState(true);
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState("market");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [balance, setBalance] = useState("");
  const [filter, setFilter] = useState(pref("filter", "all"));
  const [sort, setSort] = useState(pref("sort", "new"));

  useEffect(() => {
    try { localStorage.setItem("gll_filter", filter); localStorage.setItem("gll_sort", sort); } catch (e) {}
  }, [filter, sort]);

  useEffect(() => {
    if (!account || !hasWallet()) { setBalance(""); return; }
    window.ethereum
      .request({ method: "eth_getBalance", params: [account, "latest"] })
      .then((h) => setBalance(formatGen(BigInt(h), 3)))
      .catch(() => setBalance(""));
  }, [account, data]);

  const refresh = useCallback(async () => {
    try {
      const d = await loadAll();
      setData(d);
      setLoadError("");
    } catch (e) {
      setLoadError(e.shortMessage || e.message || "Could not load loans.");
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!hasWallet()) return;
    const onAccounts = (accs) => setAccount(accs && accs[0] ? accs[0] : "");
    const onChain = async () => setChainOk(await getChainOk());
    window.ethereum.on?.("accountsChanged", onAccounts);
    window.ethereum.on?.("chainChanged", onChain);
    getChainOk().then(setChainOk);
    return () => {
      window.ethereum.removeListener?.("accountsChanged", onAccounts);
      window.ethereum.removeListener?.("chainChanged", onChain);
    };
  }, []);

  async function connect() {
    try {
      const a = await connectWallet();
      setAccount(a);
      setChainOk(await getChainOk());
    } catch (e) {
      setToast({ kind: "error", text: e.shortMessage || e.message });
    }
  }

  async function switchNetwork() {
    try {
      await ensureChain();
      setChainOk(await getChainOk());
    } catch (e) {
      setToast({ kind: "error", text: e.shortMessage || e.message });
    }
  }

  async function onAction(label, functionName, args, value) {
    if (!account) return;
    if (!chainOk) {
      setToast({ kind: "error", text: `Switch your wallet to ${CHAIN.name} first.` });
      return;
    }
    setBusy(true);
    setToast({ kind: "info", text: `${label}: confirm in your wallet, then wait for validators...` });
    try {
      const { hash, receipt } = await send(account, functionName, args, value);
      if (receiptFailed(receipt)) {
        setToast({
          kind: "error",
          text: `${label}: the contract rejected this call (rolled back). Tx ${short(hash)}. Check the loan state below.`,
        });
      } else {
        setToast({ kind: "ok", text: `${label}: accepted by validators. Tx ${short(hash)}.` });
      }
    } catch (e) {
      setToast({ kind: "error", text: `${label}: ${e.shortMessage || e.message}` });
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  const loans = data ? data.loans : [];
  const market = loans.filter((l) => l.status === "open");
  const mine = loans.filter((l) => same(account, l.lender) || same(account, l.borrower));
  const sorter = (a, b) =>
    sort === "amount" ? (BigInt(b.principal) > BigInt(a.principal) ? 1 : -1) : Number(b.id) - Number(a.id);
  const shownMarket = [...market].sort(sorter);
  const shownMine = mine.filter((l) => filter === "all" || l.status === filter).sort(sorter);
  const sum = (arr, f) => arr.reduce((t, l) => t + BigInt(f(l)), 0n);
  const asLender = mine.filter((l) => same(account, l.lender) && (l.status === "open" || l.status === "active"));
  const asBorrower = mine.filter((l) => same(account, l.borrower) && l.status === "active");
  const pf = {
    lent: sum(asLender, (l) => l.principal),
    earn: sum(asLender.filter((l) => l.status === "active"), (l) => BigInt(l.repay_amount) - BigInt(l.principal)),
    owed: sum(asBorrower, (l) => l.repay_amount),
    locked: sum(asBorrower, (l) => l.collateral),
  };

  return (
    <div className="app">
      <header>
        <div>
          <h1>GenLayer Lending</h1>
          <div className="sub">P2P loans with oracle liquidation &middot; {CHAIN.name}</div>
        </div>
        {account ? (
          <div className="wallet">
            <div><span className="dot" />{short(account)}</div>
            {balance && <small>{balance} GEN</small>}
            <button className="link" onClick={() => setAccount("")}>Disconnect</button>
          </div>
        ) : (
          <button className="btn primary" onClick={connect}>
            Connect wallet
          </button>
        )}
      </header>

      {account && !chainOk && (
        <div className="banner warn-b">
          Your wallet is on the wrong network.{" "}
          <button className="link" onClick={switchNetwork}>
            Switch to {CHAIN.name}
          </button>
        </div>
      )}

      <div className="banner info-b">
        Testnet demo. On Bradbury, payouts are emitted as internal transfers and wallet balances
        may not update; the loan state shown here (read from the contract) is the source of truth.
        Price triggers track a reference asset because testnet GEN has no market price.
      </div>

      {toast && (
        <div className={"toast " + toast.kind} onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}

      <div className="stats">
        <div>
          <span className="k">Loans</span>
          <span className="v">{data ? data.count : "-"}</span>
        </div>
        <div>
          <span className="k">Escrowed</span>
          <span className="v">{data ? formatGen(data.locked) + " GEN" : "-"}</span>
        </div>
        <div>
          <span className="k">Status</span>
          <span className="v">{data ? (data.paused ? "paused" : "live") : "-"}</span>
        </div>
      </div>

      <nav className="tabs">
        {[
          ["market", `Market (${market.length})`],
          ["mine", `My loans (${mine.length})`],
          ["create", "Lend"],
        ].map(([key, label]) => (
          <button key={key} className={tab === key ? "tab on" : "tab"} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </nav>

      {loadError && <div className="banner warn-b">{loadError}</div>}
      {!data && !loadError && <div className="empty">Loading loans...</div>}

      {data && tab === "market" && (
        <>
          {market.length === 0 && <div className="empty">No open offers yet. Create the first one.</div>}
          {shownMarket.map((l) => (
            <LoanCard key={l.id} loan={l} account={account} busy={busy} onAction={onAction} />
          ))}
        </>
      )}

      {data && tab === "mine" && (
        <>
          {!account && <div className="empty">Connect your wallet to see your loans.</div>}
          {account && mine.length === 0 && <div className="empty">You have no loans yet.</div>}
          {account && mine.length > 0 && (
            <>
              <div className="portfolio">
                <div><span className="k">Lent out</span><span className="v">{formatGen(pf.lent)} GEN</span></div>
                <div><span className="k">Interest to earn</span><span className="v">{formatGen(pf.earn)} GEN</span></div>
                <div><span className="k">You owe</span><span className="v">{formatGen(pf.owed)} GEN</span></div>
                <div><span className="k">Your collateral</span><span className="v">{formatGen(pf.locked)} GEN</span></div>
              </div>
              <div className="toolbar">
                <div className="chips">
                  {FILTERS.map((f) => (
                    <button key={f} className={filter === f ? "chip on" : "chip"} onClick={() => setFilter(f)}>{f}</button>
                  ))}
                </div>
                <select className="sort" value={sort} onChange={(e) => setSort(e.target.value)}>
                  <option value="new">Newest first</option>
                  <option value="amount">Largest first</option>
                </select>
              </div>
            </>
          )}
          {shownMine.map((l) => (
            <LoanCard key={l.id} loan={l} account={account} busy={busy} onAction={onAction} />
          ))}
        </>
      )}

      {tab === "create" && (
        <CreateOffer account={account} busy={busy} paused={data ? data.paused : false} onAction={onAction} />
      )}

      <footer>
        Contract{" "}
        <code>{short(CONTRACT_ADDRESS)}</code> &middot;{" "}
        <button className="link" onClick={refresh}>
          Refresh
        </button>
      </footer>
    </div>
  );
}

import { createClient } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

export const CONTRACT_ADDRESS =
  import.meta.env.VITE_CONTRACT_ADDRESS || "0x6894FDA554e72179E067057495706cAfd5691E33";
export const CHAIN = testnetBradbury;
export const ZERO = "0x0000000000000000000000000000000000000000";
export const GRACE_PERIOD = 600; // seconds, mirrors the contract constant

const readClient = createClient({ chain: CHAIN });

// ---------------------------------------------------------------------------
// decoding helpers: genlayer-js may return Map / bigint, the UI wants plain data
// ---------------------------------------------------------------------------

export function normalize(v) {
  if (v instanceof Map) {
    const o = {};
    for (const [k, val] of v.entries()) o[String(k)] = normalize(val);
    return o;
  }
  if (Array.isArray(v)) return v.map(normalize);
  if (typeof v === "bigint") return v.toString();
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = normalize(v[k]);
    return o;
  }
  return v;
}

// ---------------------------------------------------------------------------
// amounts
// ---------------------------------------------------------------------------

export function parseGen(input) {
  const t = String(input).trim();
  if (t === "" || t === "." || !/^\d*\.?\d*$/.test(t)) throw new Error("Invalid amount");
  const [w, f = ""] = t.split(".");
  const frac = (f + "0".repeat(18)).slice(0, 18);
  return BigInt(w || "0") * 10n ** 18n + BigInt(frac);
}

export function formatGen(wei, dp = 4) {
  const v = BigInt(wei);
  const w = v / 10n ** 18n;
  const f = (v % 10n ** 18n).toString().padStart(18, "0").slice(0, dp);
  return `${w}.${f}`.replace(/\.?0+$/, "") || "0";
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

async function read(functionName, args = []) {
  const res = await readClient.readContract({
    address: CONTRACT_ADDRESS,
    functionName,
    args,
  });
  return normalize(res);
}

export async function loadAll(limit = 60) {
  const count = Number(await read("get_loan_count"));
  const ids = [];
  for (let i = count; i >= 1 && ids.length < limit; i--) ids.push(i);
  const [loans, locked, paused] = await Promise.all([
    Promise.all(ids.map((id) => read("get_loan", [id]))),
    read("get_total_locked"),
    read("is_paused"),
  ]);
  return { count, loans, locked: String(locked), paused: Boolean(paused) };
}

// ---------------------------------------------------------------------------
// wallet
// ---------------------------------------------------------------------------

export function hasWallet() {
  return typeof window !== "undefined" && !!window.ethereum;
}

export async function getChainOk() {
  if (!hasWallet()) return false;
  const id = await window.ethereum.request({ method: "eth_chainId" });
  return parseInt(id, 16) === Number(CHAIN.id);
}

export async function ensureChain() {
  const chainId = "0x" + Number(CHAIN.id).toString(16);
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId }],
    });
  } catch (err) {
    // 4902 = chain not added yet (some wallets use -32603)
    if (err && (err.code === 4902 || err.code === -32603)) {
      const explorer = CHAIN.blockExplorers && CHAIN.blockExplorers.default;
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId,
            chainName: CHAIN.name,
            nativeCurrency: CHAIN.nativeCurrency,
            rpcUrls: CHAIN.rpcUrls.default.http,
            blockExplorerUrls: explorer && explorer.url ? [explorer.url] : undefined,
          },
        ],
      });
    } else {
      throw err;
    }
  }
}

export async function connectWallet() {
  if (!hasWallet()) throw new Error("No wallet found. Open this page in MetaMask's browser.");
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  await ensureChain();
  return accounts[0];
}

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------

export async function send(account, functionName, args, valueWei = 0n) {
  const client = createClient({ chain: CHAIN, account });
  const hash = await client.writeContract({
    address: CONTRACT_ADDRESS,
    functionName,
    args,
    value: valueWei,
  });
  const receipt = await client.waitForTransactionReceipt({
    hash,
    status: TransactionStatus.ACCEPTED,
    retries: 200,
    interval: 3000,
  });
  return { hash, receipt };
}

// Best effort: a transaction can be "accepted" by consensus while the contract
// call itself raised an error (state rolled back). The loan state read after the
// transaction is always the source of truth.
export function receiptFailed(receipt) {
  try {
    const s = JSON.stringify(receipt, (k, v) => (typeof v === "bigint" ? v.toString() : v));
    return /FINISHED_WITH_ERROR|"execution_result":"ERROR"/.test(s);
  } catch (e) {
    return false;
  }
}

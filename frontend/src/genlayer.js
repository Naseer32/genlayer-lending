import { createClient } from "genlayer-js";
import { testnetBradbury, studionet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

export const NETWORKS = {
  bradbury: {
    label: "Bradbury",
    chain: testnetBradbury,
    address: import.meta.env.VITE_CONTRACT_ADDRESS || "0x6894FDA554e72179E067057495706cAfd5691E33",
  },
  studionet: {
    label: "Studionet",
    chain: studionet,
    address: import.meta.env.VITE_STUDIONET_CONTRACT || "",
  },
};
export const ZERO = "0x0000000000000000000000000000000000000000";
export const GRACE_PERIOD = 600; // seconds, mirrors the contract constant

const readClients = {};
function readClient(net) {
  if (!readClients[net]) readClients[net] = createClient({ chain: NETWORKS[net].chain });
  return readClients[net];
}

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

async function read(net, functionName, args = []) {
  const res = await readClient(net).readContract({
    address: NETWORKS[net].address,
    functionName,
    args,
  });
  return normalize(res);
}

export async function loadAll(net, limit = 60) {
  const count = Number(await read(net, "get_loan_count"));
  const ids = [];
  for (let i = count; i >= 1 && ids.length < limit; i--) ids.push(i);
  const [loans, locked, paused] = await Promise.all([
    Promise.all(ids.map((id) => read(net, "get_loan", [id]))),
    read(net, "get_total_locked"),
    read(net, "is_paused"),
  ]);
  return { count, loans, locked: String(locked), paused: Boolean(paused) };
}

export function hasWallet() {
  return typeof window !== "undefined" && !!window.ethereum;
}

export async function getChainOk(net) {
  if (!hasWallet()) return false;
  const id = await window.ethereum.request({ method: "eth_chainId" });
  return parseInt(id, 16) === Number(NETWORKS[net].chain.id);
}

export async function ensureChain(net) {
  const chain = NETWORKS[net].chain;
  const chainId = "0x" + Number(chain.id).toString(16);
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (err) {
    if (err && (err.code === 4902 || err.code === -32603)) {
      const explorer = chain.blockExplorers && chain.blockExplorers.default;
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId,
            chainName: chain.name,
            nativeCurrency: chain.nativeCurrency,
            rpcUrls: chain.rpcUrls.default.http,
            blockExplorerUrls: explorer && explorer.url ? [explorer.url] : undefined,
          },
        ],
      });
    } else {
      throw err;
    }
  }
}

export async function connectWallet(net) {
  if (!hasWallet()) throw new Error("No wallet found. Open this page in MetaMask's browser.");
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  await ensureChain(net);
  return accounts[0];
}

// RPC nodes sometimes return a transient "unknown RPC error" while polling.
// Retry a few times before giving up (the transaction itself is already sent).
async function waitStatus(client, hash, status, retries, interval) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      return await client.waitForTransactionReceipt({ hash, status, retries, interval });
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  throw lastErr;
}

// Lifecycle: submitted (hash known) -> accepted by validators -> finalized.
// Returns after "accepted"; `finalized` is a promise that resolves later.
export async function send(net, account, functionName, args, valueWei = 0n, onSubmitted = () => {}) {
  const client = createClient({ chain: NETWORKS[net].chain, account });
  const hash = await client.writeContract({
    address: NETWORKS[net].address,
    functionName,
    args,
    value: valueWei,
  });
  onSubmitted(hash);
  const receipt = await waitStatus(client, hash, TransactionStatus.ACCEPTED, 100, 3000);
  const finalized = waitStatus(client, hash, TransactionStatus.FINALIZED, 300, 5000);
  return { hash, receipt, finalized };
}

export function receiptFailed(receipt) {
  try {
    const s = JSON.stringify(receipt, (k, v) => (typeof v === "bigint" ? v.toString() : v));
    return /FINISHED_WITH_ERROR|"execution_result":"ERROR"/.test(s);
  } catch (e) {
    return false;
  }
}

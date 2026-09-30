import { useEffect, useMemo, useState } from "react";
import { useAddFunds, useSendTransaction, useWallets } from "@privy-io/react-auth";
import { useSignAndSendTransaction, useWallets as useSolanaWallets } from "@privy-io/react-auth/solana";
import { encodeFunctionData, erc20Abi, parseUnits } from "viem";
import {
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase58Decoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { findAssociatedTokenPda, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { api, type Config } from "./api";
import type { Session } from "./App";

const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const usd = (n: number) => `$${n.toFixed(2)}`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

interface Asset {
  symbol: string;
  address?: string;
  decimals: number;
  native: boolean;
}
interface Chain {
  id: string;
  name: string;
  chainId?: number;
  treasury: string;
  assets: Asset[];
  explorerTx: string;
}

/** PAI: the network's reward unit, earned by running nodes and by teaching DSI new knowledge. */
function PaiPanel() {
  const [pai, setPai] = useState<{ balance: number; staked: number }>();
  const [learn, setLearn] = useState<{ rewards: { total_paid: number; deferred: number; events: Array<{ id: string; kind: string; amount: number; status: string; created_at: string; learning_object?: string }> }; objects: Array<{ state: string }> }>();
  useEffect(() => {
    const load = () => {
      api("/pai").then(setPai).catch(() => {});
      api("/learning/me").then(setLearn).catch(() => {});
    };
    load();
    // Rewards from voice teaching arrive while this page may be open.
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);
  const fmt = (n: number) => n.toLocaleString("en", { maximumFractionDigits: n < 1 ? 4 : 2 });
  const pending = learn?.objects.filter((o) => o.state === "PROVISIONAL").length ?? 0;
  return (
    <>
      <div className="grid3">
        <section className="card">
          <div className="muted small">PAI balance</div>
          <div className="big">{pai ? `${fmt(pai.balance)} PAI` : "…"}</div>
          <p className="fine muted">Earned by running a node and by teaching DSI knowledge it did not have. {pai?.staked ? `${fmt(pai.staked)} PAI staked.` : ""}</p>
        </section>
        <section className="card">
          <div className="muted small">Earned by teaching</div>
          <div className="big">{learn ? `${fmt(learn.rewards.total_paid)} PAI` : "…"}</div>
          <p className="fine muted">
            Paid when what you teach is verified as new. Talk to DSI and teach it something: a reward sound plays when it pays.
            {learn?.rewards.deferred ? ` ${fmt(learn.rewards.deferred)} PAI is waiting for next epoch's budget.` : ""}
          </p>
        </section>
        <section className="card">
          <div className="muted small">Waiting for validators</div>
          <div className="big">{learn ? pending : "…"}</div>
          <p className="fine muted">New knowledge you taught that independent validators still have to confirm; it earns PAI once they do.</p>
        </section>
      </div>
      {!!learn?.rewards.events.length && (
        <section className="card" style={{ marginBottom: 14 }}>
          <h2>Recent PAI rewards</h2>
          <div className="tbl">
            <table className="data">
              <thead>
                <tr>
                  <th>When</th>
                  <th>For</th>
                  <th className="n">PAI</th>
                </tr>
              </thead>
              <tbody>
                {learn.rewards.events.slice(0, 10).map((e) => (
                  <tr key={e.id}>
                    <td>{new Date(e.created_at).toLocaleString()}</td>
                    <td>{e.kind === "verify" ? "Knowledge you taught, verified" : e.kind === "improve" ? "Your knowledge improved a model" : e.kind === "usage" ? "Your knowledge used by a model" : e.kind}{e.status === "deferred" ? " (next epoch)" : ""}</td>
                    <td className="n">+{fmt(e.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

export function Wallet({ role, config, session }: { role: string; config: Config; session: Session }) {
  const canPay = ["owner", "admin", "billing"].includes(role);
  const [billing, setBilling] = useState<any>();
  const [err, setErr] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [chainId, setChainId] = useState("base");
  const [assetSym, setAssetSym] = useState("USDC");
  const [amountUsd, setAmountUsd] = useState("10");
  const [checkoutUsd, setCheckoutUsd] = useState("25");
  const [busy, setBusy] = useState(false);
  const { wallets } = useWallets();
  const { wallets: solWallets } = useSolanaWallets();
  const { sendTransaction } = useSendTransaction();
  const { signAndSendTransaction } = useSignAndSendTransaction();
  const { addFunds } = useAddFunds();

  const load = () =>
    api("/billing")
      .then(setBilling)
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load();
    if (location.hash.includes("paid=1")) setStatus("Thanks — your checkout payment is being confirmed; credit appears once the network confirms it.");
  }, []);

  const evmWallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
  const solWallet = solWallets[0];
  const chains: Chain[] = billing?.chains ?? [];
  const chain = chains.find((c) => c.id === chainId) ?? chains[0];
  const asset = chain?.assets.find((a) => a.symbol === assetSym) ?? chain?.assets[0];
  const tokenAmount = useMemo(() => {
    const n = Number(amountUsd);
    if (!asset || !(n > 0)) return undefined;
    if (!asset.native) return n.toFixed(Math.min(asset.decimals, 6));
    const price = billing?.prices?.[asset.symbol];
    return price ? (n / price).toFixed(8) : undefined;
  }, [amountUsd, asset, billing]);

  /** Submit the transaction for verification; retry while it confirms. */
  const claim = async (chain: string, txHash: string) => {
    for (let i = 0; i < 40; i++) {
      const r = await api("/billing/deposits", { body: { chain, txHash } });
      if (r.deposit) {
        setStatus(r.credited ? `Credited ${usd(r.deposit.usdValue)} (${r.deposit.amount} ${r.deposit.token}).` : r.note ?? "Already credited.");
        load();
        return;
      }
      setStatus(`Waiting for confirmations${r.confirmations ? ` (${r.confirmations})` : ""}…`);
      await new Promise((res) => setTimeout(res, 6000));
    }
    setStatus(`Still confirming. Your transaction is ${txHash}; it will be credited when you reopen this page and resubmit.`);
  };

  const pay = async () => {
    if (!chain || !asset || !tokenAmount) return;
    setErr(undefined);
    setBusy(true);
    try {
      if (chain.id === "solana") {
        if (!solWallet) throw new Error("No Solana wallet on this account");
        const from = address(solWallet.address);
        const signer = createNoopSigner(from);
        let ix;
        if (asset.native) {
          ix = getTransferSolInstruction({ source: signer, destination: address(chain.treasury), amount: BigInt(Math.round(Number(tokenAmount) * 1e9)) });
        } else {
          const mint = address(asset.address!);
          const [src] = await findAssociatedTokenPda({ mint, owner: from, tokenProgram: TOKEN_PROGRAM_ADDRESS });
          const [dst] = await findAssociatedTokenPda({ mint, owner: address(chain.treasury), tokenProgram: TOKEN_PROGRAM_ADDRESS });
          ix = getTransferCheckedInstruction({ source: src, mint, destination: dst, authority: signer, amount: parseUnits(tokenAmount, asset.decimals), decimals: asset.decimals });
        }
        const msg = pipe(
          createTransactionMessage({ version: 0 }),
          (m) => setTransactionMessageFeePayer(from, m),
          // Privy fills in a fresh blockhash when given this placeholder.
          (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 0n }, m),
          (m) => appendTransactionMessageInstruction(ix, m),
        );
        const tx = new Uint8Array(getTransactionEncoder().encode(compileTransaction(msg)));
        setStatus("Confirm the payment in your wallet…");
        const { signature } = await signAndSendTransaction({ transaction: tx, wallet: solWallet });
        await claim("solana", getBase58Decoder().decode(signature));
      } else {
        if (!evmWallet) throw new Error("No Ethereum wallet on this account");
        const request = asset.native
          ? { to: chain.treasury as `0x${string}`, value: parseUnits(tokenAmount, 18), chainId: chain.chainId }
          : { to: asset.address as `0x${string}`, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [chain.treasury as `0x${string}`, parseUnits(tokenAmount, asset.decimals)] }), chainId: chain.chainId };
        setStatus("Confirm the payment in your wallet…");
        const { hash } = await sendTransaction(request, { address: evmWallet.address });
        await claim(chain.id, hash);
      }
    } catch (e) {
      setErr((e as Error).message);
      setStatus(undefined);
    } finally {
      setBusy(false);
    }
  };

  const topUp = async (method: "crypto" | "fiat") => {
    if (!evmWallet) return setErr("No Ethereum wallet on this account");
    setErr(undefined);
    try {
      // Privy converts almost any coin (or card payment) into USDC on Base in your own wallet.
      await addFunds(method === "crypto" ? { destination: { address: evmWallet.address, chain: "eip155:8453", asset: BASE_USDC }, crypto: {} } : { destination: { address: evmWallet.address, chain: "eip155:8453", asset: BASE_USDC }, fiat: {} });
      setChainId("base");
      setAssetSym("USDC");
      setStatus("Funds are on their way to your wallet. Then pay credit below with USDC on Base.");
    } catch (e) {
      setErr((e as Error).message || "Funding was cancelled");
    }
  };

  const checkout = async () => {
    try {
      const r = await api("/billing/checkout", { body: { amountUsd: Number(checkoutUsd) } });
      location.href = r.url;
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const payOpen = config.deposits.evm || config.deposits.solana || config.checkout;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Credits &amp; wallet</h1>
      </div>
      <PaiPanel />
      <div className="grid3">
        <section className="card">
          <div className="muted small">Credit balance</div>
          <div className="big">{billing ? usd(billing.creditUsd) : "…"}</div>
          <p className="fine muted">Pays for network models and platform access to commercial models. Your own vendor keys are billed by the vendor.</p>
        </section>
        <section className="card">
          <div className="muted small">Your wallets</div>
          {evmWallet && (
            <div className="row small">
              <span>EVM</span> <code title={evmWallet.address}>{short(evmWallet.address)}</code>
              <button className="link" onClick={() => navigator.clipboard.writeText(evmWallet.address)}>
                Copy
              </button>
            </div>
          )}
          {solWallet && (
            <div className="row small">
              <span>Solana</span> <code title={solWallet.address}>{short(solWallet.address)}</code>
              <button className="link" onClick={() => navigator.clipboard.writeText(solWallet.address)}>
                Copy
              </button>
            </div>
          )}
          {!evmWallet && !solWallet && <p className="small muted">Creating your wallet…</p>}
          <p className="fine muted">Self-custodial wallets created by Privy on sign-in. Only you can move funds from them.</p>
        </section>
        {payOpen ? (
          <section className="card">
            <div className="muted small">Add funds to your wallet</div>
            <div className="row wrap">
              <button onClick={() => topUp("crypto")}>Any crypto</button>
              <button onClick={() => topUp("fiat")}>Card / bank</button>
            </div>
            <p className="fine muted">Send BTC, ETH, SOL, stablecoins and more from any chain; it arrives as USDC on Base.</p>
          </section>
        ) : (
          <section className="card">
            <div className="muted small">Top-ups</div>
            <p className="small">Credit top-ups aren't open yet, so there is no need to fund your wallet for this service.</p>
            <p className="fine muted">Until they open, connect your own provider keys in Console → Providers, or run a node for free network chat.</p>
          </section>
        )}
      </div>

      {!canPay && <p className="note">Only owners, admins and billing members can add credit to this organisation.</p>}

      {canPay && (
        <section className="card">
          <h2>Pay for AI with crypto</h2>
          {chains.length === 0 ? (
            <p className="muted small">Direct wallet deposits are not enabled on this deployment yet{config.checkout ? "; use the any-coin checkout below." : "."}</p>
          ) : (
            <>
              <div className="grid4">
                <label>
                  Network
                  <select
                    value={chain?.id}
                    onChange={(e) => {
                      setChainId(e.target.value);
                      setAssetSym(chains.find((c) => c.id === e.target.value)?.assets[0].symbol ?? "");
                    }}
                  >
                    {chains.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Asset
                  <select value={asset?.symbol} onChange={(e) => setAssetSym(e.target.value)}>
                    {chain?.assets.map((a) => (
                      <option key={a.symbol}>{a.symbol}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Amount (USD)
                  <input type="number" min={billing?.minDepositUsd ?? 1} step="1" value={amountUsd} onChange={(e) => setAmountUsd(e.target.value)} />
                </label>
                <label>
                  You send
                  <input readOnly value={tokenAmount ? `${tokenAmount} ${asset?.symbol}` : "—"} />
                </label>
              </div>
              <div className="row">
                <button className="primary" disabled={busy || !tokenAmount} onClick={pay}>
                  {busy ? "Working…" : `Pay ${usd(Number(amountUsd) || 0)} from my wallet`}
                </button>
                <span className="fine muted">
                  To <code>{chain && short(chain.treasury)}</code> on {chain?.name}. Credited after confirmation, only from wallets linked to your account.
                </span>
              </div>
            </>
          )}
          {status && <p className="small">{status}</p>}
          {err && <p className="err small">{err}</p>}
        </section>
      )}

      {canPay && config.checkout && (
        <section className="card">
          <h2>Pay with any other coin</h2>
          <p className="small muted">BTC, LTC, DOGE, XMR, TON, TRX and 300+ more through a hosted checkout. Credit is added when the payment finishes.</p>
          <div className="row">
            <input type="number" min="1" value={checkoutUsd} onChange={(e) => setCheckoutUsd(e.target.value)} aria-label="Amount in USD" />
            <button className="primary" onClick={checkout}>
              Continue to checkout
            </button>
          </div>
        </section>
      )}

      <section className="card">
        <h2>Payment history</h2>
        <div className="tbl">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Method</th>
                <th>Asset</th>
                <th>Amount</th>
                <th>Credit</th>
                <th>Transaction</th>
              </tr>
            </thead>
            <tbody>
              {(billing?.deposits ?? []).map((d: any) => {
                const [ch, hash] = String(d.txHash ?? "").split(":");
                const explorer = chains.find((c) => c.id === ch)?.explorerTx;
                return (
                  <tr key={d.id}>
                    <td>{new Date(d.createdAt).toLocaleString()}</td>
                    <td>{d.method === "onchain" ? d.chain : d.method}</td>
                    <td>{d.token}</td>
                    <td>{d.amount}</td>
                    <td>{usd(d.usdValue)}</td>
                    <td>{hash ? explorer ? <a href={`${explorer}${hash}`} target="_blank" rel="noreferrer">{short(hash)}</a> : <code>{short(hash)}</code> : d.reference ?? "—"}</td>
                  </tr>
                );
              })}
              {billing && billing.deposits.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    No payments yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      <p className="fine muted">Signed in as {session.user.email ?? session.user.wallets[0]?.address}. Wallet addresses linked to your account: {session.user.wallets.map((w) => short(w.address)).join(", ") || "none yet"}.</p>
    </div>
  );
}

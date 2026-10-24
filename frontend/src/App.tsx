import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BrowserProvider,
  Contract,
  JsonRpcProvider,
  ZeroHash,
  encodeBytes32String,
  getAddress,
  id,
} from "ethers";
import type {
  ChainReservation,
  DashboardData,
  Deployment,
  ObligationAllocation,
  StressResult,
} from "./types";

const API_URL = "http://127.0.0.1:8000";
const LOCAL_CHAIN_ID = 31_337;

interface InjectedWallet {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: InjectedWallet;
  }
}

interface Activity {
  id: string;
  time: string;
  kind: "success" | "error" | "info";
  title: string;
  detail: string;
  hash?: string;
}

function contractRevertReason(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { reason?: unknown; shortMessage?: unknown; message?: unknown };
    if (typeof candidate.reason === "string") return candidate.reason;
    if (typeof candidate.shortMessage === "string") return candidate.shortMessage;
    if (typeof candidate.message === "string") {
      const match = candidate.message.match(/reason="([^"]+)"/);
      return match?.[1] ?? candidate.message;
    }
  }
  return "Unknown contract error.";
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const errorBody = body as { error?: { message?: string } } | null;
    throw new Error(errorBody?.error?.message ?? `API request failed (${response.status}).`);
  }
  return body as T;
}

function dollars(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatBps(bps: number): string {
  const sign = bps > 0 ? "+" : "";
  return `${sign}${(bps / 100).toFixed(2)}%`;
}

function activityItem(
  kind: Activity["kind"],
  title: string,
  detail: string,
  hash?: string,
): Activity {
  return {
    id: crypto.randomUUID(),
    time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    kind,
    title,
    detail,
    hash,
  };
}

export default function App() {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [reservations, setReservations] = useState<Record<string, ChainReservation>>({});
  const [walletAddress, setWalletAddress] = useState("");
  const [stress, setStress] = useState<StressResult | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [localRole, setLocalRole] = useState<"pledgor" | "counterparty">("pledgor");
  const [connectedLocalRole, setConnectedLocalRole] = useState<"pledgor" | "counterparty" | null>(null);
  const [signingMode, setSigningMode] = useState<"wallet" | "local">("wallet");
  const [pendingObligation, setPendingObligation] = useState("");
  const [runningStress, setRunningStress] = useState(false);
  const [runningRejection, setRunningRejection] = useState("");
  const [apiError, setApiError] = useState("");
  const [deploymentError, setDeploymentError] = useState("");
  const [chainError, setChainError] = useState("");
  const [actionError, setActionError] = useState("");

  const appendActivity = useCallback((item: Activity) => {
    setActivity((current) => [item, ...current].slice(0, 12));
  }, []);

  const refreshDashboard = useCallback(async () => {
    setRefreshing(true);
    setApiError("");
    try {
      const result = await apiRequest<DashboardData>("/api/v1/dashboard");
      setDashboard(result);
      setStress(result.stress);
      setApiError("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to load the API result.";
      setApiError(message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const refreshDeployment = useCallback(async () => {
    setDeploymentError("");
    try {
      const result = await apiRequest<Deployment>("/api/v1/deployment");
      setDeployment(result);
    } catch (error) {
      setDeployment(null);
      setDeploymentError(error instanceof Error ? error.message : "Deployment metadata is unavailable.");
    }
  }, []);

  const refreshChainState = useCallback(async () => {
    if (!deployment || !dashboard) return;
    setChainError("");
    try {
      const provider = new JsonRpcProvider("http://127.0.0.1:8545");
      const network = await provider.getNetwork();
      if (network.chainId !== BigInt(deployment.chain_id)) {
        throw new Error(`Connected to chain ${network.chainId}; expected local chain ${deployment.chain_id}.`);
      }
      const contract = new Contract(deployment.address, deployment.abi, provider);
      const results = await Promise.all(
        dashboard.optimized.obligations.map(async (obligation) => {
          const reservationId: string = await contract.activeReservationForObligation(
            encodeBytes32String(obligation.id),
          );
          if (reservationId === ZeroHash) {
            return [obligation.id, { reservationId, status: "none" as const }] as const;
          }
          const record = await contract.reservation(reservationId);
          const state = Number(record.status);
          const status = state === 1 ? "active" : state === 2 ? "released" : "expired";
          return [
            obligation.id,
            { reservationId, status, expiresAt: Number(record.expiresAt) } as ChainReservation,
          ] as const;
        }),
      );
      setReservations(Object.fromEntries(results));
      setChainError("");
    } catch (error) {
      setChainError(error instanceof Error ? error.message : "Local chain is unavailable.");
    }
  }, [dashboard, deployment]);

  useEffect(() => {
    void refreshDashboard();
    void refreshDeployment();
  }, [refreshDashboard, refreshDeployment]);

  useEffect(() => {
    void refreshChainState();
  }, [refreshChainState]);

  useEffect(() => {
    const wallet = window.ethereum;
    if (!wallet?.on) return;
    const onAccountsChanged = (accounts: unknown) => {
      const list = Array.isArray(accounts) ? accounts : [];
      setWalletAddress(typeof list[0] === "string" ? list[0] : "");
      setSigningMode("wallet");
      void refreshChainState();
    };
    const onChainChanged = () => void refreshChainState();
    wallet.on("accountsChanged", onAccountsChanged);
    wallet.on("chainChanged", onChainChanged);
    return () => {
      wallet.removeListener?.("accountsChanged", onAccountsChanged);
      wallet.removeListener?.("chainChanged", onChainChanged);
    };
  }, [refreshChainState]);

  const savingsPercent = dashboard ? (dashboard.savings_bps / 100).toFixed(2) : "—";
  const allocationRows = useMemo(
    () => dashboard?.optimized.obligations ?? [],
    [dashboard],
  );

  async function connectWallet(): Promise<void> {
    setActionError("");
    try {
      const injected = window.ethereum;
      if (!injected) throw new Error("Install a browser wallet and connect it to the local Hardhat network.");
      try {
        await injected.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x7a69" }],
        });
      } catch (error) {
        const walletError = error as { code?: number };
        if (walletError.code !== 4902) throw error;
        await injected.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: "0x7a69",
              chainName: "Hardhat Local Simulation",
              rpcUrls: ["http://127.0.0.1:8545"],
              nativeCurrency: { name: "Test Ether", symbol: "ETH", decimals: 18 },
            },
          ],
        });
      }
      const provider = new BrowserProvider(injected);
      const [address] = await provider.send("eth_requestAccounts", []);
      setWalletAddress(address);
      setSigningMode("wallet");
      setConnectedLocalRole(null);
      appendActivity(activityItem("success", "Wallet connected", `${shortAddress(address)} · local chain 31337`));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wallet connection failed.";
      setActionError(message);
      appendActivity(activityItem("error", "Wallet connection rejected", message));
    }
  }

  async function connectLocalSigner(): Promise<void> {
    setActionError("");
    try {
      if (!deployment) throw new Error("Local deployment metadata is unavailable.");
      const provider = new JsonRpcProvider("http://127.0.0.1:8545");
      const network = await provider.getNetwork();
      if (network.chainId !== BigInt(LOCAL_CHAIN_ID)) throw new Error("Local Hardhat chain is unavailable.");
      const target = localRole === "pledgor" ? deployment.pledgor : deployment.counterparty;
      const signer = await provider.getSigner(target);
      const address = await signer.getAddress();
      setWalletAddress(address);
      setSigningMode("local");
      setConnectedLocalRole(localRole);
      appendActivity(
        activityItem("success", "Local demo signer connected", `${localRole} · ${shortAddress(address)}`),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to connect the local demo signer.";
      setActionError(message);
      appendActivity(activityItem("error", "Local demo signer unavailable", message));
    }
  }

  async function runStressScenario(): Promise<void> {
    setRunningStress(true);
    setActionError("");
    try {
      const result = await apiRequest<StressResult>("/api/v1/stress", {
        method: "POST",
        body: JSON.stringify({ shocks_bps: { CASH: 0, UST: -1_500, CORP: -2_500 } }),
      });
      setStress(result);
      appendActivity(
        activityItem(
          "success",
          "Stress simulation completed",
          `Shortfall ${dollars(result.total_shortfall_cents)} · ${
            result.top_up_feasible ? `top-up ${dollars(result.top_up_cost_cents)}` : "top-up infeasible"
          }`,
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Stress request failed.";
      setActionError(message);
      appendActivity(activityItem("error", "Stress simulation rejected", message));
    } finally {
      setRunningStress(false);
    }
  }

  async function testLiveRejection(
    kind: "already-reserved" | "ineligible" | "expired",
    obligation: ObligationAllocation,
  ): Promise<void> {
    if (!deployment || !dashboard) {
      setActionError("Local contract and API data are required for rejection checks.");
      return;
    }
    setRunningRejection(kind);
    setActionError("");
    const expectedReason =
      kind === "already-reserved"
        ? "obligation already reserved"
        : kind === "ineligible"
          ? "ineligible collateral"
          : "obligation expired";
    let snapshotId: string | null = null;
    try {
      const provider = new JsonRpcProvider("http://127.0.0.1:8545");
      const network = await provider.getNetwork();
      if (network.chainId !== BigInt(deployment.chain_id)) throw new Error("Local Hardhat chain is unavailable.");
      const pledgor = await provider.getSigner(deployment.pledgor);
      const counterparty = await provider.getSigner(deployment.counterparty);
      const pledgorContract = new Contract(deployment.address, deployment.abi, pledgor);
      let rejectedReason = "";

      if (kind === "already-reserved") {
        if (reservations[obligation.id]?.status !== "active") {
          throw new Error("Reserve this obligation first; the duplicate-collateral check requires an active reservation.");
        }
        try {
          await pledgorContract.reserveBatch.staticCall(
            id(`duplicate-check:${crypto.randomUUID()}`),
            encodeBytes32String(obligation.id),
            obligation.allocations.map((line) => ({
              assetId: encodeBytes32String(line.asset),
              quantity: BigInt(line.quantity),
            })),
            BigInt(deployment.configuration_version),
          );
        } catch (error) {
          rejectedReason = contractRevertReason(error);
        }
      } else if (kind === "ineligible") {
        const unacceptedAsset = dashboard.assets.find(
          (asset) => !asset.eligible_obligations.includes(obligation.id),
        );
        if (!unacceptedAsset) throw new Error(`No unaccepted asset is configured for ${obligation.id}.`);
        try {
          await pledgorContract.reserveBatch.staticCall(
            id(`eligibility-check:${crypto.randomUUID()}`),
            encodeBytes32String(obligation.id),
            [{ assetId: encodeBytes32String(unacceptedAsset.symbol), quantity: 1n }],
            BigInt(deployment.configuration_version),
          );
        } catch (error) {
          rejectedReason = contractRevertReason(error);
        }
      } else {
        snapshotId = await provider.send("evm_snapshot", []);
        const block = await provider.getBlock("latest");
        if (!block) throw new Error("Unable to read the local chain clock.");
        const expiryId = encodeBytes32String(`EXP-${crypto.randomUUID().slice(0, 25)}`);
        const acceptedAsset = encodeBytes32String("CASH");
        const createTx = await new Contract(deployment.address, deployment.abi, counterparty)
          .createObligation(expiryId, 1_000, block.timestamp + 5, [acceptedAsset]);
        await createTx.wait();
        await provider.send("evm_increaseTime", [6]);
        await provider.send("evm_mine", []);
        try {
          await pledgorContract.reserveBatch.staticCall(
            id(`expiry-check:${crypto.randomUUID()}`),
            expiryId,
            [{ assetId: acceptedAsset, quantity: 1n }],
            BigInt(await pledgorContract.configurationVersion()),
          );
        } catch (error) {
          rejectedReason = contractRevertReason(error);
        }
      }

      if (!rejectedReason.toLowerCase().includes(expectedReason)) {
        throw new Error(
          rejectedReason
            ? `Unexpected contract rejection: ${rejectedReason}`
            : `Contract accepted a request that should have been rejected (${expectedReason}).`,
        );
      }
      appendActivity(
        activityItem(
          "success",
          `Live rejection confirmed · ${kind}`,
          `Contract rejected the request: ${rejectedReason}. No transaction hash is shown because the call was rejected before broadcast.`,
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Live rejection check failed.";
      setActionError(message);
      appendActivity(activityItem("error", `Rejection check failed · ${kind}`, message));
    } finally {
      if (snapshotId !== null) {
        try {
          const reverted = await new JsonRpcProvider("http://127.0.0.1:8545").send("evm_revert", [snapshotId]);
          if (!reverted) throw new Error("Local expiry-test snapshot could not be restored.");
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to restore the local chain snapshot.";
          setActionError(message);
          appendActivity(activityItem("error", "Expiry demo cleanup failed", message));
        }
      }
      setRunningRejection("");
      await refreshChainState();
    }
  }

  async function performReservation(obligation: ObligationAllocation): Promise<void> {
    if (!deployment || (signingMode !== "local" && !window.ethereum)) {
      setActionError("Deploy the local contract and connect a wallet or local demo signer first.");
      return;
    }
    setPendingObligation(obligation.id);
    setActionError("");
    let transactionHash: string | undefined;
    try {
      const currentReservation = reservations[obligation.id];
      const isExpired =
        currentReservation?.status === "active" &&
        currentReservation.expiresAt !== undefined &&
        currentReservation.expiresAt <= Math.floor(Date.now() / 1000);
      const isRelease = currentReservation?.status === "active" && !isExpired;
      const provider =
        signingMode === "local"
          ? new JsonRpcProvider("http://127.0.0.1:8545")
          : window.ethereum
            ? new BrowserProvider(window.ethereum)
            : null;
      if (!provider) throw new Error("Connect a browser wallet or choose a local demo signer.");
      const network = await provider.getNetwork();
      if (network.chainId !== BigInt(LOCAL_CHAIN_ID)) {
        throw new Error("Switch the wallet to the local Hardhat chain (31337).");
      }
      const signer =
        signingMode === "local"
          ? await provider.getSigner(walletAddress)
          : await provider.getSigner();
      const signerAddress = await signer.getAddress();
      if (!isRelease && !isExpired && getAddress(signerAddress) !== getAddress(deployment.pledgor)) {
        throw new Error(`Reserve requires the pledgor account ${shortAddress(deployment.pledgor)}.`);
      }
      if (isRelease && getAddress(signerAddress) !== getAddress(deployment.counterparty)) {
        throw new Error(`Release requires the counterparty account ${shortAddress(deployment.counterparty)}.`);
      }

      const contract = new Contract(deployment.address, deployment.abi, signer);
      const tx = isExpired
        ? await contract.expire(currentReservation.reservationId)
        : isRelease
        ? await contract.release(currentReservation.reservationId)
        : await contract.reserveBatch(
            id(`${obligation.id}:${crypto.randomUUID()}`),
            encodeBytes32String(obligation.id),
            obligation.allocations.map((line) => ({
              assetId: encodeBytes32String(line.asset),
              quantity: BigInt(line.quantity),
            })),
            BigInt(deployment.configuration_version),
          );
      transactionHash = tx.hash;
      const actionName = isExpired ? "Expiry cleanup" : isRelease ? "Release" : "Reservation";
      appendActivity(activityItem("info", `${actionName} submitted`, tx.hash, tx.hash));
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error("The local-chain transaction reverted.");
      appendActivity(
        activityItem(
          "success",
          isExpired
            ? "Reservation expired on local chain"
            : isRelease
            ? "Reservation released on local chain"
            : "Collateral reserved on local chain",
          `${obligation.id} · block ${receipt.blockNumber}`,
          receipt.hash,
        ),
      );
      await refreshChainState();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Local-chain transaction failed.";
      setActionError(message);
      appendActivity(
        activityItem(
          "error",
          transactionHash ? "Local-chain transaction failed" : "Reservation request rejected",
          `${message}${transactionHash ? ` · ${transactionHash}` : ""}`,
          transactionHash,
        ),
      );
      await refreshChainState();
    } finally {
      setPendingObligation("");
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Collatrix home">
          <span className="brand-mark">C</span>
          <span>collatrix<span className="brand-period">.</span></span>
        </a>
        <div className="topbar-right">
          <span className="environment"><span className="pulse-dot" />SIMULATION ENVIRONMENT</span>
          <label className="role-select-label">
            <span className="sr-only">Local demo role</span>
            <select
              aria-label="Local demo role"
              value={localRole}
              onChange={(event) => setLocalRole(event.target.value as "pledgor" | "counterparty")}
            >
              <option value="pledgor">Demo pledgor</option>
              <option value="counterparty">Demo counterparty</option>
            </select>
          </label>
          <button className="demo-button" onClick={() => void connectLocalSigner()}>
            {signingMode === "local" && connectedLocalRole
              ? `Local ${connectedLocalRole} · ${shortAddress(walletAddress)}`
              : "Use local demo account"}
          </button>
          <button className="wallet-button" onClick={() => void connectWallet()}>
            <span className="wallet-icon">◈</span>
            {walletAddress && signingMode === "wallet" ? shortAddress(walletAddress) : "Connect wallet"}
          </button>
        </div>
      </header>

      <main className="page-content">
        <section className="page-heading">
          <div>
            <div className="eyebrow">COLLATERAL OPERATIONS <span>/</span> OVERVIEW</div>
            <h1>Collateral desk</h1>
            <p className="page-subtitle">Optimize allocations, monitor exposure, and manage local reservations.</p>
          </div>
          <button className="refresh-button" onClick={() => void refreshDashboard()} disabled={refreshing}>
            <span className={refreshing ? "refresh-symbol spinning" : "refresh-symbol"}>↻</span>
            {refreshing ? "Refreshing" : "Refresh data"}
          </button>
        </section>

        {(apiError || deploymentError || chainError || actionError) && (
          <section className="notice-stack" aria-live="polite">
            {apiError && <div className="notice error"><strong>API unavailable</strong><span>{apiError}</span></div>}
            {deploymentError && <div className="notice warning"><strong>Contract not ready</strong><span>{deploymentError}</span></div>}
            {chainError && <div className="notice warning"><strong>Local chain unavailable</strong><span>{chainError}</span></div>}
            {actionError && <div className="notice error"><strong>Action needs attention</strong><span>{actionError}</span></div>}
          </section>
        )}

        <section className="metrics-grid" aria-label="Portfolio summary">
          <article className="metric-card">
            <div className="metric-label">OPTIMIZED FUNDING COST <span className="metric-icon">↘</span></div>
            <div className="metric-value">{loading ? "…" : dollars(dashboard?.optimized.total_funding_cost_cents)}</div>
            <div className="metric-foot">Integer-cent optimizer result</div>
          </article>
          <article className="metric-card">
            <div className="metric-label">SAVINGS VS. GREEDY <span className="metric-icon green">✳</span></div>
            <div className="metric-value green">{loading ? "…" : dollars(dashboard?.savings_cents)}</div>
            <div className="metric-foot">
              {dashboard ? `${savingsPercent}% · calculated from same inventory` : "Comparison pending"}
            </div>
          </article>
          <article className="metric-card">
            <div className="metric-label">OBLIGATIONS <span className="metric-icon">▤</span></div>
            <div className="metric-value">{loading ? "…" : dashboard?.optimized.obligations.length ?? "—"}</div>
            <div className="metric-foot">Active simulation portfolio</div>
          </article>
          <article className="metric-card">
            <div className="metric-label">STRESS SHORTFALL <span className="metric-icon amber">⌁</span></div>
            <div className="metric-value">{stress ? dollars(stress.total_shortfall_cents) : "—"}</div>
            <div className="metric-foot">Default price-shock scenario</div>
          </article>
        </section>

        <section className="content-grid">
          <article className="panel allocation-panel">
            <div className="panel-heading">
              <div>
                <div className="section-kicker">OPTIMIZATION OUTPUT</div>
                <h2>Recommended allocation</h2>
              </div>
              <span className="live-tag"><span />LIVE API DATA</span>
            </div>
            {loading ? (
              <div className="empty-state">Loading allocation from the Collatrix API…</div>
            ) : allocationRows.length === 0 ? (
              <div className="empty-state">No allocation is available.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>OBLIGATION</th>
                      <th>REQUIRED</th>
                      <th>ALLOCATED COLLATERAL</th>
                      <th>FUNDING COST</th>
                      <th>ON-CHAIN STATUS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allocationRows.map((obligation) => {
                      const chainState = reservations[obligation.id];
                      const isActive = chainState?.status === "active";
                      const isExpired =
                        isActive &&
                        chainState.expiresAt !== undefined &&
                        chainState.expiresAt <= Math.floor(Date.now() / 1000);
                      const pending = pendingObligation === obligation.id;
                      return (
                        <tr key={obligation.id}>
                          <td>
                            <span className="obligation-name">{obligation.name}</span>
                            <span className="table-subtext">{obligation.id}</span>
                            <span className="table-subtext">
                              Accepted {dashboard?.assets
                                .filter((asset) => asset.eligible_obligations.includes(obligation.id))
                                .map((asset) => asset.symbol)
                                .join(" · ") || "none"}
                            </span>
                          </td>
                          <td className="numeric">{dollars(obligation.requirement_cents)}</td>
                          <td>
                            <div className="collateral-lines">
                              {obligation.allocations.map((line) => (
                                <div className="allocation-explanation" key={line.asset}>
                                  <span>{line.quantity} × {line.asset}</span>
                                  <small>{line.explanation}</small>
                                </div>
                              ))}
                            </div>
                            <span className="table-subtext">{dollars(obligation.credited_collateral_cents)} credited</span>
                          </td>
                          <td className="numeric">{dollars(obligation.funding_cost_cents)}</td>
                          <td>
                            <div className="reservation-cell">
                              <span className={`status-pill ${isActive ? "status-active" : "status-idle"}`}>
                                <span />{isActive ? (isExpired ? "Expired · cleanup needed" : "Reserved") : "Not reserved"}
                              </span>
                              {isActive && chainState?.expiresAt && (
                                <span className="table-subtext">
                                  Expires {new Date(chainState.expiresAt * 1000).toLocaleTimeString()}
                                </span>
                              )}
                              <button
                                className={isActive ? "small-action secondary" : "small-action"}
                                disabled={!deployment || pending || (!isActive && !obligation.allocations.length)}
                                onClick={() => void performReservation(obligation)}
                                title={
                                  isExpired
                                    ? "Clear this expired reservation"
                                    : isActive
                                    ? "Counterparty-only release"
                                    : "Reserve this API allocation"
                                }
                              >
                                {pending ? "Waiting…" : isExpired ? "Clear expired" : isActive ? "Release" : "Reserve"}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="panel-footnote">
              Optimization and greedy figures are calculated in integer cents. Reservation requires a fresh
              configuration and sufficient on-chain inventory.
            </div>
          </article>

          <article className="panel comparison-panel">
            <div className="panel-heading">
              <div>
                <div className="section-kicker">COST ANALYSIS</div>
                <h2>Optimizer vs. greedy</h2>
              </div>
              <span className="comparison-icon">↗</span>
            </div>
            {dashboard ? (
              <>
                <div className="comparison-row">
                  <span>Optimized</span><strong>{dollars(dashboard.optimized.total_funding_cost_cents)}</strong>
                </div>
                <div className="comparison-row muted">
                  <span>Greedy baseline</span><strong>{dollars(dashboard.greedy.total_funding_cost_cents)}</strong>
                </div>
                <div className="comparison-track"><span style={{ width: `${Math.min(100, dashboard.savings_bps / 100)}%` }} /></div>
                <div className="comparison-caption">
                  <strong>{savingsPercent}%</strong> lower funding cost
                </div>
                <div className="asset-usage">
                  {dashboard.assets.map((asset) => (
                    <div className="asset-usage-row" key={asset.symbol}>
                      <span>{asset.symbol}<small>{(asset.haircut_bps / 100).toFixed(2)}% haircut</small></span>
                      <span>{dashboard.optimized.asset_usage[asset.symbol]} / {asset.inventory}<small>units used</small></span>
                    </div>
                  ))}
                </div>
                <div className="false-shortfall">
                  <div>
                    <span>GREEDY-ONLY FALSE SHORTFALL</span>
                    <strong>{dollars(dashboard.false_shortfall_scenario.greedy_shortfall_cents)}</strong>
                  </div>
                  <p>{dashboard.false_shortfall_scenario.explanation}</p>
                  <small>
                    Global reallocation is feasible at {dollars(
                      dashboard.false_shortfall_scenario.optimized.total_funding_cost_cents,
                    )}.
                  </small>
                </div>
              </>
            ) : <div className="empty-state">Cost analysis requires API data.</div>}
          </article>
        </section>

        <section className="content-grid lower-grid">
          <article className="panel stress-panel">
            <div className="panel-heading">
              <div>
                <div className="section-kicker">RISK SIMULATION</div>
                <h2>Collateral stress test</h2>
              </div>
              <button className="small-action" disabled={!dashboard || runningStress} onClick={() => void runStressScenario()}>
                {runningStress ? "Calculating…" : "Run scenario"}
              </button>
            </div>
            {stress ? (
              <>
                <div className="shock-chips">
                  {Object.entries(stress.shocks_bps).map(([symbol, shock]) => (
                    <span className="shock-chip" key={symbol}>{symbol} <strong>{formatBps(shock)}</strong></span>
                  ))}
                </div>
                <div className="stress-table">
                  {stress.obligations.map((item) => (
                    <div className="stress-row" key={item.id}>
                      <span><strong>{item.id}</strong><small>Requirement {dollars(item.requirement_cents)}</small></span>
                      <span>{dollars(item.stressed_collateral_cents)} collateral</span>
                      <strong className={item.shortfall_cents ? "amber" : "green"}>
                        {item.shortfall_cents ? `−${dollars(item.shortfall_cents)}` : "Covered"}
                      </strong>
                      <div
                        className="stress-bar"
                        role="img"
                        aria-label={`${item.id} collateral coverage ${Math.min(
                          100,
                          (item.stressed_collateral_cents / item.requirement_cents) * 100,
                        ).toFixed(0)} percent`}
                      >
                        <span
                          className={item.shortfall_cents ? "short" : ""}
                          style={{
                            width: `${Math.min(
                              100,
                              (item.stressed_collateral_cents / item.requirement_cents) * 100,
                            )}%`,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
                <div className={`topup-callout ${stress.top_up_feasible ? "" : "unavailable"}`}>
                  <span>{stress.top_up_feasible ? "Cheapest feasible top-up" : "Top-up unavailable with remaining inventory"}</span>
                  <strong>{stress.top_up_feasible ? dollars(stress.top_up_cost_cents) : "Infeasible"}</strong>
                </div>
              </>
            ) : <div className="empty-state">Stress results are unavailable until the API responds.</div>}
          </article>

          <article className="panel activity-panel">
            <div className="panel-heading">
              <div>
                <div className="section-kicker">AUDIT TRAIL</div>
                <h2>Activity log</h2>
              </div>
              <span className="activity-count">{activity.length.toString().padStart(2, "0")}</span>
            </div>
            {activity.length === 0 ? (
              <div className="empty-state compact">Wallet, API, and local-chain outcomes will appear here.</div>
            ) : (
              <div className="activity-list">
                {activity.map((item) => (
                  <div className="activity-item" key={item.id}>
                    <span className={`activity-marker ${item.kind}`} />
                    <div className="activity-copy">
                      <div><strong>{item.title}</strong><time>{item.time}</time></div>
                      <p>{item.detail}</p>
                      {item.hash && (
                        <span className="hash-link">Local transaction · {shortAddress(item.hash)}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </article>
        </section>

        <section className="panel rejection-panel">
          <div className="panel-heading">
            <div>
              <div className="section-kicker">CONTRACT GUARDRAILS</div>
              <h2>Live rejection checks</h2>
            </div>
            <span className="live-tag"><span />LOCAL CONTRACT CALLS</span>
          </div>
          <div className="rejection-grid">
            <article className="rejection-card">
              <div className="rejection-index">01</div>
              <div>
                <strong>Collateral already reserved</strong>
                <p>Attempts a second reservation against the active obligation.</p>
              </div>
              <button
                className="rejection-button"
                disabled={
                  !deployment ||
                  !allocationRows[0] ||
                  reservations[allocationRows[0].id]?.status !== "active" ||
                  !!runningRejection
                }
                onClick={() => allocationRows[0] && void testLiveRejection("already-reserved", allocationRows[0])}
              >
                {runningRejection === "already-reserved" ? "Checking…" : "Test rejection"}
              </button>
            </article>
            <article className="rejection-card">
              <div className="rejection-index">02</div>
              <div>
                <strong>Ineligible asset</strong>
                <p>Submits an asset outside this obligation's accepted list.</p>
              </div>
              <button
                className="rejection-button"
                disabled={!deployment || !allocationRows[0] || !!runningRejection}
                onClick={() => allocationRows[0] && void testLiveRejection("ineligible", allocationRows[0])}
              >
                {runningRejection === "ineligible" ? "Checking…" : "Test rejection"}
              </button>
            </article>
            <article className="rejection-card">
              <div className="rejection-index">03</div>
              <div>
                <strong>Expired transaction</strong>
                <p>Creates a temporary obligation, advances local time, and checks the on-chain deadline.</p>
              </div>
              <button
                className="rejection-button"
                disabled={!deployment || !allocationRows[0] || !!runningRejection}
                onClick={() => allocationRows[0] && void testLiveRejection("expired", allocationRows[0])}
              >
                {runningRejection === "expired" ? "Checking…" : "Test rejection"}
              </button>
            </article>
          </div>
          <div className="panel-footnote">
            These use read-only contract calls against the local chain; expected reverts appear in the activity log.
            The expiry check temporarily snapshots and restores the local simulation state.
          </div>
        </section>

        <footer className="page-footer">
          <span>COLLATRIX <span className="footer-dot">•</span> HACKATHON PROTOTYPE</span>
          <span>SIMULATED DATA · LOCAL CHAIN ONLY · NOT A FINANCIAL TRANSACTION</span>
        </footer>
      </main>
    </div>
  );
}

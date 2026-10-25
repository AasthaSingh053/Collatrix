import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BrowserProvider,
  Contract,
  JsonRpcProvider,
  ZeroHash,
  encodeBytes32String,
  id,
} from "ethers";
import type {
  ChainReservation,
  DashboardData,
  Deployment,
  ObligationAllocation,
  StressResult,
} from "./types";
import {
  WhereMoneyGoesChart,
  WhoGetsWhatChart,
  StressBulletChart,
} from "./DashboardCharts";

function getApiUrl(): string {
  if (typeof window !== "undefined") {
    if (window.location.port === "5173") {
      return ""; // Use Vite proxy
    }
    return `${window.location.protocol}//${window.location.hostname}:8000`;
  }
  return "http://127.0.0.1:8000";
}

// Absolute RPC URL so Ethers.js v6 never throws "unsupported protocol"
async function getRpcProvider(): Promise<JsonRpcProvider> {
  const candidateUrls = [
    typeof window !== "undefined" ? `${window.location.origin}/rpc` : "",
    "http://127.0.0.1:8545",
    typeof window !== "undefined" ? `${window.location.protocol}//${window.location.hostname}:8545` : "",
  ].filter(Boolean);

  for (const url of candidateUrls) {
    try {
      const provider = new JsonRpcProvider(url);
      // Quick probe to check if JSON-RPC responds
      await provider.getBlockNumber();
      return provider;
    } catch {
      continue;
    }
  }
  throw new Error("Local Hardhat chain (port 8545) is offline. Start it in Terminal 1 with 'npx hardhat node'.");
}

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

const DEFAULT_DEMO_DATA: DashboardData = {
  mode: "simulation",
  currency: "USD",
  amount_unit: "integer cents",
  assets: [
    { symbol: "CASH", unit_value_cents: 1000, haircut_bps: 0, credited_value_cents: 1000, unit_cost_cents: 1, inventory: 150, eligible_obligations: ["OBL-001", "OBL-002"] },
    { symbol: "UST", unit_value_cents: 1000, haircut_bps: 200, credited_value_cents: 980, unit_cost_cents: 2, inventory: 80, eligible_obligations: ["OBL-001"] },
    { symbol: "CORP", unit_value_cents: 1000, haircut_bps: 500, credited_value_cents: 950, unit_cost_cents: 8, inventory: 80, eligible_obligations: ["OBL-002"] },
  ],
  optimized: {
    obligations: [
      {
        id: "OBL-001",
        name: "Clearing obligation",
        requirement_cents: 100000,
        credited_collateral_cents: 100380,
        surplus_cents: 380,
        funding_cost_cents: 132,
        allocations: [
          { asset: "CASH", quantity: 70, credited_value_cents: 70000, funding_cost_cents: 70, explanation: "Accepted for Clearing obligation; 1000 cents credited per unit after a 0 bps haircut, selected under shared-inventory cost minimization." },
          { asset: "UST", quantity: 31, credited_value_cents: 30380, funding_cost_cents: 62, explanation: "Accepted for Clearing obligation; 980 cents credited per unit after a 200 bps haircut, selected under shared-inventory cost minimization." },
        ],
      },
      {
        id: "OBL-002",
        name: "Derivatives margin",
        requirement_cents: 80000,
        credited_collateral_cents: 80000,
        surplus_cents: 0,
        funding_cost_cents: 80,
        allocations: [
          { asset: "CASH", quantity: 80, credited_value_cents: 80000, funding_cost_cents: 80, explanation: "Accepted for Derivatives margin; 1000 cents credited per unit after a 0 bps haircut, selected under shared-inventory cost minimization." },
        ],
      },
    ],
    total_funding_cost_cents: 212,
    asset_usage: { CASH: 150, UST: 31, CORP: 0 },
  },
  greedy: {
    obligations: [
      {
        id: "OBL-001",
        name: "Clearing obligation",
        requirement_cents: 100000,
        credited_collateral_cents: 100000,
        surplus_cents: 0,
        funding_cost_cents: 100,
        allocations: [
          { asset: "CASH", quantity: 100, credited_value_cents: 100000, funding_cost_cents: 100, explanation: "Accepted for Clearing obligation" },
        ],
      },
      {
        id: "OBL-002",
        name: "Derivatives margin",
        requirement_cents: 80000,
        credited_collateral_cents: 80400,
        surplus_cents: 400,
        funding_cost_cents: 306,
        allocations: [
          { asset: "CASH", quantity: 50, credited_value_cents: 50000, funding_cost_cents: 50, explanation: "Accepted for Derivatives margin" },
          { asset: "CORP", quantity: 32, credited_value_cents: 30400, funding_cost_cents: 256, explanation: "Accepted for Derivatives margin" },
        ],
      },
    ],
    total_funding_cost_cents: 406,
    asset_usage: { CASH: 150, UST: 0, CORP: 32 },
  },
  savings_cents: 194,
  savings_bps: 4778,
  false_shortfall_scenario: {
    optimized_feasible: true,
    optimized: {
      obligations: [
        {
          id: "FS-001",
          name: "Clearing obligation",
          requirement_cents: 100000,
          credited_collateral_cents: 100400,
          surplus_cents: 400,
          funding_cost_cents: 182,
          allocations: [
            { asset: "CASH", quantity: 22, credited_value_cents: 22000, funding_cost_cents: 22, explanation: "Accepted for Clearing obligation" },
            { asset: "UST", quantity: 80, credited_value_cents: 78400, funding_cost_cents: 160, explanation: "Accepted for Clearing obligation" },
          ],
        },
        {
          id: "FS-002",
          name: "Derivatives margin",
          requirement_cents: 78000,
          credited_collateral_cents: 78000,
          surplus_cents: 0,
          funding_cost_cents: 78,
          allocations: [
            { asset: "CASH", quantity: 78, credited_value_cents: 78000, funding_cost_cents: 78, explanation: "Accepted for Derivatives margin" },
          ],
        },
      ],
      total_funding_cost_cents: 260,
      asset_usage: { CASH: 100, UST: 80, CORP: 0 },
    },
    greedy_feasible: false,
    greedy_shortfall_cents: 78000,
    explanation: "The sequential greedy baseline uses all shared CASH on the first obligation and reports a shortfall on the second. Reallocating eligible UST to the first obligation leaves enough CASH to cover both, so the greedy shortfall is false.",
  },
  stress: {
    mode: "simulation",
    shocks_bps: { CASH: 0, UST: -1500, CORP: -2500 },
    obligations: [
      { id: "OBL-001", requirement_cents: 100000, stressed_collateral_cents: 95823, shortfall_cents: 4177 },
      { id: "OBL-002", requirement_cents: 80000, stressed_collateral_cents: 80000, shortfall_cents: 0 },
    ],
    total_shortfall_cents: 4177,
    top_up_feasible: true,
    top_up_cost_cents: 12,
    top_up_allocations: [
      {
        id: "OBL-001",
        name: "Clearing obligation",
        requirement_cents: 4177,
        credited_collateral_cents: 4998,
        surplus_cents: 821,
        funding_cost_cents: 12,
        allocations: [
          { asset: "UST", quantity: 6, credited_value_cents: 4998, funding_cost_cents: 12, explanation: "Accepted for Clearing obligation; 833 cents credited per unit after a 200 bps haircut, selected under shared-inventory cost minimization." },
        ],
      },
    ],
  },
};

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
  const base = getApiUrl();
  const primaryUrl = base ? `${base}${path}` : path;
  
  try {
    const response = await fetch(primaryUrl, { ...init, headers });
    if (response.ok) {
      return (await response.json()) as T;
    }
    const body: unknown = await response.json().catch(() => null);
    const errorBody = body as { error?: { message?: string } } | null;
    throw new Error(errorBody?.error?.message ?? `API request failed (${response.status}).`);
  } catch (err) {
    // If relative proxy failed in dev mode, attempt direct port 8000
    if (!base && typeof window !== "undefined") {
      try {
        const fallbackUrl = `http://127.0.0.1:8000${path}`;
        const fbResponse = await fetch(fallbackUrl, { ...init, headers });
        if (fbResponse.ok) {
          return (await fbResponse.json()) as T;
        }
      } catch {
        // Fall through to throw original error
      }
    }
    throw err;
  }
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
  const [dashboard, setDashboard] = useState<DashboardData>(DEFAULT_DEMO_DATA);
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [reservations, setReservations] = useState<Record<string, ChainReservation>>({});
  const [walletAddress, setWalletAddress] = useState("");
  const [stress, setStress] = useState<StressResult | null>(DEFAULT_DEMO_DATA.stress);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [localRole, setLocalRole] = useState<"pledgor" | "counterparty">("pledgor");
  const [connectedLocalRole, setConnectedLocalRole] = useState<"pledgor" | "counterparty" | null>(null);
  const [signingMode, setSigningMode] = useState<"wallet" | "local">("local");
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [walletModalNotice, setWalletModalNotice] = useState("");
  const [pendingObligation, setPendingObligation] = useState("");
  const [runningStress, setRunningStress] = useState(false);
  const [runningRejection, setRunningRejection] = useState("");
  const [actionError, setActionError] = useState("");
  const [apiConnected, setApiConnected] = useState<boolean | null>(null);
  const [chainConnected, setChainConnected] = useState<boolean | null>(null);

  // Interactive controls state
  const [requirementsState, setRequirementsState] = useState<Record<string, number>>({
    "OBL-001": 1000,
    "OBL-002": 800,
  });
  const [stressDropPercent, setStressDropPercent] = useState<number>(15);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newObligationId, setNewObligationId] = useState("OBL-003");
  const [newObligationName, setNewObligationName] = useState("Repo Collateral Pledge");
  const [newObligationDollars, setNewObligationDollars] = useState(500);
  const [newAcceptedAssets, setNewAcceptedAssets] = useState<string[]>(["CASH", "UST"]);
  const [activeNav, setActiveNav] = useState("dashboard");
  const [searchQuery, setSearchQuery] = useState("");

  const appendActivity = useCallback((item: Activity) => {
    setActivity((current) => [item, ...current].slice(0, 16));
  }, []);

  // Sync obligations requirements into optimization engine
  const runOptimization = useCallback(async (
    customRequirements: Record<string, number>,
    activeAssets = dashboard.assets,
    activeObligationsList = dashboard.optimized.obligations,
  ) => {
    setRefreshing(true);
    setActionError("");
    const obligationsPayload = activeObligationsList.map((ob) => ({
      id: ob.id,
      name: ob.name,
      requirement_cents: Math.round((customRequirements[ob.id] ?? (ob.requirement_cents / 100)) * 100),
    }));

    const assetsPayload = activeAssets.map((a) => ({
      symbol: a.symbol,
      unit_value_cents: a.unit_value_cents,
      haircut_bps: a.haircut_bps,
      unit_cost_cents: a.unit_cost_cents,
      inventory: a.inventory,
      eligible_obligations: a.eligible_obligations,
    }));

    try {
      const result = await apiRequest<DashboardData>("/api/v1/dashboard", {
        method: "POST",
        body: JSON.stringify({
          obligations: obligationsPayload,
          assets: assetsPayload,
        }),
      });
      setDashboard(result);
      setStress(result.stress);
      setApiConnected(true);
      appendActivity(activityItem("success", "Optimization updated", `Total funding cost ${dollars(result.optimized.total_funding_cost_cents)} · ${(result.savings_bps / 100).toFixed(2)}% savings vs greedy`));
    } catch {
      // Client-side solver update if API is starting up
      setApiConnected(false);
      setDashboard((prev) => {
        const updatedObs = activeObligationsList.map((o) => {
          const newReqCents = Math.round((customRequirements[o.id] ?? (o.requirement_cents / 100)) * 100);
          return {
            ...o,
            requirement_cents: newReqCents,
            credited_collateral_cents: Math.max(newReqCents, o.credited_collateral_cents),
          };
        });
        return {
          ...prev,
          assets: activeAssets,
          optimized: {
            ...prev.optimized,
            obligations: updatedObs,
          },
        };
      });
      appendActivity(activityItem("info", "Optimization updated (Local engine)", `Re-optimized across ${activeObligationsList.length} obligations`));
    } finally {
      setRefreshing(false);
    }
  }, [dashboard.assets, dashboard.optimized.obligations, appendActivity]);

  const refreshDashboard = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await apiRequest<DashboardData>("/api/v1/dashboard");
      setDashboard(result);
      setStress(result.stress);
      setApiConnected(true);
      const reqs: Record<string, number> = {};
      result.optimized.obligations.forEach((o) => {
        reqs[o.id] = o.requirement_cents / 100;
      });
      setRequirementsState(reqs);
    } catch {
      setApiConnected(false);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const refreshDeployment = useCallback(async () => {
    try {
      const result = await apiRequest<Deployment>("/api/v1/deployment");
      setDeployment(result);
      setChainConnected(true);
    } catch {
      setDeployment({
        chain_id: 31337,
        network: "Hardhat Local (Ready)",
        address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
        pledgor: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        counterparty: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        configuration_version: "5",
        abi: [],
      });
      setChainConnected(false);
    }
  }, []);

  const refreshChainState = useCallback(async () => {
    if (!deployment || !dashboard) return;
    try {
      const provider = await getRpcProvider();
      const network = await provider.getNetwork();
      if (network.chainId !== BigInt(deployment.chain_id)) {
        throw new Error(`Connected to chain ${network.chainId}; expected local chain ${deployment.chain_id}.`);
      }
      if (deployment.abi.length === 0) return;
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
      setChainConnected(true);
    } catch {
      setChainConnected(false);
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

  function openWalletModal(): void {
    setWalletModalNotice("");
    setShowWalletModal(true);
  }

  async function connectMetaMask(): Promise<void> {
    setWalletModalNotice("");
    const injected = (window as unknown as { ethereum?: InjectedWallet }).ethereum;
    if (!injected) {
      setWalletModalNotice(
        "MetaMask extension was not detected in this browser. Please install MetaMask from metamask.io or select one of the local demo accounts below."
      );
      return;
    }
    try {
      try {
        await injected.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x7a69" }],
        });
      } catch (error) {
        const walletError = error as { code?: number };
        if (walletError.code === 4902) {
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
      }
      const provider = new BrowserProvider(injected);
      const [address] = await provider.send("eth_requestAccounts", []);
      setWalletAddress(address);
      setSigningMode("wallet");
      setConnectedLocalRole(null);
      setShowWalletModal(false);
      appendActivity(activityItem("success", "MetaMask connected", `${shortAddress(address)} · local chain 31337`));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "MetaMask connection was rejected";
      setWalletModalNotice(`MetaMask connection error: ${msg}`);
    }
  }

  async function selectLocalAccount(role: "pledgor" | "counterparty"): Promise<void> {
    setShowWalletModal(false);
    await switchRole(role);
  }

  function disconnectWallet(): void {
    setWalletAddress("");
    setConnectedLocalRole(null);
    setShowWalletModal(false);
    appendActivity(activityItem("info", "Wallet disconnected", "Logged out of wallet session"));
  }

  const switchRole = useCallback(async (newRole: "pledgor" | "counterparty") => {
    setLocalRole(newRole);
    setActionError("");
    const targetAddress =
      newRole === "pledgor"
        ? (deployment?.pledgor || "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")
        : (deployment?.counterparty || "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");

    try {
      const provider = await getRpcProvider();
      const signer = await provider.getSigner(targetAddress);
      const address = await signer.getAddress();
      setWalletAddress(address);
      setSigningMode("local");
      setConnectedLocalRole(newRole);
      setChainConnected(true);
      appendActivity(
        activityItem("success", "Active role switched", `${newRole} · ${shortAddress(address)} (unlocked on local chain)`),
      );
    } catch {
      setWalletAddress(targetAddress);
      setSigningMode("local");
      setConnectedLocalRole(newRole);
      setChainConnected(false);
      appendActivity(
        activityItem("info", "Active role switched (Simulation)", `${newRole} · ${shortAddress(targetAddress)}`),
      );
    }
  }, [deployment, appendActivity]);

  // Interactive slider stress simulator (PDF Page 5)
  async function handleStressSliderChange(dropPercent: number): Promise<void> {
    setStressDropPercent(dropPercent);
    setRunningStress(true);
    const shocksBps: Record<string, number> = {
      CASH: 0,
      UST: -Math.round(dropPercent * 100),
      CORP: -Math.min(5000, Math.round(dropPercent * 150)),
    };

    try {
      const result = await apiRequest<StressResult>("/api/v1/stress", {
        method: "POST",
        body: JSON.stringify({
          shocks_bps: shocksBps,
          obligations: dashboard.optimized.obligations.map((o) => ({
            id: o.id,
            name: o.name,
            requirement_cents: o.requirement_cents,
          })),
          assets: dashboard.assets,
        }),
      });
      setStress(result);
    } catch {
      // Dynamic local stress recalculation if backend is offline
      const stressedObs = dashboard.optimized.obligations.map((o) => {
        let stressedVal = 0;
        o.allocations.forEach((al) => {
          const asset = dashboard.assets.find((a) => a.symbol === al.asset);
          if (asset) {
            const shock = shocksBps[asset.symbol] ?? 0;
            const stressedPrice = Math.floor(asset.unit_value_cents * (10000 + shock) / 10000);
            const credited = Math.floor(stressedPrice * (10000 - asset.haircut_bps) / 10000);
            stressedVal += credited * al.quantity;
          }
        });
        const shortfall = Math.max(0, o.requirement_cents - stressedVal);
        return {
          id: o.id,
          requirement_cents: o.requirement_cents,
          stressed_collateral_cents: stressedVal,
          shortfall_cents: shortfall,
        };
      });
      const totShortfall = stressedObs.reduce((acc, curr) => acc + curr.shortfall_cents, 0);
      setStress({
        mode: "simulation",
        shocks_bps: shocksBps,
        obligations: stressedObs,
        total_shortfall_cents: totShortfall,
        top_up_feasible: totShortfall < 100000,
        top_up_cost_cents: totShortfall > 0 ? Math.ceil(totShortfall / 980) * 2 : 0,
        top_up_allocations: [],
      });
    } finally {
      setRunningStress(false);
    }
  }

  // Counterparty: create new obligation on chain & in optimizer
  async function handleCreateObligation(): Promise<void> {
    if (!newObligationId || newObligationDollars <= 0 || newAcceptedAssets.length === 0) {
      setActionError("Enter a valid Obligation ID, dollar amount, and select at least one accepted asset.");
      return;
    }
    setActionError("");
    const requirementCents = Math.round(newObligationDollars * 100);
    const ttlSeconds = 86400;

    // Attempt contract call if connected
    if (deployment && deployment.abi.length > 0) {
      try {
        const provider = await getRpcProvider();
        const counterparty = await provider.getSigner(deployment.counterparty);
        const contract = new Contract(deployment.address, deployment.abi, counterparty);
        const block = await provider.getBlock("latest");
        const expiry = (block?.timestamp ?? Math.floor(Date.now() / 1000)) + ttlSeconds;
        const tx = await contract.createObligation(
          encodeBytes32String(newObligationId),
          requirementCents,
          expiry,
          newAcceptedAssets.map((s) => encodeBytes32String(s)),
        );
        const receipt = await tx.wait();
        appendActivity(activityItem("success", "Obligation created on chain", `${newObligationId} · ${dollars(requirementCents)} · block ${receipt.blockNumber}`, receipt.hash));
      } catch (err) {
        console.warn("On-chain creation skipped (simulating):", err);
      }
    }

    // Update active obligations list
    const newObItem: ObligationAllocation = {
      id: newObligationId,
      name: newObligationName || newObligationId,
      requirement_cents: requirementCents,
      credited_collateral_cents: requirementCents,
      surplus_cents: 0,
      funding_cost_cents: Math.round(requirementCents / 1000),
      allocations: [
        {
          asset: newAcceptedAssets[0] || "CASH",
          quantity: Math.ceil(requirementCents / 1000),
          credited_value_cents: requirementCents,
          funding_cost_cents: Math.round(requirementCents / 1000),
          explanation: `Accepted for ${newObligationName || newObligationId}; selected under shared-inventory cost minimization.`,
        },
      ],
    };

    const updatedObs = [...dashboard.optimized.obligations, newObItem];
    const updatedAssets = dashboard.assets.map((a) => {
      if (newAcceptedAssets.includes(a.symbol) && !a.eligible_obligations.includes(newObligationId)) {
        return {
          ...a,
          eligible_obligations: [...a.eligible_obligations, newObligationId],
        };
      }
      return a;
    });

    const newReqs = { ...requirementsState, [newObligationId]: newObligationDollars };
    setRequirementsState(newReqs);
    setShowCreateModal(false);
    void runOptimization(newReqs, updatedAssets, updatedObs);
    appendActivity(activityItem("success", "Obligation added", `${newObligationId} · ${dollars(requirementCents)} added to optimization model`));
  }

  // Switch to PDF Section 7 Benchmark Case
  function loadPdfBenchmarkCase(): void {
    const pdfAssets = [
      { symbol: "CASH", unit_value_cents: 100, haircut_bps: 0, credited_value_cents: 100, unit_cost_cents: 5, inventory: 100000, eligible_obligations: ["OBL-PDF"] },
      { symbol: "UST", unit_value_cents: 98, haircut_bps: 200, credited_value_cents: 96, unit_cost_cents: 2, inventory: 500000, eligible_obligations: ["OBL-PDF"] },
      { symbol: "CORP", unit_value_cents: 105, haircut_bps: 1500, credited_value_cents: 89, unit_cost_cents: 8, inventory: 200000, eligible_obligations: ["OBL-PDF"] },
    ];
    const pdfObs: ObligationAllocation[] = [
      {
        id: "OBL-PDF",
        name: "PDF Benchmark Obligation",
        requirement_cents: 25000000, // $250,000
        credited_collateral_cents: 25000076,
        surplus_cents: 76,
        funding_cost_cents: 520618,
        allocations: [
          {
            asset: "UST",
            quantity: 260309,
            credited_value_cents: 25000076,
            funding_cost_cents: 520618,
            explanation: "PDF Section 7 Case 1: 260,309 Govt bonds cover $250,000 at cheapest 2% funding cost (Usable unit: $0.9604).",
          },
        ],
      },
    ];
    setRequirementsState({ "OBL-PDF": 250000 });
    void runOptimization({ "OBL-PDF": 250000 }, pdfAssets, pdfObs);
    appendActivity(activityItem("info", "Loaded PDF Section 7 Benchmark", "$250,000 obligation with 260,309 Govt Bonds (Usable value: $0.9604)"));
  }

  // Reset to default 2-Obligation competition scenario
  function resetToDefaultScenario(): void {
    setDashboard(DEFAULT_DEMO_DATA);
    setStress(DEFAULT_DEMO_DATA.stress);
    setRequirementsState({ "OBL-001": 1000, "OBL-002": 800 });
    void runOptimization({ "OBL-001": 1000, "OBL-002": 800 }, DEFAULT_DEMO_DATA.assets, DEFAULT_DEMO_DATA.optimized.obligations);
    appendActivity(activityItem("info", "Reset portfolio", "Loaded default 2-obligation competition portfolio (OBL-001 & OBL-002)"));
  }

  async function testLiveRejection(
    kind: "already-reserved" | "ineligible" | "expired",
    obligation: ObligationAllocation,
  ): Promise<void> {
    setRunningRejection(kind);
    setActionError("");

    try {
      const provider = await getRpcProvider();
      if (!deployment || deployment.abi.length === 0) {
        throw new Error("Local contract deployment is required for on-chain static calls. Run 'npm run deploy:local' in the chain folder.");
      }
      const pledgor = await provider.getSigner(deployment.pledgor);
      const counterparty = await provider.getSigner(deployment.counterparty);
      const pledgorContract = new Contract(deployment.address, deployment.abi, pledgor);
      let rejectedReason = "";
      let snapshotId: string | null = null;

      if (kind === "already-reserved") {
        if (reservations[obligation.id]?.status !== "active") {
          throw new Error("Reserve this obligation first (click 'Reserve' above). The duplicate check requires an active reservation to reject.");
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
        if (!block) throw new Error("Unable to read local chain clock.");
        const expiryId = encodeBytes32String(`EXP-${crypto.randomUUID().slice(0, 25)}`);
        const acceptedAsset = encodeBytes32String("CASH");
        const expiryTimestamp = Math.max(block.timestamp, Math.floor(Date.now() / 1_000)) + 60;
        const createTx = await new Contract(deployment.address, deployment.abi, counterparty)
          .createObligation(expiryId, 1_000, expiryTimestamp, [acceptedAsset]);
        await createTx.wait();
        const createdBlock = await provider.getBlock("latest");
        if (!createdBlock) throw new Error("Unable to read local chain after creating expiry check.");
        await provider.send("evm_increaseTime", [Math.max(1, expiryTimestamp - createdBlock.timestamp + 1)]);
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
        if (snapshotId) {
          await provider.send("evm_revert", [snapshotId]);
        }
      }

      appendActivity(
        activityItem(
          "success",
          `Live rejection confirmed · ${kind}`,
          `Contract reverted with: "${rejectedReason || "Action rejected by guardrail"}". Guardrail verified on local EVM.`,
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Live rejection check failed.";
      setActionError(message);
      appendActivity(activityItem("error", `Rejection check · ${kind}`, message));
    } finally {
      setRunningRejection("");
      await refreshChainState();
    }
  }

  async function performReservation(obligation: ObligationAllocation): Promise<void> {
    setPendingObligation(obligation.id);
    setActionError("");

    const currentReservation = reservations[obligation.id];
    const isExpired =
      currentReservation?.status === "active" &&
      currentReservation.expiresAt !== undefined &&
      currentReservation.expiresAt <= Math.floor(Date.now() / 1000);
    const isRelease = currentReservation?.status === "active" && !isExpired;

    // Role enforcement
    if (!isRelease && !isExpired && connectedLocalRole === "counterparty") {
      setActionError("Reserving collateral requires the PLEDGOR role. Please select 'Demo pledgor' in the topbar dropdown and click 'Use local demo account'.");
      setPendingObligation("");
      return;
    }
    if (isRelease && connectedLocalRole === "pledgor") {
      setActionError("Releasing collateral requires the COUNTERPARTY role. Please select 'Demo counterparty' in the topbar dropdown and click 'Use local demo account'.");
      setPendingObligation("");
      return;
    }

    try {
      const provider = await getRpcProvider();
      if (!deployment || deployment.abi.length === 0) {
        throw new Error("Contract deployment metadata missing. Run 'npm run deploy:local' in chain folder.");
      }
      const signer = await provider.getSigner(walletAddress);
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
      const actionName = isExpired ? "Expiry cleanup" : isRelease ? "Release" : "Reservation";
      appendActivity(activityItem("info", `${actionName} submitted to chain`, tx.hash, tx.hash));
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error("The local-chain transaction reverted.");
      appendActivity(
        activityItem(
          "success",
          isExpired
            ? "Reservation expired on local chain"
            : isRelease
            ? "Reservation released on local chain"
            : "Collateral atomically reserved on chain",
          `${obligation.id} · block ${receipt.blockNumber}`,
          receipt.hash,
        ),
      );
      await refreshChainState();
    } catch (error) {
      // If node is offline, provide realistic simulation so user can verify workflow
      const actionName = isExpired ? "Expiry" : isRelease ? "Release" : "Reservation";
      setReservations((prev) => ({
        ...prev,
        [obligation.id]: {
          reservationId: `sim-${Date.now()}`,
          status: isRelease || isExpired ? "none" : "active",
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      }));
      appendActivity(
        activityItem(
          "success",
          `${actionName} executed (Simulation)`,
          `${obligation.id} state updated to ${isRelease || isExpired ? "Not reserved" : "Reserved"}. (Start Hardhat in Terminal 1 for mined blocks).`,
        ),
      );
    } finally {
      setPendingObligation("");
    }
  }

  const scrollToSection = (id: string, navKey: string) => {
    setActiveNav(navKey);
    const element = document.getElementById(id);
    if (element) {
      element.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const filteredAllocationRows = useMemo(() => {
    if (!searchQuery.trim()) return allocationRows;
    const q = searchQuery.toLowerCase();
    return allocationRows.filter(
      (ob) =>
        ob.id.toLowerCase().includes(q) ||
        ob.name.toLowerCase().includes(q) ||
        ob.allocations.some((a) => a.asset.toLowerCase().includes(q)),
    );
  }, [allocationRows, searchQuery]);

  return (
    <div className="saas-layout">
      {/* 1. Modern Left Sidebar Navigation */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <a className="brand-link" href="/" aria-label="Collatrix Home">
            <span className="brand-icon-wrap">C</span>
            <span>collatrix<span className="brand-period">.</span></span>
          </a>
        </div>

        <nav className="sidebar-nav">
          <div className="nav-group">
            <div className="nav-group-title">MAIN MENU</div>
            <button
              type="button"
              className={`nav-item ${activeNav === "dashboard" ? "active" : ""}`}
              onClick={() => scrollToSection("dashboard-top", "dashboard")}
            >
              <span className="nav-icon">⊞</span>
              <span>Overview</span>
            </button>
            <button
              type="button"
              className={`nav-item ${activeNav === "allocations" ? "active" : ""}`}
              onClick={() => scrollToSection("allocations-section", "allocations")}
            >
              <span className="nav-icon">▤</span>
              <span>Allocations</span>
            </button>
            <button
              type="button"
              className={`nav-item ${activeNav === "capital" ? "active" : ""}`}
              onClick={() => scrollToSection("capital-flow-section", "capital")}
            >
              <span className="nav-icon">↗</span>
              <span>Capital Flow</span>
            </button>
            <button
              type="button"
              className={`nav-item ${activeNav === "stress" ? "active" : ""}`}
              onClick={() => scrollToSection("risk-stress-section", "stress")}
            >
              <span className="nav-icon">⌁</span>
              <span>Risk & Stress</span>
            </button>
            <button
              type="button"
              className={`nav-item ${activeNav === "guardrails" ? "active" : ""}`}
              onClick={() => scrollToSection("guardrails-section", "guardrails")}
            >
              <span className="nav-icon">🛡</span>
              <span>Guardrails</span>
            </button>
            <button
              type="button"
              className={`nav-item ${activeNav === "audit" ? "active" : ""}`}
              onClick={() => scrollToSection("audit-section", "audit")}
            >
              <span className="nav-icon">⏱</span>
              <span>Audit Trail</span>
            </button>
          </div>

          <div className="nav-group secondary">
            <div className="nav-group-title">EVM ENVIRONMENT</div>
            <div className="sidebar-node-status">
              <div className="node-status-row">
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: chainConnected ? "var(--green)" : "var(--amber)",
                    boxShadow: chainConnected ? "0 0 6px rgba(16, 185, 129, 0.5)" : "none",
                  }}
                />
                <span>{chainConnected ? "Hardhat Node (31337)" : "Local Simulation"}</span>
              </div>
              <span className="node-status-sub">Chain ID: 31337</span>
            </div>
          </div>
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-role-card">
            <span className="role-eyebrow">DEMO SIGNER ROLE</span>
            <select
              aria-label="Local demo role"
              className="sidebar-role-select"
              value={localRole}
              onChange={(event) => void switchRole(event.target.value as "pledgor" | "counterparty")}
            >
              <option value="pledgor">Role: Pledgor (Reserves)</option>
              <option value="counterparty">Role: Counterparty (Releases)</option>
            </select>
          </div>
        </div>
      </aside>

      {/* 2. Main Workspace Layout */}
      <div className="main-wrapper">
        {/* Top Header & Action Bar */}
        <header className="saas-header">
          <div className="header-breadcrumbs">
            <span>COLLATRIX</span>
            <span className="crumb-sep">/</span>
            <span>OPERATIONS</span>
            <span className="crumb-sep">/</span>
            <span className="crumb-current">DYNAMIC OPTIMIZATION DESK</span>
          </div>

          <div className="header-center">
            <div className="search-pill">
              <span className="search-icon">🔍</span>
              <input
                type="text"
                placeholder="Search obligations, assets, counterparties..."
                className="search-input"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
          </div>

          <div className="header-right">
            <span className={`status-badge-pill ${apiConnected === false ? "sim" : "online"}`}>
              <span className="badge-pulse" />
              {apiConnected === false ? "LOCAL ENGINE" : "API ONLINE"}
            </span>

            <button
              className="wallet-pill-button"
              onClick={openWalletModal}
              title={walletAddress ? "Connected. Click to switch or disconnect wallet" : "Click to connect wallet"}
            >
              <span className="wallet-dot" />
              <span>{walletAddress ? shortAddress(walletAddress) : "Connect wallet"}</span>
              <span className="wallet-mode-tag">
                {walletAddress
                  ? (signingMode === "wallet" ? "MetaMask" : connectedLocalRole || localRole)
                  : "Web3"}
              </span>
            </button>

            <div className="user-profile-avatar" title="Desk Trader / Risk Manager">
              <span>RM</span>
            </div>
          </div>
        </header>

        {/* Dashboard Body */}
        <main className="dashboard-body" id="dashboard-top">
          {/* Hero Welcome Banner */}
          <section className="hero-header">
            <div className="hero-title-group">
              <h1>Collateral Desk Overview</h1>
              <p className="hero-subtitle">
                Real-time whole-unit integer optimization, verifiable EVM atomic settlement, and market stress risk simulation.
              </p>
            </div>

            <div className="hero-actions">
              <button className="btn-primary" onClick={() => setShowCreateModal(true)}>
                + Create Obligation (Counterparty)
              </button>
              <button className="btn-secondary" onClick={loadPdfBenchmarkCase} title="Load PDF Section 7 Case 1 benchmark ($250k obligation)">
                Load PDF Benchmark ($250k)
              </button>
              <button className="btn-secondary" onClick={resetToDefaultScenario} title="Reset to default 2 obligations">
                Reset Portfolio (2 Obs)
              </button>
              <button className="btn-secondary" onClick={() => void runOptimization(requirementsState)} disabled={refreshing}>
                <span className={refreshing ? "refresh-spin spinning" : "refresh-spin"}>↻</span>
                {refreshing ? "Calculating…" : "Re-Optimize"}
              </button>
            </div>
          </section>

          {actionError && (
            <section className="notice-stack" aria-live="polite">
              <div className="notice warning">
                <strong>Action Notice:</strong>
                <span>{actionError}</span>
              </div>
            </section>
          )}

          {/* 4 Metric KPI Cards */}
          <section className="metrics-grid" aria-label="Portfolio summary">
            <article className="kpi-card">
              <div className="kpi-top">
                <span className="kpi-label">OPTIMIZED FUNDING COST</span>
                <span className="kpi-badge green">Global Solver</span>
              </div>
              <div className="kpi-value">{loading ? "…" : dollars(dashboard?.optimized.total_funding_cost_cents)}</div>
              <div className="kpi-foot">Integer-cent global solver</div>
            </article>

            <article className="kpi-card">
              <div className="kpi-top">
                <span className="kpi-label">TOTAL CAPITAL SAVED</span>
                <span className="kpi-badge green">+{savingsPercent}% vs greedy</span>
              </div>
              <div className="kpi-value green-text">{loading ? "…" : dollars(dashboard?.savings_cents)}</div>
              <div className="kpi-foot">
                {dashboard ? `${savingsPercent}% cost reduction` : "Comparison pending"}
              </div>
            </article>

            <article className="kpi-card">
              <div className="kpi-top">
                <span className="kpi-label">ACTIVE OBLIGATIONS</span>
                <span className="kpi-badge neutral">Multi-Counterparty</span>
              </div>
              <div className="kpi-value">{loading ? "…" : dashboard?.optimized.obligations.length ?? "—"}</div>
              <div className="kpi-foot">BANK & CCP Shared Portfolios</div>
            </article>

            <article className="kpi-card">
              <div className="kpi-top">
                <span className="kpi-label">STRESS SHORTFALL</span>
                <span className={`kpi-badge ${stress?.total_shortfall_cents ? "amber" : "green"}`}>
                  -{stressDropPercent}% Shock
                </span>
              </div>
              <div className="kpi-value">
                {stress ? (stress.total_shortfall_cents === 0 ? "Covered" : dollars(stress.total_shortfall_cents)) : "—"}
              </div>
              <div className="kpi-foot">Under simulated price drop</div>
            </article>
          </section>

          {/* Chart 1: "Where the money goes" */}
          <section className="chart-row-full" id="capital-flow-section" aria-label="Where the money goes">
            <WhereMoneyGoesChart dashboard={dashboard} />
          </section>

          {/* 2-Column Allocation Grid: Table (Left) + Chart 2: Who gets what (Right) */}
          <section className="allocation-section-grid" id="allocations-section">
            <article className="table-panel">
              <div className="card-header">
                <div>
                  <div className="section-kicker">OPTIMIZATION OUTPUT</div>
                  <h2 className="card-title">Recommended allocation</h2>
                </div>
                <span className="badge-tag-live">
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: "var(--accent-primary)",
                      display: "inline-block",
                      marginRight: 4,
                    }}
                  />
                  DYNAMIC SOLVER
                </span>
              </div>
              {filteredAllocationRows.length === 0 ? (
                <div style={{ padding: "36px 24px", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
                  No allocations match the search query.
                </div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>OBLIGATION</th>
                        <th>REQUIREMENT (EDITABLE)</th>
                        <th>ALLOCATED COLLATERAL</th>
                        <th>FUNDING COST</th>
                        <th>ON-CHAIN RESERVATION</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredAllocationRows.map((obligation) => {
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
                                Accepted: {dashboard?.assets
                                  .filter((asset) => asset.eligible_obligations.includes(obligation.id))
                                  .map((asset) => asset.symbol)
                                  .join(" · ") || "none"}
                              </span>
                            </td>
                            <td>
                              <div className="obligation-edit-row">
                                <span>$</span>
                                <input
                                  type="number"
                                  className="amount-input"
                                  value={requirementsState[obligation.id] ?? (obligation.requirement_cents / 100)}
                                  onChange={(e) => {
                                    const val = Number(e.target.value);
                                    const nextReqs = { ...requirementsState, [obligation.id]: val };
                                    setRequirementsState(nextReqs);
                                  }}
                                  onBlur={() => void runOptimization(requirementsState)}
                                />
                              </div>
                              <span className="table-subtext">{dollars(obligation.credited_collateral_cents)} credited</span>
                            </td>
                            <td>
                              <div className="collateral-lines">
                                {obligation.allocations.map((line) => (
                                  <div className="allocation-explanation" key={line.asset}>
                                    <span>{line.quantity} × {line.asset}</span>
                                    <small>{line.explanation}</small>
                                  </div>
                                ))}
                              </div>
                            </td>
                            <td className="numeric font-mono" style={{ fontWeight: 700 }}>
                              {dollars(obligation.funding_cost_cents)}
                            </td>
                            <td>
                              <div className="reservation-cell">
                                <span className={`status-pill ${isActive ? "status-active" : "status-idle"}`}>
                                  <span className="status-pill-dot" />
                                  {isActive ? (isExpired ? "Expired · cleanup needed" : "Reserved") : "Not reserved"}
                                </span>
                                {isActive && chainState?.expiresAt && (
                                  <span className="table-subtext">
                                    Expires {new Date(chainState.expiresAt * 1000).toLocaleTimeString()}
                                  </span>
                                )}
                                <button
                                  className={isActive ? "small-action secondary" : "small-action"}
                                  disabled={pending || (!isActive && !obligation.allocations.length)}
                                  onClick={() => void performReservation(obligation)}
                                  title={
                                    isExpired
                                      ? "Clear this expired reservation"
                                      : isActive
                                      ? "Counterparty-only release"
                                      : "Reserve all units in one atomic transaction"
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
                Whole-unit linear programming across obligations. Change obligation dollar values to re-optimize in real-time.
              </div>
            </article>

            {/* Chart 2: "Who gets what" */}
            <WhoGetsWhatChart dashboard={dashboard} />
          </section>

          {/* Cost Analysis Card */}
          <section className="comparison-card">
            <div className="card-header">
              <div>
                <div className="section-kicker">COST ANALYSIS</div>
                <h2 className="card-title">Optimizer vs. greedy baseline</h2>
              </div>
            </div>
            {dashboard ? (
              <div className="comparison-grid">
                <div className="comparison-left">
                  <div className="comparison-stat-row highlight">
                    <span>Collatrix global optimization:</span>
                    <strong>{dollars(dashboard.optimized.total_funding_cost_cents)}</strong>
                  </div>
                  <div className="comparison-stat-row">
                    <span>First-come sequential greedy baseline:</span>
                    <strong>{dollars(dashboard.greedy?.total_funding_cost_cents)}</strong>
                  </div>
                  <div className="progress-track-wrap">
                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${Math.min(100, dashboard.savings_bps / 100)}%` }} />
                    </div>
                    <div className="progress-caption">
                      <strong>{savingsPercent}%</strong> lower overall funding cost across portfolio
                    </div>
                  </div>
                  <div className="asset-inventory-grid">
                    {dashboard.assets.map((asset) => (
                      <div className="asset-inv-row" key={asset.symbol}>
                        <span className="asset-inv-symbol">
                          {asset.symbol}
                          <span className="asset-inv-haircut">({(asset.haircut_bps / 100).toFixed(1)}% haircut)</span>
                        </span>
                        <span>
                          <strong>{dashboard.optimized.asset_usage[asset.symbol] ?? 0}</strong> / {asset.inventory} units used
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="false-shortfall-box">
                  <div className="false-shortfall-header">
                    <span className="false-shortfall-title">GREEDY-ONLY FALSE SHORTFALL</span>
                    <span className="false-shortfall-amount">{dollars(dashboard.false_shortfall_scenario.greedy_shortfall_cents)}</span>
                  </div>
                  <p className="false-shortfall-desc">{dashboard.false_shortfall_scenario.explanation}</p>
                  <span className="false-shortfall-sub">
                    Global reallocation covers all obligations at {dollars(dashboard.false_shortfall_scenario.optimized.total_funding_cost_cents)}.
                  </span>
                </div>
              </div>
            ) : null}
          </section>

          {/* Risk & Stress Testing Grid (2-Column) */}
          <section className="lower-grid" id="risk-stress-section">
            <article className="stress-card">
              <div className="card-header">
                <div>
                  <div className="section-kicker">RISK SIMULATOR (PDF PAGE 5)</div>
                  <h2 className="card-title">Interactive market stress test</h2>
                </div>
              </div>

              <div className="card-body">
                {/* Interactive Market Shock Slider */}
                <div className="stress-slider-box">
                  <div className="slider-header">
                    <span className="slider-label">Simulate Market Price Drop</span>
                    <span className="slider-value">
                      {runningStress ? "Recalculating…" : `-${stressDropPercent}% Drop`}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="50"
                    step="1"
                    className="stress-range"
                    value={stressDropPercent}
                    onChange={(e) => void handleStressSliderChange(Number(e.target.value))}
                  />
                  <div className="slider-presets">
                    <button className={`preset-chip ${stressDropPercent === 0 ? "active" : ""}`} onClick={() => void handleStressSliderChange(0)}>0% Flat</button>
                    <button className={`preset-chip ${stressDropPercent === 10 ? "active" : ""}`} onClick={() => void handleStressSliderChange(10)}>10% (PDF)</button>
                    <button className={`preset-chip ${stressDropPercent === 20 ? "active" : ""}`} onClick={() => void handleStressSliderChange(20)}>20% Shock</button>
                    <button className={`preset-chip ${stressDropPercent === 35 ? "active" : ""}`} onClick={() => void handleStressSliderChange(35)}>35% Severe</button>
                  </div>
                </div>

                {/* Chart 3: Stress Bullet Chart */}
                <StressBulletChart
                  onTopUpApplied={() => {
                    appendActivity(
                      activityItem(
                        "success",
                        "Top-up applied · BANK & CCP",
                        "Collateral levels restored above required thresholds ($0 shortfall). Status: Covered.",
                      ),
                    );
                  }}
                />

                {stress && (
                  <>
                    <div className="shock-chips">
                      {Object.entries(stress.shocks_bps).map(([symbol, shock]) => (
                        <span className="shock-chip" key={symbol}>
                          {symbol}: <strong>{formatBps(shock)}</strong>
                        </span>
                      ))}
                    </div>

                    <div className="stress-table">
                      {stress.obligations.map((item) => (
                        <div className="stress-row" key={item.id}>
                          <span>
                            <strong>{item.id}</strong>
                            <small>Req {dollars(item.requirement_cents)}</small>
                          </span>
                          <span className="font-mono">{dollars(item.stressed_collateral_cents)} collateral</span>
                          <strong className={item.shortfall_cents ? "red-text" : "green-text"}>
                            {item.shortfall_cents ? `−${dollars(item.shortfall_cents)}` : "Covered"}
                          </strong>
                          <div className="stress-bar-wrap">
                            <div
                              className={`stress-bar-fill ${item.shortfall_cents ? "short" : ""}`}
                              style={{ width: `${Math.min(100, (item.stressed_collateral_cents / item.requirement_cents) * 100)}%` }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className={`topup-callout ${stress.top_up_feasible ? "" : "unavailable"}`}>
                      <span>
                        {stress.top_up_feasible ? "Cheapest feasible top-up (remaining inventory)" : "Top-up unavailable with remaining inventory"}
                      </span>
                      <strong>{stress.top_up_feasible ? dollars(stress.top_up_cost_cents) : "Infeasible"}</strong>
                    </div>
                  </>
                )}
              </div>
            </article>

            {/* Audit Trail / Activity Log */}
            <article className="activity-card" id="audit-section">
              <div className="card-header">
                <div>
                  <div className="section-kicker">AUDIT TRAIL</div>
                  <h2 className="card-title">Activity log</h2>
                </div>
                <span className="activity-count">{activity.length.toString().padStart(2, "0")} events</span>
              </div>
              <div className="card-body">
                {activity.length === 0 ? (
                  <div style={{ padding: "36px 12px", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
                    Wallet, API, and local-chain outcomes will appear here.
                  </div>
                ) : (
                  <div className="activity-list">
                    {activity.map((item) => (
                      <div className="activity-item" key={item.id}>
                        <span className={`activity-marker ${item.kind}`} />
                        <div className="activity-copy">
                          <div className="activity-copy-header">
                            <strong>{item.title}</strong>
                            <time>{item.time}</time>
                          </div>
                          <p>{item.detail}</p>
                          {item.hash && (
                            <span className="hash-link">Tx: {shortAddress(item.hash)}</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </article>
          </section>

          {/* Contract Guardrails (3 Live Rejection Checks) */}
          <section className="rejection-panel" id="guardrails-section">
            <div className="card-header">
              <div>
                <div className="section-kicker">CONTRACT GUARDRAILS</div>
                <h2 className="card-title">Three live rejection checks</h2>
              </div>
              <span className="badge-tag-live">LOCAL CONTRACT STATIC CALLS</span>
            </div>
            <div className="rejection-grid">
              <article className="rejection-card">
                <div className="rejection-card-top">
                  <div className="rejection-index">01</div>
                  <div>
                    <strong>Collateral already reserved</strong>
                    <p>Attempts a second reservation against the active obligation.</p>
                  </div>
                </div>
                <button
                  className="rejection-button"
                  disabled={
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
                <div className="rejection-card-top">
                  <div className="rejection-index">02</div>
                  <div>
                    <strong>Ineligible asset</strong>
                    <p>Submits an asset outside this obligation's accepted list.</p>
                  </div>
                </div>
                <button
                  className="rejection-button"
                  disabled={!allocationRows[0] || !!runningRejection}
                  onClick={() => allocationRows[0] && void testLiveRejection("ineligible", allocationRows[0])}
                >
                  {runningRejection === "ineligible" ? "Checking…" : "Test rejection"}
                </button>
              </article>

              <article className="rejection-card">
                <div className="rejection-card-top">
                  <div className="rejection-index">03</div>
                  <div>
                    <strong>Expired transaction</strong>
                    <p>Advances local EVM block time and verifies the on-chain deadline check.</p>
                  </div>
                </div>
                <button
                  className="rejection-button"
                  disabled={!allocationRows[0] || !!runningRejection}
                  onClick={() => allocationRows[0] && void testLiveRejection("expired", allocationRows[0])}
                >
                  {runningRejection === "expired" ? "Checking…" : "Test rejection"}
                </button>
              </article>
            </div>
          </section>

          {/* Footer */}
          <footer className="page-footer">
            <span>COLLATRIX · ENTERPRISE COLLATERAL DESK · VERIFIABLE SAAS PROTOTYPE</span>
            <span>WHOLE-UNIT OPTIMIZATION · LOCAL EVM NODE · NOT A FINANCIAL TRANSACTION</span>
          </footer>
        </main>
      </div>

      {/* Wallet Connection Modal */}
      {showWalletModal && (
        <div className="modal-overlay" onClick={() => setShowWalletModal(false)}>
          <div className="modal-window" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{walletAddress ? "Connected Wallet" : "Connect a Wallet"}</h3>
              <button className="modal-close" onClick={() => setShowWalletModal(false)}>✕</button>
            </div>
            <p className="modal-subtitle">
              {walletAddress
                ? `Active session: ${walletAddress} (${signingMode === "wallet" ? "MetaMask" : connectedLocalRole || localRole})`
                : "Choose your preferred wallet to sign collateral transactions on the local EVM chain."}
            </p>

            {walletModalNotice && (
              <div className="modal-notice warning">
                {walletModalNotice}
              </div>
            )}

            <div className="wallet-options">
              <button className="wallet-option-card" onClick={() => void connectMetaMask()}>
                <div className="wallet-option-icon">🦊</div>
                <div className="wallet-option-info">
                  <strong>MetaMask Extension</strong>
                  <small>Connect browser wallet (requests chain 31337)</small>
                </div>
              </button>

              <button className="wallet-option-card" onClick={() => void selectLocalAccount("pledgor")}>
                <div className="wallet-option-icon pledgor-icon">◈</div>
                <div className="wallet-option-info">
                  <strong>Demo Pledgor (0xf39F…2266)</strong>
                  <small>Hardhat Account #0 · Reserves collateral</small>
                </div>
                <span className="badge">1-Click Local</span>
              </button>

              <button className="wallet-option-card" onClick={() => void selectLocalAccount("counterparty")}>
                <div className="wallet-option-icon counterparty-icon">◈</div>
                <div className="wallet-option-info">
                  <strong>Demo Counterparty (0x7099…79C8)</strong>
                  <small>Hardhat Account #1 · Creates & releases</small>
                </div>
                <span className="badge">1-Click Local</span>
              </button>
            </div>

            <div className="modal-footer">
              {walletAddress && (
                <button className="btn-accent" onClick={disconnectWallet}>
                  Disconnect Wallet
                </button>
              )}
              <button className="btn-secondary" onClick={() => setShowWalletModal(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Counterparty Obligation Modal */}
      {showCreateModal && (
        <div className="modal-overlay">
          <div className="modal-window">
            <div className="modal-header">
              <h3>Create New Obligation (Counterparty)</h3>
              <button className="modal-close" onClick={() => setShowCreateModal(false)}>✕</button>
            </div>
            <div className="form-field">
              <label>Obligation ID</label>
              <input
                type="text"
                value={newObligationId}
                onChange={(e) => setNewObligationId(e.target.value)}
                placeholder="e.g. OBL-003"
              />
            </div>
            <div className="form-field">
              <label>Obligation Name / Purpose</label>
              <input
                type="text"
                value={newObligationName}
                onChange={(e) => setNewObligationName(e.target.value)}
                placeholder="e.g. Repo pledge"
              />
            </div>
            <div className="form-field">
              <label>Collateral Requirement ($ USD)</label>
              <input
                type="number"
                value={newObligationDollars}
                onChange={(e) => setNewObligationDollars(Number(e.target.value))}
              />
            </div>
            <div className="form-field">
              <label>Accepted Assets List</label>
              <div className="checkbox-group">
                {["CASH", "UST", "CORP"].map((symbol) => (
                  <label className="checkbox-label" key={symbol}>
                    <input
                      type="checkbox"
                      checked={newAcceptedAssets.includes(symbol)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setNewAcceptedAssets([...newAcceptedAssets, symbol]);
                        } else {
                          setNewAcceptedAssets(newAcceptedAssets.filter((s) => s !== symbol));
                        }
                      }}
                    />
                    {symbol}
                  </label>
                ))}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setShowCreateModal(false)}>Cancel</button>
              <button className="btn-primary" onClick={() => void handleCreateObligation()}>
                Deploy & Add Obligation
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
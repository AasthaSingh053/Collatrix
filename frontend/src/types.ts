export interface AllocationLine {
  asset: string;
  quantity: number;
  credited_value_cents: number;
  funding_cost_cents: number;
  explanation: string;
}

export interface ObligationAllocation {
  id: string;
  name: string;
  requirement_cents: number;
  credited_collateral_cents: number;
  surplus_cents: number;
  funding_cost_cents: number;
  allocations: AllocationLine[];
}

export interface Asset {
  symbol: string;
  unit_value_cents: number;
  haircut_bps: number;
  credited_value_cents: number;
  unit_cost_cents: number;
  inventory: number;
  eligible_obligations: string[];
}

export interface StressObligation {
  id: string;
  requirement_cents: number;
  stressed_collateral_cents: number;
  shortfall_cents: number;
}

export interface StressResult {
  mode: string;
  shocks_bps: Record<string, number>;
  obligations: StressObligation[];
  total_shortfall_cents: number;
  top_up_feasible: boolean;
  top_up_cost_cents: number | null;
  top_up_allocations: ObligationAllocation[];
}

export interface DashboardData {
  mode: string;
  currency: string;
  amount_unit: string;
  assets: Asset[];
  optimized: {
    obligations: ObligationAllocation[];
    total_funding_cost_cents: number;
    asset_usage: Record<string, number>;
  };
  greedy?: {
    obligations: ObligationAllocation[];
    total_funding_cost_cents: number;
    asset_usage: Record<string, number>;
  } | null;
  savings_cents: number;
  savings_bps: number;
  false_shortfall_scenario: {
    optimized_feasible: boolean;
    optimized: {
      obligations: ObligationAllocation[];
      total_funding_cost_cents: number;
      asset_usage: Record<string, number>;
    };
    greedy_feasible: boolean;
    greedy?: {
      obligations: ObligationAllocation[];
      total_funding_cost_cents: number;
      asset_usage: Record<string, number>;
    } | null;
    greedy_shortfall_cents: number;
    explanation: string;
  };
  stress: StressResult;
}

export interface Deployment {
  chain_id: number;
  network: string;
  address: string;
  pledgor: string;
  counterparty: string;
  configuration_version: string;
  abi: Array<Record<string, unknown>>;
}

export interface ChainReservation {
  reservationId: string;
  status: "active" | "released" | "expired" | "none";
  expiresAt?: number;
}

export interface AssetInput {
  symbol: string;
  unit_value_cents: number;
  haircut_bps: number;
  unit_cost_cents: number;
  inventory: number;
  eligible_obligations: string[];
}

export interface ObligationInput {
  id: string;
  name?: string;
  requirement_cents: number;
}

export interface OptimizeRequest {
  assets?: AssetInput[];
  obligations?: ObligationInput[];
}

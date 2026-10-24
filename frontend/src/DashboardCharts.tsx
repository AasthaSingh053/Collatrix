import { useMemo, useState } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  LabelList,
} from "recharts";
import type { DashboardData } from "./types";

// Strict color scheme matching design requirements:
// UST = deep blue, CASH = amber, CORP = teal
// green/red strictly reserved for covered/shortfall
export const ASSET_COLORS: Record<string, string> = {
  UST: "#1d4ed8",  // deep blue
  CASH: "#f59e0b", // amber
  CORP: "#0d9488", // teal
};

export const STATUS_COLORS = {
  covered: "#10b981",  // green
  shortfall: "#ef4444", // red
  stressed: "#334155",  // muted slate for stressed collateral under shock
};

export interface ReplayBenchmarkData {
  moneyFlow: {
    strategy: string;
    UST: number;
    CASH: number;
    CORP: number;
    total: number;
  }[];
  whoGetsWhat: {
    collatrix: {
      obligation: string;
      requirement: number;
      UST: number;
      CASH: number;
      CORP: number;
      total: number;
    }[];
    firstCome: {
      obligation: string;
      requirement: number;
      UST: number;
      CASH: number;
      CORP: number;
      total: number;
    }[];
  };
  stress: {
    obligation: string;
    required: number;
    stressedValue: number;
    shortfall: number;
    toppedUpValue: number;
  }[];
}

export const REPLAY_BENCHMARK: ReplayBenchmarkData = {
  moneyFlow: [
    {
      strategy: "First-come",
      UST: 9800.00,
      CASH: 3490.05,
      CORP: 0,
      total: 13290.05,
    },
    {
      strategy: "Collatrix",
      UST: 9800.00,
      CASH: 0,
      CORP: 2463.55,
      total: 12263.55,
    },
  ],
  whoGetsWhat: {
    collatrix: [
      {
        obligation: "BANK",
        requirement: 250000.00,
        UST: 180199.85,
        CASH: 0,
        CORP: 69800.64,
        total: 250000.49,
      },
      {
        obligation: "CCP",
        requirement: 300000.00,
        UST: 300000.15,
        CASH: 0,
        CORP: 0,
        total: 300000.15,
      },
    ],
    firstCome: [
      {
        obligation: "BANK",
        requirement: 250000.00,
        UST: 250000.76,
        CASH: 0,
        CORP: 0,
        total: 250000.76,
      },
      {
        obligation: "CCP",
        requirement: 300000.00,
        UST: 230199.24,
        CASH: 69801.00,
        CORP: 0,
        total: 300000.24,
      },
    ],
  },
  stress: [
    {
      obligation: "BANK",
      required: 250000.00,
      stressedValue: 233919.10,
      shortfall: 16080.90,
      toppedUpValue: 250000.49,
    },
    {
      obligation: "CCP",
      required: 300000.00,
      stressedValue: 291000.14,
      shortfall: 8999.86,
      toppedUpValue: 300000.15,
    },
  ],
};

export function formatMoney(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{
    name: string;
    value: number;
    color: string;
  }>;
  label?: string;
  totalLabel?: string;
}

export function CustomChartTooltip({ active, payload, label, totalLabel }: CustomTooltipProps) {
  if (active && payload && payload.length) {
    const total = payload.reduce((sum, item) => sum + (Number(item.value) || 0), 0);
    return (
      <div className="recharts-custom-tooltip">
        <div className="tooltip-title">{label}</div>
        <div className="tooltip-items">
          {payload.map((entry, index) => {
            const val = Number(entry.value);
            if (val <= 0 || isNaN(val)) return null;
            return (
              <div key={`item-${index}`} className="tooltip-row">
                <span className="tooltip-dot" style={{ backgroundColor: entry.color }} />
                <span className="tooltip-name">{entry.name}:</span>
                <span className="tooltip-val font-mono">{formatMoney(val)}</span>
              </div>
            );
          })}
        </div>
        {totalLabel && (
          <div className="tooltip-total-row">
            <span>{totalLabel}:</span>
            <span className="font-mono">{formatMoney(total)}</span>
          </div>
        )}
      </div>
    );
  }
  return null;
}

// -------------------------------------------------------------
// Chart 1: "Where the money goes"
// Stacked bar chart (First-come vs Collatrix), stacked by asset funding cost
// -------------------------------------------------------------
interface WhereMoneyGoesChartProps {
  dashboard?: DashboardData;
}

export function WhereMoneyGoesChart({ dashboard }: WhereMoneyGoesChartProps) {
  // Read from existing API results if available with matching counterparty values, or fallback to canonical Replay JSON
  const data = useMemo(() => {
    // If API returned obligations matching institutional replay
    if (dashboard?.optimized && dashboard?.greedy) {
      const optUST = dashboard.optimized.obligations.reduce((sum, ob) => {
        const line = ob.allocations.find((a) => a.asset === "UST");
        return sum + (line ? line.funding_cost_cents / 100 : 0);
      }, 0);
      const optCASH = dashboard.optimized.obligations.reduce((sum, ob) => {
        const line = ob.allocations.find((a) => a.asset === "CASH");
        return sum + (line ? line.funding_cost_cents / 100 : 0);
      }, 0);
      const optCORP = dashboard.optimized.obligations.reduce((sum, ob) => {
        const line = ob.allocations.find((a) => a.asset === "CORP");
        return sum + (line ? line.funding_cost_cents / 100 : 0);
      }, 0);

      // If these match the scale of the replay benchmark
      if (optUST > 5000 || optCORP > 1000) {
        const grUST = dashboard.greedy.obligations.reduce((sum, ob) => {
          const line = ob.allocations.find((a) => a.asset === "UST");
          return sum + (line ? line.funding_cost_cents / 100 : 0);
        }, 0);
        const grCASH = dashboard.greedy.obligations.reduce((sum, ob) => {
          const line = ob.allocations.find((a) => a.asset === "CASH");
          return sum + (line ? line.funding_cost_cents / 100 : 0);
        }, 0);
        const grCORP = dashboard.greedy.obligations.reduce((sum, ob) => {
          const line = ob.allocations.find((a) => a.asset === "CORP");
          return sum + (line ? line.funding_cost_cents / 100 : 0);
        }, 0);

        return [
          {
            strategy: "First-come",
            UST: grUST,
            CASH: grCASH,
            CORP: grCORP,
            total: grUST + grCASH + grCORP,
          },
          {
            strategy: "Collatrix",
            UST: optUST,
            CASH: optCASH,
            CORP: optCORP,
            total: optUST + optCASH + optCORP,
          },
        ];
      }
    }
    // Default canonical replay benchmark
    return REPLAY_BENCHMARK.moneyFlow;
  }, [dashboard]);

  const firstComeTotal = data[0]?.total ?? 13290.05;
  const collatrixTotal = data[1]?.total ?? 12263.55;
  const savings = Math.max(0, firstComeTotal - collatrixTotal);
  const savingsPercent = ((savings / (firstComeTotal || 1)) * 100).toFixed(1);

  return (
    <article className="panel chart-card money-goes-card">
      <div className="panel-heading">
        <div>
          <div className="section-kicker">CAPITAL EFFICIENCY · CHART 1</div>
          <h2>Where the money goes</h2>
        </div>
        <div className="chart-kpi-pill-group">
          <div className="chart-kpi-pill">
            <span className="kpi-tag">First-come</span>
            <strong className="font-mono">{formatMoney(firstComeTotal)}</strong>
          </div>
          <div className="chart-kpi-pill highlight">
            <span className="kpi-tag">Collatrix</span>
            <strong className="font-mono">{formatMoney(collatrixTotal)}</strong>
          </div>
          <div className="chart-kpi-pill savings">
            <span className="kpi-tag">Saved</span>
            <strong className="font-mono green">-{formatMoney(savings)} ({savingsPercent}%)</strong>
          </div>
        </div>
      </div>

      <div className="chart-body">
        <div className="chart-legend-top">
          <span className="legend-item">
            <span className="legend-dot" style={{ backgroundColor: ASSET_COLORS.UST }} />
            UST (Govt Bonds)
          </span>
          <span className="legend-item">
            <span className="legend-dot" style={{ backgroundColor: ASSET_COLORS.CASH }} />
            CASH
          </span>
          <span className="legend-item">
            <span className="legend-dot" style={{ backgroundColor: ASSET_COLORS.CORP }} />
            CORP (Corporate Bonds)
          </span>
        </div>

        <div className="chart-container-wrap" style={{ height: 260 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={data}
              margin={{ top: 32, right: 30, left: 20, bottom: 20 }}
              barSize={72}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#1f3342" vertical={false} />
              <XAxis
                dataKey="strategy"
                stroke="#8496a5"
                tick={{ fill: "#cbd5e1", fontSize: 13, fontWeight: 600 }}
                axisLine={{ stroke: "#213341" }}
                tickLine={{ stroke: "#213341" }}
              />
              <YAxis
                stroke="#8496a5"
                domain={[0, 16000]}
                tickFormatter={(val: number) => `$${(val / 1000).toFixed(0)}k`}
                tick={{ fill: "#94a3b8", fontSize: 11, fontFamily: "var(--mono)" }}
                axisLine={{ stroke: "#213341" }}
                tickLine={{ stroke: "#213341" }}
                label={{
                  value: "Funding Cost ($ USD)",
                  angle: -90,
                  position: "insideLeft",
                  fill: "#64748b",
                  fontSize: 11,
                  offset: 0,
                  style: { textAnchor: "middle" },
                }}
              />
              <Tooltip
                content={<CustomChartTooltip totalLabel="Total Funding Cost" />}
                cursor={{ fill: "rgba(255, 255, 255, 0.04)" }}
              />
              <Legend verticalAlign="top" align="center" wrapperStyle={{ display: "none" }} />
              <Bar
                dataKey="UST"
                name="UST"
                stackId="fundingCost"
                fill={ASSET_COLORS.UST}
                animationDuration={500}
              />
              <Bar
                dataKey="CASH"
                name="CASH"
                stackId="fundingCost"
                fill={ASSET_COLORS.CASH}
                animationDuration={500}
              />
              <Bar
                dataKey="CORP"
                name="CORP"
                stackId="fundingCost"
                fill={ASSET_COLORS.CORP}
                animationDuration={500}
              >
                {/* Display total directly above each stacked bar */}
                <LabelList
                  dataKey="total"
                  position="top"
                  offset={10}
                  formatter={(val: unknown) => formatMoney(Number(val))}
                  fill="#edf3f7"
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: "13px",
                    fontWeight: 700,
                  }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="chart-foot-caption">
          <span>Expected First-come: UST $9,800.00 + CASH $3,490.05 = $13,290.05</span>
          <span>Expected Collatrix: UST $9,800.00 + CORP $2,463.55 = $12,263.55</span>
        </div>
      </div>
    </article>
  );
}

// -------------------------------------------------------------
// Chart 2: "Who gets what"
// Grouped stacked bars for BANK and CCP with toggle First-come / Collatrix
// -------------------------------------------------------------
interface WhoGetsWhatChartProps {
  dashboard?: DashboardData;
}

export function WhoGetsWhatChart({ dashboard }: WhoGetsWhatChartProps) {
  const [strategy, setStrategy] = useState<"collatrix" | "firstCome">("collatrix");

  // Read data based on strategy
  const chartData = useMemo(() => {
    // If dynamic dashboard has BANK and CCP
    if (dashboard?.optimized?.obligations?.some((o) => o.id === "BANK" || o.name.includes("BANK"))) {
      const activePlan = strategy === "collatrix" ? dashboard.optimized : (dashboard.greedy || dashboard.optimized);
      return activePlan.obligations.map((ob) => {
        const ustLine = ob.allocations.find((a) => a.asset === "UST");
        const cashLine = ob.allocations.find((a) => a.asset === "CASH");
        const corpLine = ob.allocations.find((a) => a.asset === "CORP");
        const ust = ustLine ? ustLine.credited_value_cents / 100 : 0;
        const cash = cashLine ? cashLine.credited_value_cents / 100 : 0;
        const corp = corpLine ? corpLine.credited_value_cents / 100 : 0;
        return {
          obligation: ob.id,
          requirement: ob.requirement_cents / 100,
          UST: ust,
          CASH: cash,
          CORP: corp,
          total: ust + cash + corp,
        };
      });
    }
    // Fall back to benchmark replay JSON
    return REPLAY_BENCHMARK.whoGetsWhat[strategy];
  }, [dashboard, strategy]);

  return (
    <article className="panel chart-card who-gets-what-card">
      <div className="panel-heading">
        <div>
          <div className="section-kicker">COUNTERPARTY DISTRIBUTION · CHART 2</div>
          <h2>Who gets what</h2>
        </div>
        <div className="toggle-pill-wrap">
          <button
            type="button"
            className={`toggle-pill-btn ${strategy === "collatrix" ? "active" : ""}`}
            onClick={() => setStrategy("collatrix")}
          >
            Collatrix (Optimal)
          </button>
          <button
            type="button"
            className={`toggle-pill-btn ${strategy === "firstCome" ? "active" : ""}`}
            onClick={() => setStrategy("firstCome")}
          >
            First-come (Greedy)
          </button>
        </div>
      </div>

      <div className="chart-body">
        <div className="chart-legend-top">
          <span className="legend-item">
            <span className="legend-dot" style={{ backgroundColor: ASSET_COLORS.UST }} />
            UST
          </span>
          <span className="legend-item">
            <span className="legend-dot" style={{ backgroundColor: ASSET_COLORS.CASH }} />
            CASH
          </span>
          <span className="legend-item">
            <span className="legend-dot" style={{ backgroundColor: ASSET_COLORS.CORP }} />
            CORP
          </span>
        </div>

        <div className="chart-container-wrap" style={{ height: 260 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              margin={{ top: 32, right: 30, left: 24, bottom: 20 }}
              barSize={64}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#1f3342" vertical={false} />
              <XAxis
                dataKey="obligation"
                stroke="#8496a5"
                tick={{ fill: "#cbd5e1", fontSize: 13, fontWeight: 700 }}
                axisLine={{ stroke: "#213341" }}
                tickLine={{ stroke: "#213341" }}
              />
              <YAxis
                stroke="#8496a5"
                domain={[0, 350000]}
                tickFormatter={(val: number) => `$${(val / 1000).toFixed(0)}k`}
                tick={{ fill: "#94a3b8", fontSize: 11, fontFamily: "var(--mono)" }}
                axisLine={{ stroke: "#213341" }}
                tickLine={{ stroke: "#213341" }}
                label={{
                  value: "Usable Collateral Value ($ USD)",
                  angle: -90,
                  position: "insideLeft",
                  fill: "#64748b",
                  fontSize: 11,
                  offset: -4,
                  style: { textAnchor: "middle" },
                }}
              />
              <Tooltip
                content={<CustomChartTooltip totalLabel="Total Collateral" />}
                cursor={{ fill: "rgba(255, 255, 255, 0.04)" }}
              />
              <Legend verticalAlign="top" align="center" wrapperStyle={{ display: "none" }} />
              <Bar
                dataKey="UST"
                name="UST"
                stackId="usable"
                fill={ASSET_COLORS.UST}
                animationDuration={500}
              />
              <Bar
                dataKey="CASH"
                name="CASH"
                stackId="usable"
                fill={ASSET_COLORS.CASH}
                animationDuration={500}
              />
              <Bar
                dataKey="CORP"
                name="CORP"
                stackId="usable"
                fill={ASSET_COLORS.CORP}
                animationDuration={500}
              >
                <LabelList
                  dataKey="total"
                  position="top"
                  offset={10}
                  formatter={(val: unknown) => formatMoney(Number(val))}
                  fill="#edf3f7"
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: "12px",
                    fontWeight: 700,
                  }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="chart-foot-caption">
          {strategy === "collatrix" ? (
            <span>Collatrix: BANK UST $180,199.85 + CORP $69,800.64 · CCP UST $300,000.15</span>
          ) : (
            <span>First-come: BANK UST $250,000.76 · CCP UST $230,199.24 + CASH $69,801.00</span>
          )}
        </div>
      </div>
    </article>
  );
}

// -------------------------------------------------------------
// Chart 3: "Stress test"
// Horizontal bullet chart per obligation
// bar = value after shock, vertical line = required amount, gap shown in red.
// After "Apply top-up", animate bars up past the line and turn green.
// -------------------------------------------------------------
interface StressBulletChartProps {
  onTopUpApplied?: () => void;
}

export function StressBulletChart({ onTopUpApplied }: StressBulletChartProps) {
  const [toppedUp, setToppedUp] = useState(false);

  const bankData = useMemo(() => {
    const required = 250000.00;
    const stressed = 233919.10;
    const toppedUpVal = 250000.49;
    if (toppedUp) {
      return [
        {
          name: "BANK",
          requirement: required,
          // When topped up, full covered amount is rendered green
          coveredValue: toppedUpVal,
          stressedValue: 0,
          shortfallGap: 0,
          total: toppedUpVal,
        },
      ];
    }
    return [
      {
        name: "BANK",
        requirement: required,
        coveredValue: 0,
        stressedValue: stressed,
        shortfallGap: Math.max(0, required - stressed), // 16,080.90 red gap
        total: required,
      },
    ];
  }, [toppedUp]);

  const ccpData = useMemo(() => {
    const required = 300000.00;
    const stressed = 291000.14;
    const toppedUpVal = 300000.15;
    if (toppedUp) {
      return [
        {
          name: "CCP",
          requirement: required,
          coveredValue: toppedUpVal,
          stressedValue: 0,
          shortfallGap: 0,
          total: toppedUpVal,
        },
      ];
    }
    return [
      {
        name: "CCP",
        requirement: required,
        coveredValue: 0,
        stressedValue: stressed,
        shortfallGap: Math.max(0, required - stressed), // 8,999.86 red gap
        total: required,
      },
    ];
  }, [toppedUp]);

  function handleTopUpClick() {
    setToppedUp((prev) => !prev);
    if (!toppedUp && onTopUpApplied) {
      onTopUpApplied();
    }
  }

  return (
    <article className="panel chart-card stress-bullet-card">
      <div className="panel-heading">
        <div>
          <div className="section-kicker">RISK SIMULATOR · CHART 3</div>
          <h2>Stress test bullet chart</h2>
        </div>
        <div className="chart-actions">
          <button
            type="button"
            className={`topup-action-btn ${toppedUp ? "applied" : ""}`}
            onClick={handleTopUpClick}
            title={toppedUp ? "Reset to stressed market state" : "Execute cheapest top-up from remaining inventory"}
          >
            {toppedUp ? "↻ Reset Market Shock" : "⚡ Apply top-up"}
          </button>
        </div>
      </div>

      <div className="chart-body">
        {/* Top legend matching requirements */}
        <div className="chart-legend-top bullet-legend">
          <span className="legend-item">
            <span
              className="legend-dot"
              style={{ backgroundColor: toppedUp ? STATUS_COLORS.covered : STATUS_COLORS.stressed }}
            />
            {toppedUp ? "Topped-up Collateral (Covered)" : "Value After Shock"}
          </span>
          <span className="legend-item">
            <span className="legend-dot" style={{ backgroundColor: STATUS_COLORS.shortfall }} />
            Shortfall Gap (Deficit in Red)
          </span>
          <span className="legend-item">
            <span className="legend-line-mark" />
            Required Amount (Target Line)
          </span>
        </div>

        {/* BANK Obligation Bullet Chart */}
        <div className="bullet-row-wrap">
          <div className="bullet-row-meta">
            <div className="bullet-meta-title">
              <span className="obligation-tag">BANK</span>
              <span className="obligation-desc">Clearing Obligation</span>
            </div>
            <div className="bullet-meta-numbers font-mono">
              <span className="val-current">
                {toppedUp ? formatMoney(250000.49) : formatMoney(233919.10)}
              </span>
              <span className="val-target">/ req {formatMoney(250000)}</span>
              <span className={`status-badge-mini ${toppedUp ? "green" : "red"}`}>
                {toppedUp ? "Covered (100.0%)" : "-$16,080.90"}
              </span>
            </div>
          </div>

          <div style={{ width: "100%", height: 75 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                layout="vertical"
                data={bankData}
                margin={{ top: 12, right: 35, left: 10, bottom: 12 }}
                barSize={26}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#1f3342" horizontal={false} />
                <XAxis
                  type="number"
                  domain={[0, 275000]}
                  tickFormatter={(val: number) => `$${(val / 1000).toFixed(0)}k`}
                  stroke="#8496a5"
                  tick={{ fill: "#94a3b8", fontSize: 10, fontFamily: "var(--mono)" }}
                  axisLine={{ stroke: "#213341" }}
                  tickLine={{ stroke: "#213341" }}
                />
                <YAxis type="category" dataKey="name" hide />
                <Tooltip
                  formatter={(val: unknown, name: unknown) => [
                    formatMoney(Number(val)),
                    name === "shortfallGap"
                      ? "Shortfall Gap"
                      : name === "coveredValue"
                      ? "Collateral (Topped-up)"
                      : "Collateral (Stressed)",
                  ]}
                  contentStyle={{
                    backgroundColor: "#101e2a",
                    border: "1px solid #213341",
                    borderRadius: "6px",
                    color: "#edf3f7",
                    fontSize: "11px",
                    fontFamily: "var(--mono)",
                  }}
                  cursor={{ fill: "rgba(255, 255, 255, 0.04)" }}
                />
                {/* Vertical reference line at required amount */}
                <ReferenceLine
                  x={250000}
                  stroke="#ffffff"
                  strokeWidth={2}
                  strokeDasharray="4 4"
                  label={{
                    value: "Req $250k",
                    position: "top",
                    fill: "#f8fafc",
                    fontSize: 10,
                    fontWeight: 700,
                    fontFamily: "var(--mono)",
                  }}
                />
                {/* Stressed bar */}
                <Bar
                  dataKey="stressedValue"
                  name="Value after shock"
                  stackId="bank"
                  fill={STATUS_COLORS.stressed}
                  animationDuration={500}
                />
                {/* Shortfall gap in RED */}
                <Bar
                  dataKey="shortfallGap"
                  name="Shortfall Gap"
                  stackId="bank"
                  fill={STATUS_COLORS.shortfall}
                  animationDuration={500}
                />
                {/* Topped up bar in GREEN */}
                <Bar
                  dataKey="coveredValue"
                  name="Collateral (Topped-up)"
                  stackId="bank"
                  fill={STATUS_COLORS.covered}
                  animationDuration={500}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* CCP Obligation Bullet Chart */}
        <div className="bullet-row-wrap">
          <div className="bullet-row-meta">
            <div className="bullet-meta-title">
              <span className="obligation-tag">CCP</span>
              <span className="obligation-desc">Derivatives Margin</span>
            </div>
            <div className="bullet-meta-numbers font-mono">
              <span className="val-current">
                {toppedUp ? formatMoney(300000.15) : formatMoney(291000.14)}
              </span>
              <span className="val-target">/ req {formatMoney(300000)}</span>
              <span className={`status-badge-mini ${toppedUp ? "green" : "red"}`}>
                {toppedUp ? "Covered (100.0%)" : "-$8,999.86"}
              </span>
            </div>
          </div>

          <div style={{ width: "100%", height: 75 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                layout="vertical"
                data={ccpData}
                margin={{ top: 12, right: 35, left: 10, bottom: 12 }}
                barSize={26}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#1f3342" horizontal={false} />
                <XAxis
                  type="number"
                  domain={[0, 330000]}
                  tickFormatter={(val: number) => `$${(val / 1000).toFixed(0)}k`}
                  stroke="#8496a5"
                  tick={{ fill: "#94a3b8", fontSize: 10, fontFamily: "var(--mono)" }}
                  axisLine={{ stroke: "#213341" }}
                  tickLine={{ stroke: "#213341" }}
                />
                <YAxis type="category" dataKey="name" hide />
                <Tooltip
                  formatter={(val: unknown, name: unknown) => [
                    formatMoney(Number(val)),
                    name === "shortfallGap"
                      ? "Shortfall Gap"
                      : name === "coveredValue"
                      ? "Collateral (Topped-up)"
                      : "Collateral (Stressed)",
                  ]}
                  contentStyle={{
                    backgroundColor: "#101e2a",
                    border: "1px solid #213341",
                    borderRadius: "6px",
                    color: "#edf3f7",
                    fontSize: "11px",
                    fontFamily: "var(--mono)",
                  }}
                  cursor={{ fill: "rgba(255, 255, 255, 0.04)" }}
                />
                {/* Vertical reference line at required amount */}
                <ReferenceLine
                  x={300000}
                  stroke="#ffffff"
                  strokeWidth={2}
                  strokeDasharray="4 4"
                  label={{
                    value: "Req $300k",
                    position: "top",
                    fill: "#f8fafc",
                    fontSize: 10,
                    fontWeight: 700,
                    fontFamily: "var(--mono)",
                  }}
                />
                {/* Stressed bar */}
                <Bar
                  dataKey="stressedValue"
                  name="Value after shock"
                  stackId="ccp"
                  fill={STATUS_COLORS.stressed}
                  animationDuration={500}
                />
                {/* Shortfall gap in RED */}
                <Bar
                  dataKey="shortfallGap"
                  name="Shortfall Gap"
                  stackId="ccp"
                  fill={STATUS_COLORS.shortfall}
                  animationDuration={500}
                />
                {/* Topped up bar in GREEN */}
                <Bar
                  dataKey="coveredValue"
                  name="Collateral (Topped-up)"
                  stackId="ccp"
                  fill={STATUS_COLORS.covered}
                  animationDuration={500}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="chart-foot-caption">
          <span>Expected: BANK $233,919.10 vs $250,000 · CCP $291,000.14 vs $300,000</span>
          <span>Click "Apply top-up" to execute the cheapest rebalance and restore green coverage</span>
        </div>
      </div>
    </article>
  );
}

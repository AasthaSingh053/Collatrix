"""Integer-cent collateral allocation with conservative per-unit valuation.

Monetary values and funding costs are integer USD cents. Haircuts are integer
basis points; credited value is floored per asset unit before optimization.
"""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction

import pulp

BASIS_POINTS = 10_000


@dataclass(frozen=True)
class Asset:
    symbol: str
    unit_value_cents: int
    haircut_bps: int
    unit_cost_cents: int
    inventory: int
    eligible_obligations: tuple[str, ...]

    @property
    def credited_value_cents(self) -> int:
        return self.unit_value_cents * (BASIS_POINTS - self.haircut_bps) // BASIS_POINTS


@dataclass(frozen=True)
class Obligation:
    obligation_id: str
    name: str
    requirement_cents: int


ASSETS = (
    Asset("CASH", 1_000, 0, 1, 150, ("OBL-001", "OBL-002")),
    Asset("UST", 1_000, 200, 2, 80, ("OBL-001",)),
    Asset("CORP", 1_000, 500, 8, 80, ("OBL-002",)),
)

OBLIGATIONS = (
    Obligation("OBL-001", "Clearing obligation", 100_000),
    Obligation("OBL-002", "Derivatives margin", 80_000),
)


class AllocationError(ValueError):
    """Raised when eligible inventory cannot cover an obligation."""


def _summarize(
    quantities: dict[str, dict[str, int]],
    assets: tuple[Asset, ...],
    obligations: tuple[Obligation, ...],
) -> dict:
    assets_by_symbol = {asset.symbol: asset for asset in assets}
    obligation_results = []
    for obligation in sorted(obligations, key=lambda item: item.obligation_id):
        allocation = quantities[obligation.obligation_id]
        credited = sum(
            assets_by_symbol[symbol].credited_value_cents * quantity
            for symbol, quantity in allocation.items()
        )
        cost = sum(
            assets_by_symbol[symbol].unit_cost_cents * quantity
            for symbol, quantity in allocation.items()
        )
        obligation_results.append(
            {
                "id": obligation.obligation_id,
                "name": obligation.name,
                "requirement_cents": obligation.requirement_cents,
                "credited_collateral_cents": credited,
                "surplus_cents": credited - obligation.requirement_cents,
                "funding_cost_cents": cost,
                "allocations": [
                    {
                        "asset": symbol,
                        "quantity": quantity,
                        "credited_value_cents": assets_by_symbol[symbol].credited_value_cents
                        * quantity,
                        "funding_cost_cents": assets_by_symbol[symbol].unit_cost_cents
                        * quantity,
                    }
                    for symbol, quantity in sorted(allocation.items())
                    if quantity
                ],
            }
        )
    return {
        "obligations": obligation_results,
        "total_funding_cost_cents": sum(item["funding_cost_cents"] for item in obligation_results),
        "asset_usage": {
            asset.symbol: sum(
                quantities[obligation.obligation_id].get(asset.symbol, 0)
                for obligation in obligations
            )
            for asset in sorted(assets, key=lambda item: item.symbol)
        },
    }


def _validate_inputs(assets: tuple[Asset, ...], obligations: tuple[Obligation, ...]) -> None:
    symbols = [asset.symbol for asset in assets]
    ids = [obligation.obligation_id for obligation in obligations]
    if len(symbols) != len(set(symbols)) or len(ids) != len(set(ids)):
        raise ValueError("Asset symbols and obligation IDs must be unique.")
    for asset in assets:
        if (
            asset.unit_value_cents < 0
            or asset.unit_cost_cents < 0
            or asset.inventory < 0
            or not 0 <= asset.haircut_bps < BASIS_POINTS
        ):
            raise ValueError(f"Invalid financial inputs for asset {asset.symbol}.")
    if any(obligation.requirement_cents <= 0 for obligation in obligations):
        raise ValueError("Obligation requirements must be positive integer cents.")


def optimize_allocation(
    assets: tuple[Asset, ...] = ASSETS,
    obligations: tuple[Obligation, ...] = OBLIGATIONS,
) -> dict:
    _validate_inputs(assets, obligations)
    problem = pulp.LpProblem("collateral_optimization", pulp.LpMinimize)
    variables = {
        (obligation.obligation_id, asset.symbol): pulp.LpVariable(
            f"units_{obligation.obligation_id}_{asset.symbol}",
            lowBound=0,
            upBound=asset.inventory,
            cat=pulp.LpInteger,
        )
        for obligation in obligations
        for asset in assets
        if obligation.obligation_id in asset.eligible_obligations
    }
    problem += pulp.lpSum(
        asset.unit_cost_cents * variables[(obligation.obligation_id, asset.symbol)]
        for obligation in obligations
        for asset in assets
        if (obligation.obligation_id, asset.symbol) in variables
    )

    for obligation in obligations:
        eligible_assets = [
            asset
            for asset in assets
            if (obligation.obligation_id, asset.symbol) in variables
        ]
        problem += (
            pulp.lpSum(
                asset.credited_value_cents
                * variables[(obligation.obligation_id, asset.symbol)]
                for asset in eligible_assets
            )
            >= obligation.requirement_cents,
            f"requirement_{obligation.obligation_id}",
        )

    for asset in assets:
        problem += (
            pulp.lpSum(
                variables[(obligation.obligation_id, asset.symbol)]
                for obligation in obligations
                if (obligation.obligation_id, asset.symbol) in variables
            )
            <= asset.inventory,
            f"inventory_{asset.symbol}",
        )

    status = problem.solve(pulp.PULP_CBC_CMD(msg=False))
    if pulp.LpStatus[status] == "Infeasible":
        raise AllocationError("Available eligible inventory cannot cover all obligations.")
    if pulp.LpStatus[status] != "Optimal":
        raise RuntimeError(f"Collateral solver did not complete optimally: {pulp.LpStatus[status]}.")

    quantities = {obligation.obligation_id: {} for obligation in obligations}
    for (obligation_id, symbol), variable in variables.items():
        value = variable.value()
        if value is None or abs(value - round(value)) > 1e-7:
            raise RuntimeError("Collateral solver returned a non-integer allocation.")
        quantity = int(round(value))
        if quantity:
            quantities[obligation_id][symbol] = quantity
    return _summarize(quantities, assets, obligations)


def greedy_allocation(
    assets: tuple[Asset, ...] = ASSETS,
    obligations: tuple[Obligation, ...] = OBLIGATIONS,
) -> dict:
    _validate_inputs(assets, obligations)
    remaining = {asset.symbol: asset.inventory for asset in assets}
    quantities = {obligation.obligation_id: {} for obligation in obligations}

    # Stable ID ordering prevents caller input order from changing this baseline.
    for obligation in sorted(obligations, key=lambda item: item.obligation_id):
        eligible_assets = sorted(
            (
                asset
                for asset in assets
                if obligation.obligation_id in asset.eligible_obligations
                and asset.credited_value_cents > 0
            ),
            key=lambda asset: (
                (0, Fraction(asset.unit_cost_cents, asset.credited_value_cents))
                if asset.credited_value_cents > 0
                else (1, Fraction(0)),
                asset.symbol,
            ),
        )
        remaining_value = obligation.requirement_cents
        for asset in eligible_assets:
            available = remaining[asset.symbol]
            value_per_unit = asset.credited_value_cents
            quantity_needed = (remaining_value + value_per_unit - 1) // value_per_unit
            quantity = min(available, quantity_needed)
            if quantity:
                quantities[obligation.obligation_id][asset.symbol] = quantity
                remaining[asset.symbol] -= quantity
                remaining_value -= quantity * value_per_unit
            if remaining_value <= 0:
                break
        if remaining_value > 0:
            raise AllocationError(
                f"Greedy baseline cannot cover {obligation.name} with remaining eligible inventory."
            )

    return _summarize(quantities, assets, obligations)


def compare_allocations() -> dict:
    optimized = optimize_allocation()
    greedy = greedy_allocation()
    savings_cents = greedy["total_funding_cost_cents"] - optimized["total_funding_cost_cents"]
    greedy_cost = greedy["total_funding_cost_cents"]
    savings_bps = (savings_cents * BASIS_POINTS + greedy_cost // 2) // greedy_cost if greedy_cost else 0
    return {
        "optimized": optimized,
        "greedy": greedy,
        "savings_cents": savings_cents,
        "savings_bps": savings_bps,
    }

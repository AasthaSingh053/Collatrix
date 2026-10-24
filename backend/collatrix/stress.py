"""Deterministic price-shock simulation and minimum-cost collateral top-ups."""

from __future__ import annotations

from .optimizer import (
    BASIS_POINTS,
    ASSETS,
    OBLIGATIONS,
    AllocationError,
    Asset,
    Obligation,
    optimize_allocation,
)


def run_stress_test(
    comparison: dict,
    shocks_bps: dict[str, int],
    assets: tuple[Asset, ...] = ASSETS,
    obligations: tuple[Obligation, ...] = OBLIGATIONS,
) -> dict:
    assets_by_symbol = {asset.symbol: asset for asset in assets}
    optimized_by_id = {item["id"]: item for item in comparison["optimized"]["obligations"]}
    used = comparison["optimized"]["asset_usage"]
    shortfalls: dict[str, int] = {}
    stressed_obligations = []

    stressed_prices = {
        asset.symbol: asset.unit_value_cents * (BASIS_POINTS + shocks_bps.get(asset.symbol, 0))
        // BASIS_POINTS
        for asset in assets
    }
    for obligation in obligations:
        allocation = optimized_by_id[obligation.obligation_id]
        stressed_value = 0
        for line in allocation["allocations"]:
            asset = assets_by_symbol[line["asset"]]
            credited_unit_cents = (
                stressed_prices[asset.symbol] * (BASIS_POINTS - asset.haircut_bps) // BASIS_POINTS
            )
            stressed_value += credited_unit_cents * line["quantity"]
        shortfall_cents = max(0, obligation.requirement_cents - stressed_value)
        if shortfall_cents:
            shortfalls[obligation.obligation_id] = shortfall_cents
        stressed_obligations.append(
            {
                "id": obligation.obligation_id,
                "requirement_cents": obligation.requirement_cents,
                "stressed_collateral_cents": stressed_value,
                "shortfall_cents": shortfall_cents,
            }
        )

    if not shortfalls:
        return {
            "shocks_bps": shocks_bps,
            "obligations": stressed_obligations,
            "total_shortfall_cents": 0,
            "top_up_feasible": True,
            "top_up_cost_cents": 0,
            "top_up_allocations": [],
        }

    shocked_assets = tuple(
        Asset(
            symbol=asset.symbol,
            unit_value_cents=stressed_prices[asset.symbol],
            haircut_bps=asset.haircut_bps,
            unit_cost_cents=asset.unit_cost_cents,
            inventory=max(0, asset.inventory - used.get(asset.symbol, 0)),
            eligible_obligations=asset.eligible_obligations,
        )
        for asset in assets
    )
    top_up_obligations = tuple(
        Obligation(
            obligation_id=obligation.obligation_id,
            name=obligation.name,
            requirement_cents=shortfalls[obligation.obligation_id],
        )
        for obligation in obligations
        if obligation.obligation_id in shortfalls
    )
    try:
        top_up = optimize_allocation(shocked_assets, top_up_obligations)
    except AllocationError:
        top_up = None

    return {
        "shocks_bps": shocks_bps,
        "obligations": stressed_obligations,
        "total_shortfall_cents": sum(shortfalls.values()),
        "top_up_feasible": top_up is not None,
        "top_up_cost_cents": top_up["total_funding_cost_cents"] if top_up else None,
        "top_up_allocations": top_up["obligations"] if top_up else [],
    }

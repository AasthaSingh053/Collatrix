from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator

from collatrix.optimizer import (
    ASSETS,
    OBLIGATIONS,
    AllocationError,
    Asset,
    Obligation,
    compare_allocations,
    false_shortfall_scenario,
)
from collatrix.stress import run_stress_test


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AssetResponse(StrictModel):
    symbol: str
    unit_value_cents: int
    haircut_bps: int
    credited_value_cents: int
    unit_cost_cents: int
    inventory: int
    eligible_obligations: list[str]


class AllocationLine(StrictModel):
    asset: str
    quantity: int
    credited_value_cents: int
    funding_cost_cents: int
    explanation: str


class ObligationAllocation(StrictModel):
    id: str
    name: str
    requirement_cents: int
    credited_collateral_cents: int
    surplus_cents: int
    funding_cost_cents: int
    allocations: list[AllocationLine]


class AllocationPlan(StrictModel):
    obligations: list[ObligationAllocation]
    total_funding_cost_cents: int
    asset_usage: dict[str, int]


class FalseShortfallScenario(StrictModel):
    optimized_feasible: bool
    optimized: AllocationPlan
    greedy_feasible: bool
    greedy: AllocationPlan | None = None
    greedy_shortfall_cents: int
    explanation: str


class OptimizationResponse(StrictModel):
    mode: str
    currency: str
    amount_unit: str
    assets: list[AssetResponse]
    optimized: AllocationPlan
    greedy: AllocationPlan | None = None
    savings_cents: int
    savings_bps: int
    false_shortfall_scenario: FalseShortfallScenario


class AssetInput(StrictModel):
    symbol: str
    unit_value_cents: int = Field(ge=1)
    haircut_bps: int = Field(ge=0, lt=10_000)
    unit_cost_cents: int = Field(ge=0)
    inventory: int = Field(ge=0)
    eligible_obligations: list[str] = Field(default_factory=list)


class ObligationInput(StrictModel):
    id: str
    name: str = ""
    requirement_cents: int = Field(ge=1)


class OptimizeRequest(StrictModel):
    assets: list[AssetInput] | None = None
    obligations: list[ObligationInput] | None = None


class StressRequest(StrictModel):
    shocks_bps: dict[str, StrictInt] = Field(
        default_factory=lambda: {"CASH": 0, "UST": -1_500, "CORP": -2_500}
    )
    assets: list[AssetInput] | None = None
    obligations: list[ObligationInput] | None = None

    @field_validator("shocks_bps")
    @classmethod
    def validate_shocks(cls, shocks: dict[str, int]) -> dict[str, int]:
        known_assets = {asset.symbol for asset in ASSETS}
        unknown_assets = sorted(set(shocks) - known_assets)
        if unknown_assets:
            raise ValueError(f"Unknown assets: {', '.join(unknown_assets)}")
        if any(shock < -10_000 or shock > 50_000 for shock in shocks.values()):
            raise ValueError("Price shocks must be between -10000 and 50000 basis points.")
        return shocks


class StressObligation(StrictModel):
    id: str
    requirement_cents: int
    stressed_collateral_cents: int
    shortfall_cents: int


class StressResponse(StrictModel):
    mode: str
    shocks_bps: dict[str, int]
    obligations: list[StressObligation]
    total_shortfall_cents: int
    top_up_feasible: bool
    top_up_cost_cents: int | None
    top_up_allocations: list[ObligationAllocation]


class DashboardResponse(OptimizationResponse):
    stress: StressResponse


class DeploymentResponse(StrictModel):
    chain_id: int
    network: str
    address: str
    pledgor: str
    counterparty: str
    configuration_version: str
    abi: list[dict[str, Any]]


class ErrorDetail(StrictModel):
    code: str
    message: str
    details: list[dict] | None = None


class ErrorResponse(StrictModel):
    error: ErrorDetail


app = FastAPI(
    title="Collatrix API",
    description="Collateral optimization for a deterministic demonstration portfolio.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DEPLOYMENT_PATH = Path(__file__).resolve().parents[1] / "chain" / "deployments" / "local.json"


@app.exception_handler(AllocationError)
async def allocation_error_handler(_: Request, exc: AllocationError) -> JSONResponse:
    return JSONResponse(
        status_code=409,
        content={"error": {"code": "allocation_infeasible", "message": str(exc)}},
    )


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={
            "error": {
                "code": "invalid_request",
                "message": "Request validation failed.",
                "details": [
                    {
                        "location": list(error["loc"]),
                        "message": error["msg"],
                        "type": error["type"],
                    }
                    for error in exc.errors()
                ],
            }
        },
    )


@app.exception_handler(HTTPException)
async def http_error_handler(_: Request, exc: HTTPException) -> JSONResponse:
    message = str(exc.detail)
    code = "invalid_request" if exc.status_code == 422 else "http_error"
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": code, "message": message}},
    )


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "mode": "simulation"}


def _resolve_portfolio(
    assets_in: list[AssetInput] | None,
    obligations_in: list[ObligationInput] | None,
) -> tuple[tuple[Asset, ...], tuple[Obligation, ...]]:
    assets = (
        tuple(
            Asset(
                symbol=a.symbol,
                unit_value_cents=a.unit_value_cents,
                haircut_bps=a.haircut_bps,
                unit_cost_cents=a.unit_cost_cents,
                inventory=a.inventory,
                eligible_obligations=tuple(a.eligible_obligations),
            )
            for a in assets_in
        )
        if assets_in is not None
        else ASSETS
    )
    obligations = (
        tuple(
            Obligation(
                obligation_id=o.id,
                name=o.name or o.id,
                requirement_cents=o.requirement_cents,
            )
            for o in obligations_in
        )
        if obligations_in is not None
        else OBLIGATIONS
    )
    return assets, obligations


def _optimization_response(
    comparison: dict,
    assets: tuple[Asset, ...] = ASSETS,
) -> OptimizationResponse:
    return OptimizationResponse(
        mode="simulation",
        currency="USD",
        amount_unit="integer cents",
        assets=[
            AssetResponse(
                symbol=asset.symbol,
                unit_value_cents=asset.unit_value_cents,
                haircut_bps=asset.haircut_bps,
                credited_value_cents=asset.credited_value_cents,
                unit_cost_cents=asset.unit_cost_cents,
                inventory=asset.inventory,
                eligible_obligations=list(asset.eligible_obligations),
            )
            for asset in assets
        ],
        false_shortfall_scenario=FalseShortfallScenario(**false_shortfall_scenario()),
        **comparison,
    )


@app.get("/api/v1/optimize", response_model=OptimizationResponse)
def optimize() -> OptimizationResponse:
    return _optimization_response(compare_allocations(ASSETS, OBLIGATIONS), ASSETS)


@app.post("/api/v1/optimize", response_model=OptimizationResponse)
def optimize_custom(request: OptimizeRequest) -> OptimizationResponse:
    assets, obligations = _resolve_portfolio(request.assets, request.obligations)
    return _optimization_response(compare_allocations(assets, obligations), assets)


@app.post("/api/v1/stress", response_model=StressResponse)
def stress(request: StressRequest) -> StressResponse:
    assets, obligations = _resolve_portfolio(request.assets, request.obligations)
    comparison = compare_allocations(assets, obligations)
    return StressResponse(
        mode="simulation",
        **run_stress_test(comparison, request.shocks_bps, assets, obligations),
    )


@app.get("/api/v1/dashboard", response_model=DashboardResponse)
def dashboard() -> DashboardResponse:
    comparison = compare_allocations(ASSETS, OBLIGATIONS)
    return DashboardResponse(
        **_optimization_response(comparison, ASSETS).model_dump(),
        stress=StressResponse(
            mode="simulation",
            **run_stress_test(comparison, {"CASH": 0, "UST": -1_500, "CORP": -2_500}, ASSETS, OBLIGATIONS),
        ),
    )


@app.post("/api/v1/dashboard", response_model=DashboardResponse)
def dashboard_custom(request: OptimizeRequest) -> DashboardResponse:
    assets, obligations = _resolve_portfolio(request.assets, request.obligations)
    comparison = compare_allocations(assets, obligations)
    default_shocks = {a.symbol: 0 for a in assets}
    if "UST" in default_shocks:
        default_shocks["UST"] = -1_500
    if "CORP" in default_shocks:
        default_shocks["CORP"] = -2_500
    return DashboardResponse(
        **_optimization_response(comparison, assets).model_dump(),
        stress=StressResponse(
            mode="simulation",
            **run_stress_test(comparison, default_shocks, assets, obligations),
        ),
    )


@app.get("/api/v1/deployment", response_model=DeploymentResponse)
def deployment() -> DeploymentResponse:
    if not DEPLOYMENT_PATH.is_file():
        raise HTTPException(
            status_code=503,
            detail="Local reservation contract is not deployed. Run the documented local deployment command.",
        )
    try:
        data = json.loads(DEPLOYMENT_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail="Local contract deployment metadata is unreadable.") from exc
    return DeploymentResponse.model_validate(data)

from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator

from collatrix.optimizer import ASSETS, AllocationError, compare_allocations
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


class OptimizationResponse(StrictModel):
    mode: str
    currency: str
    amount_unit: str
    assets: list[AssetResponse]
    optimized: AllocationPlan
    greedy: AllocationPlan
    savings_cents: int
    savings_bps: int


class StressRequest(StrictModel):
    shocks_bps: dict[str, StrictInt] = Field(
        default_factory=lambda: {"CASH": 0, "UST": -1_500, "CORP": -2_500}
    )

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
    allow_origins=["http://localhost:5173"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


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


def _optimization_response(comparison: dict) -> OptimizationResponse:
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
            for asset in ASSETS
        ],
        **comparison,
    )


@app.get("/api/v1/optimize", response_model=OptimizationResponse)
def optimize() -> OptimizationResponse:
    return _optimization_response(compare_allocations())


@app.post("/api/v1/stress", response_model=StressResponse)
def stress(request: StressRequest) -> StressResponse:
    return StressResponse(
        mode="simulation",
        **run_stress_test(compare_allocations(), request.shocks_bps),
    )


@app.get("/api/v1/dashboard", response_model=DashboardResponse)
def dashboard() -> DashboardResponse:
    comparison = compare_allocations()
    return DashboardResponse(
        **_optimization_response(comparison).model_dump(),
        stress=StressResponse(
            mode="simulation",
            **run_stress_test(comparison, {"CASH": 0, "UST": -1_500, "CORP": -2_500}),
        ),
    )

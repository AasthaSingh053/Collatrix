# Collatrix backend

## Financial conventions

- All monetary inputs and outputs are integer USD cents.
- Asset quantities are non-negative integers.
- Haircuts and price shocks are integer basis points; 10,000 bps equals 100%.
- Per-unit credited collateral is floored after the haircut:
  `unit_value_cents * (10_000 - haircut_bps) // 10_000`.
- Stress first floors the shocked unit price to cents, then applies the same
  per-unit haircut rule. The optimizer never rounds collateral upward.
- Savings are calculated from the optimized and greedy costs. The reported
  savings percentage is integer basis points, rounded half up.

## API

- `GET /api/health`: process health and simulation label.
- `GET /api/v1/optimize`: typed optimized and greedy allocations in cents.
- `GET /api/v1/dashboard`: allocation and default deterministic stress results.
- `POST /api/v1/stress`: accepts `{"shocks_bps":{"UST":-1500}}`.
- API validation and infeasibility errors use an `error` object with a stable
  code and message. Infeasible allocation returns HTTP 409.

Run tests from this directory with `python -m unittest discover -s tests -v`.

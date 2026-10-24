# Collatrix

Collatrix is a fintech hackathon prototype with whole-unit collateral
optimization across two obligations, a same-constraint greedy baseline, an
independently verified false-shortfall example, stress top-ups, and local-chain
reservations. The counterparty creates obligations with accepted-asset lists;
the pledgor submits an atomic reservation. All data and chain actions are
demonstrations, not custody, settlement, or real financial transactions.

## Financial convention

Money is represented as integer USD cents. Quantities are integers, and
haircuts and price shocks are basis points (10,000 bps = 100%). For each asset
unit, collateral credit is floored conservatively:

```text
credited_cents = floor(price_cents * (10_000 - haircut_bps) / 10_000)
```

Stress testing first floors the shocked asset price to cents, then applies the
same haircut rule. The dashboard formats API cents as dollars. Savings are
calculated from the optimizer and greedy baseline results.

## Local setup (PowerShell)

Use four terminals. Start the chain first, deploy it in a second terminal, and
then run the API and dashboard:

**Terminal 1 — local Hardhat chain**

```powershell
cd "C:\Users\Aastha Singh\Desktop\Aastha\Collatrix-hackathon\chain"
npm ci
npm run node
```

**Terminal 2 — deploy/configure the demo registry**

```powershell
cd "C:\Users\Aastha Singh\Desktop\Aastha\Collatrix-hackathon\chain"
npm run deploy:local
```

**Terminal 3 — Python API**

```powershell
cd "C:\Users\Aastha Singh\Desktop\Aastha\Collatrix-hackathon\backend"
python -m pip install -r requirements.txt
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

**Terminal 4 — dashboard**

```powershell
cd "C:\Users\Aastha Singh\Desktop\Aastha\Collatrix-hackathon\frontend"
npm ci
npm run dev -- --port 5173
```

Open `http://127.0.0.1:5173`. Use **Use local demo account** for the unlocked
Hardhat pledgor/counterparty accounts (no private key export), or connect a
browser wallet configured for the local chain. Never use a real wallet for this
prototype. Reservation requires the pledgor; release requires the configured
counterparty. Expiry cleanup is permissionless.

The dashboard shows cost and savings, allocation rationale, accepted assets,
stress bars, top-up feasibility, live reservation status, and an activity log.
Three local-chain read-call checks demonstrate rejection of already-reserved
collateral, an ineligible asset, and an expired obligation. The expiry check
temporarily snapshots and restores the local simulation state. These expected
reverts are contract calls, not mined transactions, and have no transaction
hash. Local RPC is `http://127.0.0.1:8545`, chain ID `31337`.

## Verification

```powershell
cd "C:\Users\Aastha Singh\Desktop\Aastha\Collatrix-hackathon\backend"
python -m unittest discover -s tests -v

cd "C:\Users\Aastha Singh\Desktop\Aastha\Collatrix-hackathon\chain"
npm test
npm run test:e2e

cd "C:\Users\Aastha Singh\Desktop\Aastha\Collatrix-hackathon\frontend"
npm run build
```

The end-to-end chain script requires the local chain, deployed registry, and API
to be running. The deployment JSON is generated locally and ignored by Git.

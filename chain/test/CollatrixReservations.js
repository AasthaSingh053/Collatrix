const assert = require("node:assert/strict");
const { ethers, network } = require("hardhat");

describe("CollatrixReservations local simulation", function () {
  async function setup() {
    const [pledgor, counterparty, stranger] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("CollatrixReservations");
    const contract = await factory.deploy(counterparty.address);
    await contract.waitForDeployment();

    const obligationA = ethers.encodeBytes32String("OBL-001");
    const obligationB = ethers.encodeBytes32String("OBL-002");
    const cash = ethers.encodeBytes32String("CASH");
    const ust = ethers.encodeBytes32String("UST");
    const corp = ethers.encodeBytes32String("CORP");
    await contract.configureAsset(cash, 150, 1_000, 0);
    await contract.configureAsset(ust, 80, 1_000, 200);
    await contract.configureAsset(corp, 80, 1_000, 500);
    await createObligation(contract, counterparty, obligationA, 100_000, [cash, ust]);
    await createObligation(contract, counterparty, obligationB, 80_000, [cash, corp]);
    return { contract, pledgor, counterparty, stranger, obligationA, obligationB, cash, ust, corp };
  }

  async function createObligation(contract, counterparty, id, requirementCents, acceptedAssets, ttl = 3_600) {
    const block = await ethers.provider.getBlock("latest");
    return contract.connect(counterparty).createObligation(
      id,
      requirementCents,
      block.timestamp + ttl,
      acceptedAssets,
    );
  }

  async function reserve(contract, pledgor, id, obligationId, allocations, version) {
    return contract.connect(pledgor).reserveBatch(
      id,
      obligationId,
      allocations,
      version ?? await contract.configurationVersion(),
    );
  }

  it("lets the counterparty create an obligation with its accepted-asset list", async function () {
    const { contract, counterparty, stranger, cash, ust } = await setup();
    const id = ethers.encodeBytes32String("OBL-003");
    await assert.rejects(
      createObligation(contract, stranger, id, 10_000, [cash]),
      /only counterparty/,
    );
    await assert.rejects(
      createObligation(contract, counterparty, id, 10_000, [cash, cash]),
      /duplicate accepted asset/,
    );
    await createObligation(contract, counterparty, id, 10_000, [cash, ust]);
    const obligation = await contract.obligations(id);
    assert.equal(obligation.requirementCents, 10_000n);
    assert.equal(await contract.eligible(id, cash), true);
    assert.equal(await contract.eligible(id, ust), true);
    assert.equal(await contract.eligible(id, ethers.encodeBytes32String("CORP")), false);
  });

  it("atomically reserves multiple eligible assets and prevents duplicate reservations", async function () {
    const { contract, pledgor, obligationA, cash, ust } = await setup();
    const id = ethers.id("multi-reservation");
    await reserve(contract, pledgor, id, obligationA, [
      { assetId: cash, quantity: 70 },
      { assetId: ust, quantity: 31 },
    ]);
    assert.equal(await contract.availableUnits(cash), 80n);
    assert.equal(await contract.availableUnits(ust), 49n);
    await assert.rejects(
      reserve(contract, pledgor, id, obligationA, [{ assetId: cash, quantity: 100 }]),
      /duplicate reservation/,
    );
    await assert.rejects(
      reserve(contract, pledgor, ethers.id("duplicate-obligation"), obligationA, [
        { assetId: cash, quantity: 100 },
      ]),
      /obligation already reserved/,
    );
  });

  it("reverts the entire batch when total collateral is insufficient", async function () {
    const { contract, pledgor, obligationA, cash, ust, corp } = await setup();
    await assert.rejects(
      reserve(contract, pledgor, ethers.id("atomic-failure"), obligationA, [
        { assetId: cash, quantity: 98 },
        { assetId: ust, quantity: 1 },
      ]),
      /insufficient collateral value/,
    );
    assert.equal(await contract.availableUnits(cash), 150n);
    assert.equal(await contract.availableUnits(ust), 80n);
    assert.equal(await contract.availableUnits(corp), 80n);
  });

  it("rejects under-collateralized batches, duplicate assets, and ineligible collateral", async function () {
    const { contract, pledgor, obligationA, obligationB, cash, ust, corp } = await setup();
    await assert.rejects(
      reserve(contract, pledgor, ethers.id("too-little-value"), obligationA, [{ assetId: cash, quantity: 99 }]),
      /insufficient collateral value/,
    );
    await assert.rejects(
      reserve(contract, pledgor, ethers.id("duplicate-asset"), obligationA, [
        { assetId: cash, quantity: 50 },
        { assetId: cash, quantity: 50 },
      ]),
      /duplicate asset in batch/,
    );
    await assert.rejects(
      reserve(contract, pledgor, ethers.id("ineligible"), obligationA, [{ assetId: corp, quantity: 1 }]),
      /ineligible collateral/,
    );
    await assert.rejects(
      reserve(contract, pledgor, ethers.id("wrong-eligibility"), obligationB, [{ assetId: ust, quantity: 1 }]),
      /ineligible collateral/,
    );
    assert.equal(await contract.availableUnits(cash), 150n);
  });

  it("checks pledgor-only reservations, available inventory, and configuration version", async function () {
    const { contract, pledgor, counterparty, stranger, obligationA, cash, ust } = await setup();
    const id = ethers.id("not-pledgor");
    await assert.rejects(
      contract.connect(stranger).reserveBatch(
        id,
        obligationA,
        [{ assetId: cash, quantity: 100 }],
        await contract.configurationVersion(),
      ),
      /only pledgor/,
    );
    await assert.rejects(
      contract.connect(counterparty).configureAsset(cash, 150, 1_000, 0),
      /only pledgor/,
    );
    const oldVersion = await contract.configurationVersion();
    await createObligation(contract, counterparty, ethers.encodeBytes32String("OBL-003"), 1_000, [cash]);
    await assert.rejects(
      reserve(contract, pledgor, ethers.id("stale-version"), obligationA, [
        { assetId: cash, quantity: 100 },
      ], oldVersion),
      /stale configuration/,
    );
    await assert.rejects(
      reserve(contract, pledgor, ethers.id("overdraw"), obligationA, [{ assetId: ust, quantity: 81 }]),
      /insufficient inventory/,
    );
  });

  it("rejects expired obligations and stale asset prices", async function () {
    const { contract, pledgor, counterparty, obligationA, cash } = await setup();
    const expiredObligation = ethers.encodeBytes32String("EXPIRED");
    await createObligation(contract, counterparty, expiredObligation, 1, [cash], 10);
    await network.provider.send("evm_increaseTime", [11]);
    await network.provider.send("evm_mine");
    await assert.rejects(
      reserve(contract, pledgor, ethers.id("expired-obligation"), expiredObligation, [{ assetId: cash, quantity: 1 }]),
      /obligation expired/,
    );
    await network.provider.send("evm_increaseTime", [301]);
    await network.provider.send("evm_mine");
    await assert.rejects(
      reserve(contract, pledgor, ethers.id("stale-price"), obligationA, [{ assetId: cash, quantity: 100 }]),
      /stale price/,
    );
  });

  it("allows only the counterparty to release and expires reservations permissionlessly", async function () {
    const { contract, pledgor, counterparty, stranger, obligationA, cash } = await setup();
    const releaseId = ethers.id("release-me");
    await reserve(contract, pledgor, releaseId, obligationA, [{ assetId: cash, quantity: 100 }]);
    await assert.rejects(contract.connect(stranger).release(releaseId), /only counterparty/);
    await assert.rejects(contract.connect(pledgor).release(releaseId), /only counterparty/);
    await contract.connect(counterparty).release(releaseId);
    assert.equal(await contract.availableUnits(cash), 150n);
    await assert.rejects(contract.connect(counterparty).release(releaseId), /reservation not active/);

    const expiringObligation = ethers.encodeBytes32String("EXPIRE-TX");
    await createObligation(contract, counterparty, expiringObligation, 1_000, [cash], 20);
    const expiringId = ethers.id("expire-me");
    await reserve(contract, pledgor, expiringId, expiringObligation, [{ assetId: cash, quantity: 1 }]);
    await network.provider.send("evm_increaseTime", [21]);
    await network.provider.send("evm_mine");
    await contract.connect(stranger).expire(expiringId);
    assert.equal(await contract.availableUnits(cash), 150n);
  });
});

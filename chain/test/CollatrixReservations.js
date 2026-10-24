const assert = require("node:assert/strict");
const { ethers, network } = require("hardhat");

describe("CollatrixReservations local simulation", function () {
  async function setup() {
    const [owner, counterparty, stranger] = await ethers.getSigners();
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
    await contract.configureObligation(obligationA, 100_000, (await ethers.provider.getBlock("latest")).timestamp + 3_600);
    await contract.configureObligation(obligationB, 80_000, (await ethers.provider.getBlock("latest")).timestamp + 3_600);
    await contract.configureEligibility(obligationA, cash, true);
    await contract.configureEligibility(obligationA, ust, true);
    await contract.configureEligibility(obligationB, cash, true);
    await contract.configureEligibility(obligationB, corp, true);
    return { contract, owner, counterparty, stranger, obligationA, obligationB, cash, ust, corp };
  }

  async function reserve(contract, id, obligationId, allocations, version) {
    return contract.reserveBatch(id, obligationId, allocations, version ?? await contract.configurationVersion());
  }

  it("atomically reserves multiple eligible assets and prevents duplicates", async function () {
    const { contract, obligationA, cash, ust } = await setup();
    const id = ethers.id("multi-reservation");
    await reserve(contract, id, obligationA, [
      { assetId: cash, quantity: 70 },
      { assetId: ust, quantity: 31 },
    ]);
    assert.equal(await contract.availableUnits(cash), 80n);
    assert.equal(await contract.availableUnits(ust), 49n);
    await assert.rejects(
      reserve(contract, id, obligationA, [{ assetId: cash, quantity: 100 }]),
      /duplicate reservation/
    );
  });

  it("reverts the entire batch when the final allocation is invalid", async function () {
    const { contract, obligationA, cash, corp } = await setup();
    await assert.rejects(
      reserve(contract, ethers.id("atomic-failure"), obligationA, [
        { assetId: cash, quantity: 98 },
        { assetId: ethers.encodeBytes32String("UST"), quantity: 1 },
      ]),
      /insufficient collateral value/
    );
    assert.equal(await contract.availableUnits(cash), 150n);
    assert.equal(await contract.availableUnits(corp), 80n);
  });

  it("rejects under-collateralized batch totals and duplicate assets", async function () {
    const { contract, obligationA, cash } = await setup();
    await assert.rejects(
      reserve(contract, ethers.id("too-little-value"), obligationA, [{ assetId: cash, quantity: 99 }]),
      /insufficient collateral value/
    );
    await assert.rejects(
      reserve(contract, ethers.id("duplicate-asset"), obligationA, [
        { assetId: cash, quantity: 50 },
        { assetId: cash, quantity: 50 },
      ]),
      /duplicate asset in batch/
    );
    assert.equal(await contract.availableUnits(cash), 150n);
  });

  it("checks eligibility, inventory, owner, and configuration version", async function () {
    const { contract, stranger, obligationA, obligationB, cash, ust } = await setup();
    await assert.rejects(
      reserve(contract, ethers.id("ineligible"), obligationA, [{ assetId: ethers.encodeBytes32String("NOPE"), quantity: 1 }]),
      /asset not configured/
    );
    await assert.rejects(
      reserve(contract, ethers.id("wrong-eligibility"), obligationB, [{ assetId: ust, quantity: 1 }]),
      /ineligible collateral/
    );
    await assert.rejects(
      contract.connect(stranger).reserveBatch(ethers.id("not-owner"), obligationA, [{ assetId: cash, quantity: 100 }], await contract.configurationVersion()),
      /only owner/
    );
    const oldVersion = await contract.configurationVersion();
    await contract.configureEligibility(obligationA, cash, true);
    await assert.rejects(
      reserve(contract, ethers.id("stale-version"), obligationA, [{ assetId: cash, quantity: 100 }], oldVersion),
      /stale configuration/
    );
    await assert.rejects(
      reserve(contract, ethers.id("overdraw"), obligationA, [{ assetId: ust, quantity: 81 }]),
      /insufficient inventory/
    );
  });

  it("rejects expired obligations and stale asset prices", async function () {
    const { contract, obligationA, cash } = await setup();
    const expiredObligation = ethers.encodeBytes32String("EXPIRED");
    const block = await ethers.provider.getBlock("latest");
    await contract.configureObligation(expiredObligation, 1, block.timestamp + 10);
    await contract.configureEligibility(expiredObligation, cash, true);
    await network.provider.send("evm_increaseTime", [11]);
    await network.provider.send("evm_mine");
    await assert.rejects(
      reserve(contract, ethers.id("expired-obligation"), expiredObligation, [{ assetId: cash, quantity: 1 }]),
      /obligation expired/
    );
    await network.provider.send("evm_increaseTime", [301]);
    await network.provider.send("evm_mine");
    await assert.rejects(
      reserve(contract, ethers.id("expired-main-obligation"), obligationA, [{ assetId: cash, quantity: 100 }]),
      /stale price/
    );
  });

  it("permits counterparty-only release and permissionless expiration", async function () {
    const { contract, counterparty, stranger, obligationA, cash } = await setup();
    const releaseId = ethers.id("release-me");
    await reserve(contract, releaseId, obligationA, [{ assetId: cash, quantity: 100 }]);
    await assert.rejects(contract.connect(stranger).release(releaseId), /only counterparty/);
    await contract.connect(counterparty).release(releaseId);
    assert.equal(await contract.availableUnits(cash), 150n);
    await assert.rejects(contract.connect(counterparty).release(releaseId), /reservation not active/);

    const current = await ethers.provider.getBlock("latest");
    await contract.configureObligation(obligationA, 100_000, current.timestamp + 20);
    const expiringId = ethers.id("expire-me");
    await reserve(contract, expiringId, obligationA, [{ assetId: cash, quantity: 100 }]);
    await network.provider.send("evm_increaseTime", [21]);
    await network.provider.send("evm_mine");
    await contract.expire(expiringId);
    assert.equal(await contract.availableUnits(cash), 150n);
  });
});

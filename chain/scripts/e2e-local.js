const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("hardhat");

async function main() {
  const [pledgor, counterparty] = await ethers.getSigners();
  const deploymentPath = path.join(__dirname, "..", "deployments", "local.json");
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  assert.equal(await pledgor.getAddress(), deployment.pledgor, "Hardhat pledgor does not match deployment");
  assert.equal(await counterparty.getAddress(), deployment.counterparty, "Counterparty does not match deployment");

  const response = await fetch("http://127.0.0.1:8000/api/v1/dashboard");
  assert.equal(response.status, 200, "Collatrix dashboard API is unavailable");
  const dashboard = await response.json();
  assert.equal(dashboard.mode, "simulation");
  assert.equal(dashboard.amount_unit, "integer cents");
  assert.equal(dashboard.optimized.obligations.length, 2);

  const contract = new ethers.Contract(deployment.address, deployment.abi, pledgor);
  const proposal = dashboard.optimized.obligations[0];
  const reservationId = ethers.id(`collatrix-e2e:${Date.now()}`);
  const allocations = proposal.allocations.map((line) => ({
    assetId: ethers.encodeBytes32String(line.asset),
    quantity: BigInt(line.quantity),
  }));

  const reserveTx = await contract.reserveBatch(
    reservationId,
    ethers.encodeBytes32String(proposal.id),
    allocations,
    BigInt(deployment.configuration_version)
  );
  const reserveReceipt = await reserveTx.wait();
  assert.equal(reserveReceipt.status, 1, "Reservation transaction did not succeed");
  const record = await contract.reservation(reservationId);
  assert.equal(Number(record.status), 1, "On-chain reservation is not active");
  console.log(`Reservation confirmed in local block ${reserveReceipt.blockNumber}: ${reserveReceipt.hash}`);

  const releaseTx = await contract.connect(counterparty).release(reservationId);
  const releaseReceipt = await releaseTx.wait();
  assert.equal(releaseReceipt.status, 1, "Counterparty release transaction did not succeed");
  assert.equal(await contract.activeReservationForObligation(ethers.encodeBytes32String(proposal.id)), ethers.ZeroHash);
  console.log(`Counterparty release confirmed in local block ${releaseReceipt.blockNumber}: ${releaseReceipt.hash}`);
  console.log("End-to-end API proposal → local reservation → counterparty release passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

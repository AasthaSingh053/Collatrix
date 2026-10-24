const fs = require("node:fs");
const path = require("node:path");
const { ethers, artifacts } = require("hardhat");

async function main() {
  const [owner, counterparty] = await ethers.getSigners();
  const factory = await ethers.getContractFactory("CollatrixReservations");
  const contract = await factory.deploy(counterparty.address);
  await contract.waitForDeployment();

  const assets = [
    { symbol: "CASH", inventory: 150, priceCents: 1_000, haircutBps: 0 },
    { symbol: "UST", inventory: 80, priceCents: 1_000, haircutBps: 200 },
    { symbol: "CORP", inventory: 80, priceCents: 1_000, haircutBps: 500 },
  ];
  const obligations = [
    {
      id: "OBL-001",
      requirementCents: 100_000,
      expirySeconds: 86_400,
      eligible: ["CASH", "UST"],
    },
    {
      id: "OBL-002",
      requirementCents: 80_000,
      expirySeconds: 86_400,
      eligible: ["CASH", "CORP"],
    },
  ];

  for (const asset of assets) {
    await (
      await contract.configureAsset(
        ethers.encodeBytes32String(asset.symbol),
        asset.inventory,
        asset.priceCents,
        asset.haircutBps
      )
    ).wait();
  }
  const block = await ethers.provider.getBlock("latest");
  for (const obligation of obligations) {
    await (
      await contract.configureObligation(
        ethers.encodeBytes32String(obligation.id),
        obligation.requirementCents,
        block.timestamp + obligation.expirySeconds
      )
    ).wait();
    for (const asset of assets) {
      await (
        await contract.configureEligibility(
          ethers.encodeBytes32String(obligation.id),
          ethers.encodeBytes32String(asset.symbol),
          obligation.eligible.includes(asset.symbol)
        )
      ).wait();
    }
  }

  const artifact = await artifacts.readArtifact("CollatrixReservations");
  const deployment = {
    chain_id: 31337,
    network: "local Hardhat simulation",
    address: await contract.getAddress(),
    owner: owner.address,
    counterparty: counterparty.address,
    configuration_version: String(await contract.configurationVersion()),
    abi: artifact.abi,
  };
  const outputPath = path.join(__dirname, "..", "deployments", "local.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(deployment, null, 2));
  console.log(`Simulation contract deployed at ${deployment.address}`);
  console.log(`Configuration version ${deployment.configuration_version}`);
  console.log(`Deployment metadata written to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

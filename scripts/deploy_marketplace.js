require("dotenv").config();

const { ethers } = require("hardhat");

async function main() {
  const signers = await ethers.getSigners();
  deployer = signers[0];
  creator = deployer; // owner passed to wrapper constructor
  const PLATFORM_FEE_BPS = 250n; // 2.5% as BigInt
  const UsikoMarketplace = await ethers.getContractFactory("UsikoMarketplace");

  const usikoMarketplace = await UsikoMarketplace.deploy(
    Number(PLATFORM_FEE_BPS),
    await deployer.getAddress(),
    await deployer.getAddress()
  );
  

  console.log(await usikoMarketplace.getAddress());
}

main();

require("dotenv").config();

const { ethers } = require("hardhat");

async function main() {
  const signers = await ethers.getSigners();
  deployer = signers[0];
  const ROYALTY_BPS = 1000n; // 10% as BigInt

  // Load the wrapper artifact (ABI + bytecode)
  const UsikoERC721HTSToken = require("../artifacts/contracts/UsikoERC721HTSToken.sol/UsikoERC721HTSToken.json");

  const Factory = new ethers.ContractFactory(
    UsikoERC721HTSToken.abi,
    UsikoERC721HTSToken.bytecode,
    deployer
  );
  const parseHBAR = (x) => ethers.parseUnits(x, 18);

  const wrapper = await Factory.deploy(await deployer.getAddress()); // constructor(_owner)
  await wrapper.waitForDeployment();

  console.log("Wrapper deployed:", await wrapper.getAddress());

  const tx = await wrapper.createNFTCollection(
    "IGUN Codex: Court of Benin",
    "IGUN",
    {
      value: parseHBAR("5"), // if your createNFTCollection is payable
      gasLimit: 300_000,
    }
  );
  await tx.wait();

  htsToken = await wrapper.tokenAddress();
  console.log("HTS ERC721 facade:", htsToken);

  const usikoMarketplace = await ethers.getContractAt(
    "UsikoMarketplace",
    "0xDc79700eb2563c9C67802a327456722166CCDa60"
  );

  const ROYALTY_WALLET = ethers.getAddress(
    "0x798159703a50b049E2e4D93AA727bc727A33291a"
  );

  const resp = await usikoMarketplace.setCollectionRoyaltyByOwner(
    await wrapper.getAddress(),
    ROYALTY_WALLET,
    ROYALTY_BPS
  );

  console.log("resp: ", resp);
}

main();

/**
 * Danxomɛ Codex - Danxomɛ
 * Wrapper deployed: 0x0587b0e618060f1C797b90f968f344A1735F8c76
 * HTS ERC721 facade: 0x0000000000000000000000000000000000694228
 *
 * The Horns Codex: Shaka’s Age - Horns
 * Wrapper deployed: 0x9000A81892477b23c519CFCD5b974c74Da0149A2
 * HTS ERC721 facade: 0x0000000000000000000000000000000000694243
 *
 * IGUN Codex: Court of Benin - IGUN
 * Wrapper deployed: 0x0b15e17083dBEc853e6744E5D29Ae70a686e17F4
 * HTS ERC721 facade: 0x00000000000000000000000000000000006945b7
 */

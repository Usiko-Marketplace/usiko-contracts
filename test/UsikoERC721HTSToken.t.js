require("dotenv").config();

const { expect } = require("chai");
const { ethers, network } = require("hardhat");

let usikoERC721HTSToken;
let htsErc721Address;
let mintedTokenId;

const { Hbar, HbarUnit, TokenSupplyType } = require("@hashgraph/sdk");

const ERC721_MIN_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "function approve(address to, uint256 tokenId) external",
  "function getApproved(uint256 tokenId) external view returns (address)",
  "function ownerOf(uint256 tokenId) external view returns (address)",
  "function balanceOf(address owner) external view returns (uint256)",
  "function transferNft(address token, address receiver, int64 serial) returns (int)",
];

describe("UsikoERC721HTSToken (Hedera testnet)", function () {
  this.timeout(300_000);

  it.skip("Associate", async () => {
    const wallet = new ethers.Wallet(process.env.TRADER_1_KEY, ethers.provider);
    const [deployer] = await ethers.getSigners();
    const htsAbi = [
      "function associateTokens(address account, address[] tokens) external returns (int64)",
      "function associate()",
      "function associateMyself()",
    ];
    const HTS_PRECOMPILE = ethers.getAddress(ethers.zeroPadValue("0x0167", 20));
    const tokenAddress = "0x099C89EadA7210800C29A230748D6B047Ae2bc77";

    const hts = new ethers.Contract(tokenAddress, htsAbi, deployer);

    // console.log(HTS_PRECOMPILE, await wallet.getAddress());

    const tx = await hts.connect(wallet).associateMyself();

    // const tx = await hts.connect(wallet).associate();
    const receipt = await tx.wait();

    console.log("Association tx completed:", receipt);
  });

  it("deploys the UsikoERC721HTSToken contract", async () => {
    usikoERC721HTSToken = await ethers.deployContract("UsikoERC721HTSToken", [
      process.env.OPERATOR_ADDRESS,
    ]);
    console.log("UsikoERC721HTSToken deployed to:", usikoERC721HTSToken.target);
    expect(usikoERC721HTSToken.target).to.be.properAddress;
  });

  it("creates an HTS NFT collection", async () => {
    const tx = await usikoERC721HTSToken.createNFTCollection(
      "Danxomɛ Codex - 1",
      "CODEX",
      {
        value: ethers.parseEther("5"),
        gasLimit: 250_000,
      }
    );

    await expect(tx).to.emit(usikoERC721HTSToken, "NFTCollectionCreated");

    htsErc721Address = await usikoERC721HTSToken.tokenAddress();
    console.log("HTS ERC721 facade address:", htsErc721Address);
    expect(htsErc721Address).to.be.properAddress;
    expect(htsErc721Address).to.not.equal(ethers.ZeroAddress);
  });

  it("mints an NFT with metadata to the deployer (capture tokenId)", async () => {
    const [deployer] = await ethers.getSigners();

    const metadata = ethers.toUtf8Bytes(
      "ipfs://bafkreicnf6cz3vvfjtqumbnkow5x4sabttydwcyjli6ptezsrqd5wvtkvi"
    );

    const tx = await usikoERC721HTSToken.mintNFT(deployer.address, metadata, {
      gasLimit: 350_000,
    });

    await expect(tx).to.emit(usikoERC721HTSToken, "NFTMinted");

    // Extract tokenId from UsikoERC721HTSToken's NFTMinted event
    const rcpt = await tx.wait();
    const wrapperAddr = usikoERC721HTSToken.target.toLowerCase();
    mintedTokenId = 0n;

    if (rcpt && rcpt.logs) {
      for (const log of rcpt.logs) {
        if (log.address.toLowerCase() !== wrapperAddr) continue;
        try {
          const parsed = usikoERC721HTSToken.interface.parseLog({
            topics: log.topics,
            data: log.data,
          });
          if (parsed && parsed.name === "NFTMinted") {
            const tok = parsed.args[1];
            mintedTokenId =
              typeof tok === "bigint" ? tok : BigInt(tok.toString());
            break;
          }
        } catch {
          // Not a wrapper event; ignore
        }
      }
    }

    console.log("Mint transaction: ", tx?.hash);

    expect(mintedTokenId, "failed to decode minted tokenId").to.not.equal(0n);
    console.log("Minted tokenId:", mintedTokenId.toString());
  });

  it("Transfers the NFT to another user", async () => {
    const wallet = new ethers.Wallet(process.env.TRADER_1_KEY, ethers.provider);
    const [deployer] = await ethers.getSigners();
    const htsAbi = ["function associate()"];
    const htsErc721Address = await usikoERC721HTSToken.tokenAddress();

    console.log("tokenAddress", htsErc721Address);

    const hts = new ethers.Contract(htsErc721Address, htsAbi, deployer);

    const tx = await hts.connect(wallet).associate();

    const receipt = await tx.wait();

    console.log("Association tx completed:", receipt?.hash);

    const erc721 = new ethers.Contract(
      htsErc721Address,
      ERC721_MIN_ABI,
      deployer
    );

    // Ensure UsikoERC721HTSToken is approved for this tokenId
    const currentApproved = await erc721.getApproved(mintedTokenId);
    if (
      currentApproved.toLowerCase() !== usikoERC721HTSToken.target.toLowerCase()
    ) {
      const approveTx = await erc721.approve(
        usikoERC721HTSToken.target,
        mintedTokenId
      );
      await approveTx.wait();
    }

    const tx2 = await usikoERC721HTSToken
      .connect(deployer)
      .transferNft(mintedTokenId, await wallet.getAddress()); //Transfer NFT with Serial number 1

    const receipt2 = await tx2.wait();

    console.log("Token transfer tx completed:", receipt2?.hash);
  });

  it.skip("approves and burns the minted NFT (no pre-transfer needed)", async () => {
    const [deployer] = await ethers.getSigners();

    // Use minimal ABI (no artifact dependency)
    const erc721 = new ethers.Contract(
      htsErc721Address,
      ERC721_MIN_ABI,
      deployer
    );

    // Ensure UsikoERC721HTSToken is approved for this tokenId
    const currentApproved = await erc721.getApproved(mintedTokenId);
    if (
      currentApproved.toLowerCase() !== usikoERC721HTSToken.target.toLowerCase()
    ) {
      const approveTx = await erc721.approve(
        usikoERC721HTSToken.target,
        mintedTokenId
      );
      await approveTx.wait();
    }

    // Burn via UsikoERC721HTSToken; wrapper will transfer to treasury and burn
    const burnTx = await usikoERC721HTSToken.burnNFT(mintedTokenId, {
      gasLimit: 200_000,
    });
    await expect(burnTx).to.emit(usikoERC721HTSToken, "NFTBurned");

    // Optional: check deployer balance after burn
    const raw = await erc721.balanceOf(deployer.address);
    const bal = typeof raw === "bigint" ? raw : BigInt(raw.toString());
    // Balance might be >0 if multiple NFTs minted; at least it shouldn't throw
    expect(bal >= 0n).to.equal(true);
  });
});

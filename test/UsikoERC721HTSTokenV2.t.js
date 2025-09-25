require("dotenv").config();

const { expect } = require("chai");
const { ethers } = require("hardhat");

// ---------- HBAR helpers (Hedera JSON-RPC commonly exposes 18 decimals in EVM) ----------
const parseHBAR = (x) => ethers.parseUnits(x, 18);
const fmtHBAR = (bn) => ethers.formatUnits(bn, 18);

// Minimal ERC721 ABI used via HTS ERC721 facade address
const ERC721_MIN_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "function approve(address to, uint256 tokenId) external",
  "function getApproved(uint256 tokenId) external view returns (address)",
  "function ownerOf(uint256 tokenId) external view returns (address)",
  "function balanceOf(address owner) external view returns (uint256)",
];

// HTS associate() exposed by the token facade (Hedera)
const HTS_ASSOC_ABI = ["function associate()"];

// Associate a wallet to an HTS NFT so it can receive tokens
async function ensureAssociated(signer, tokenAddress) {
  const tok = new ethers.Contract(tokenAddress, HTS_ASSOC_ABI, signer);
  try {
    const tx = await tok.associate();
    await tx.wait();
    console.log(`Associated: ${await signer.getAddress()} -> ${tokenAddress}`);
  } catch (e) {
    console.log(
      `associate() skipped for ${await signer.getAddress()}: ${
        e?.shortMessage || e?.message
      }`
    );
  }
}

describe("Usiko (bytecode deploy) → Royalty → List → Buy (Hedera)", function () {
  this.timeout(600_000);

  let deployer, creator;
  let buyer;
  let marketplace;
  let wrapper; // UsikoERC721HTSToken instance
  let htsToken; // HTS ERC721 facade address
  let tokenId; // serial

  // Config
  const ROYALTY_WALLET = ethers.getAddress(
    "0x798159703a50b049E2e4D93AA727bc727A33291a"
  );
  const ROYALTY_BPS = 1000n; // 10% as BigInt
  const PLATFORM_FEE_BPS = 250n; // 2.5% as BigInt
  const PRICE_WEI_DESIRED = parseHBAR("5"); // 5 HBAR (may not be used if marketplace uses different unit)

  // Load the wrapper artifact (ABI + bytecode)
  const ART = require("../artifacts/contracts/UsikoERC721HTSToken.sol/UsikoERC721HTSToken.json");

  before(async () => {
    const signers = await ethers.getSigners();
    deployer = signers[0];
    creator = deployer; // owner passed to wrapper constructor

    // External buyer (Hedera testnet)
    const { TRADER_1_KEY } = process.env;
    if (!TRADER_1_KEY) {
      throw new Error("TRADER_1_KEY must be set in .env to run this test.");
    }
    buyer = new ethers.Wallet(TRADER_1_KEY, ethers.provider);

    // 1) Deploy the marketplace: (platformFeeBps, feeReceiver, initialOwner)
    const UsikoMarketplace = await ethers.getContractFactory(
      "UsikoMarketplace",
      deployer
    );
    marketplace = await UsikoMarketplace.deploy(
      Number(PLATFORM_FEE_BPS), // if constructor expects uint16, passing number is fine
      await deployer.getAddress(),
      await deployer.getAddress()
    );
    await marketplace.waitForDeployment();

    console.log("Marketplace:", await marketplace.getAddress());
    console.log("Deployer   :", await deployer.getAddress());
    console.log("Buyer      :", await buyer.getAddress());
  });

  it("Deploys the HTS wrapper directly from bytecode and creates the collection", async () => {
    // 2) Deploy wrapper directly from bytecode (no on-chain factory)
    const Factory = new ethers.ContractFactory(ART.abi, ART.bytecode, deployer);
    wrapper = await Factory.deploy(await deployer.getAddress()); // constructor(_owner)
    await wrapper.waitForDeployment();
    console.log("Wrapper deployed:", await wrapper.getAddress());

    // 3) Create the HTS NFT collection (no HTS on-chain royalties)
    const tx = await wrapper.createNFTCollection("Usiko Codex", "USKO", {
      value: parseHBAR("5"), // if your createNFTCollection is payable
      gasLimit: 300_000,
    });
    await tx.wait();

    htsToken = await wrapper.tokenAddress();
    console.log("HTS ERC721 facade:", htsToken);
    expect(htsToken).to.be.properAddress;
    expect(htsToken).to.not.equal(ethers.ZeroAddress);

    // Safer to associate the creator before minting (receiver must be associated)
    await ensureAssociated(deployer, htsToken);
  });

  it("Mints 1 NFT to creator", async () => {
    const metadata = ethers.toUtf8Bytes(
      "ipfs://bafkreicnf6cz3vvfjtqumbnkow5x4sabttydwcyjli6ptezsrqd5wvtkvi"
    );

    const tx = await wrapper
      .connect(creator)
      .mintNFT(await creator.getAddress(), metadata);
    const rc = await tx.wait();

    // Parse wrapper's NFTMinted(to, tokenId, newTotalSupply)
    const ev = rc.logs.find((l) => {
      try {
        const parsed = wrapper.interface.parseLog({
          topics: l.topics,
          data: l.data,
        });
        return parsed?.name === "NFTMinted";
      } catch {
        return false;
      }
    });
    expect(ev, "NFTMinted not emitted").to.not.eq(undefined);

    const parsed = wrapper.interface.parseLog({
      topics: ev.topics,
      data: ev.data,
    });
    tokenId = BigInt(parsed.args.tokenId.toString());
    console.log("Minted tokenId:", tokenId.toString());

    const erc721 = new ethers.Contract(htsToken, ERC721_MIN_ABI, creator);
    expect(await erc721.ownerOf(tokenId)).to.eq(await creator.getAddress());
  });

  it("Collection owner sets default royalty in marketplace (10% to specified wallet)", async () => {
    // If your marketplace verifies wrapper ownership, pass wrapper address;
    // it maps internally to the HTS token when charging royalties.
    const setTx = await marketplace
      .connect(creator)
      .setCollectionRoyaltyByOwner(
        await wrapper.getAddress(),
        ROYALTY_WALLET,
        Number(ROYALTY_BPS) // if setter expects uint16/uint32, pass number
      );
    await setTx.wait();

    // Read back royalty by HTS token address (per your API)
    const d = await marketplace.collectionRoyalty(htsToken);
    // d.receiver is string; d.bps is likely BigInt/uint
    expect(d.receiver).to.eq(ROYALTY_WALLET);
    expect(BigInt(d.bps)).to.eq(ROYALTY_BPS); // <-- compare BigInt to BigInt
    console.log("Default royalty set:", d.receiver, `${Number(d.bps) / 100}%`);
  });

  it("Seller lists for 5 HBAR; buyer associates then buys; payouts are split", async () => {
    const erc721 = new ethers.Contract(htsToken, ERC721_MIN_ABI, creator);

    // Approve marketplace to move tokenId
    const approved = await erc721.getApproved(tokenId);
    if (
      approved.toLowerCase() !== (await marketplace.getAddress()).toLowerCase()
    ) {
      const txA = await erc721.approve(await marketplace.getAddress(), tokenId);
      await txA.wait();
    }

    // List with no per-list override → uses collection default royalty
    const listTx = await marketplace
      .connect(creator)
      .list(htsToken, tokenId, PRICE_WEI_DESIRED, ethers.ZeroAddress, 0);
    const listRc = await listTx.wait();

    // Grab listing id
    const listedEv = listRc.logs.find((l) => {
      try {
        const parsed = marketplace.interface.parseLog({
          topics: l.topics,
          data: l.data,
        });
        return parsed?.name === "Listed";
      } catch {
        return false;
      }
    });
    expect(listedEv, "Listed not emitted").to.not.eq(undefined);

    const parsedListed = marketplace.interface.parseLog({
      topics: listedEv.topics,
      data: listedEv.data,
    });
    const listingId = BigInt(parsedListed.args.id.toString());

    // IMPORTANT: read on-chain listing and use EXACT stored price
    const [, , , price, , ,] = await marketplace.listings(listingId);

    const onChainPrice = BigInt(price.toString());
    console.log("fmtHBAR: ", fmtHBAR(onChainPrice));

    // console.log(
    //   "Listed id:",
    //   listingId.toString(),
    //   "price:",
    //   fmtHBAR(onChainPrice),
    //   "HBAR"
    // );

    // Buyer must associate to receive the NFT
    await ensureAssociated(buyer, htsToken);

    // Track balances
    const beforeBuyer = await ethers.provider.getBalance(
      await buyer.getAddress()
    );
    const beforeSeller = await ethers.provider.getBalance(
      await creator.getAddress()
    );
    const beforeFee = await ethers.provider.getBalance(
      await marketplace.feeReceiver()
    );
    const beforeRoyal = await ethers.provider.getBalance(ROYALTY_WALLET);

    // Buy — send EXACT on-chain price (prevents msg.value != price)
    const buyTx = await marketplace
      .connect(buyer)
      .buy(listingId, { value: onChainPrice });
    await buyTx.wait();

    // Ownership moved
    expect(await erc721.ownerOf(tokenId)).to.eq(await buyer.getAddress());

    // Expected splits (computed from on-chain price to match units)
    const platformFee = (onChainPrice * PLATFORM_FEE_BPS) / 10_000n;
    const royaltyPaid = (onChainPrice * ROYALTY_BPS) / 10_000n;
    const sellerProceeds = onChainPrice - platformFee - royaltyPaid;

    const afterBuyer = await ethers.provider.getBalance(
      await buyer.getAddress()
    );
    const afterSeller = await ethers.provider.getBalance(
      await creator.getAddress()
    );
    const afterFee = await ethers.provider.getBalance(
      await marketplace.feeReceiver()
    );
    const afterRoyal = await ethers.provider.getBalance(ROYALTY_WALLET);

    console.log("== Split (expected) ==");
    console.log("Price          :", fmtHBAR(onChainPrice), "HBAR");
    console.log("Platform fee   :", fmtHBAR(platformFee), "HBAR");
    console.log("Royalty paid   :", fmtHBAR(royaltyPaid), "HBAR");
    console.log("Seller proceeds:", fmtHBAR(sellerProceeds), "HBAR");

    console.log("== Deltas (observed) ==");
    console.log("Buyer Δ   ~", fmtHBAR(beforeBuyer - afterBuyer), "(+ gas)");
    console.log("Seller Δ  ~", fmtHBAR(afterSeller - beforeSeller));
    console.log("Fee Δ     ~", fmtHBAR(afterFee - beforeFee));
    console.log("Royalty Δ ~", fmtHBAR(afterRoyal - beforeRoyal));

    // Assertions (buyer delta varies due to gas)
    expect(afterFee - beforeFee).to.eq(platformFee);
    expect(afterRoyal - beforeRoyal).to.eq(royaltyPaid);
    expect(afterSeller - beforeSeller >= sellerProceeds).to.eq(true);
  });
});

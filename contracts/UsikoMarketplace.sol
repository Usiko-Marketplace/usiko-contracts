// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Ownable}  from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Minimal interface of your collection wrapper (UsikoERC721HTSToken).
interface IUsikoCollectionWrapper {
    function owner() external view returns (address);
    function tokenAddress() external view returns (address); // HTS ERC721 facade
}

/**
 * HTS NFT marketplace (no HTS custom fees on token):
 * - Price is in HBAR wei (18-dec).
 * - Platform fee + royalty (bps) paid in HBAR.
 * - NFT moved via ERC721 facade at HTS token address.
 *
 * Royalty precedence:
 *   per-listing (if provided) > per-collection default (if set) > 0
 *
 * Only the **collection owner** (as defined by the wrapper's Ownable)
 * can set/update the per-collection default royalty.
 */
contract UsikoMarketplace is Ownable {
    struct Listing {
        address seller;
        address token;      // HTS ERC721 facade (EVM address)
        uint256 tokenId;    // serial
        uint256 priceWei;   // HBAR wei (18-dec)
        address royaltyReceiver; // per-listing (optional)
        uint96  royaltyBps;      // per-listing (0..10000)
        bool    active;
    }

    struct RoyaltyDefault {
        address receiver;   // 0 => none
        uint96  bps;        // 0..10000
    }

    // platform fee
    uint96  public platformFeeBps; // e.g., 250 = 2.5%
    address public feeReceiver;

    // per-collection defaults keyed by HTS token (facade) address
    mapping(address => RoyaltyDefault) public collectionRoyalty;

    // listings
    uint256 public nextListingId;
    mapping(uint256 => Listing) public listings;

    event Listed(
        uint256 indexed id,
        address indexed token,
        uint256 indexed tokenId,
        uint256 priceWei,
        address seller,
        address royaltyReceiver,
        uint96  royaltyBps
    );
    event Cancelled(uint256 indexed id);
    event Purchased(
        uint256 indexed id,
        address indexed buyer,
        uint256 priceWei,
        uint256 platformFee,
        uint256 royaltyPaid,
        uint256 sellerProceeds
    );
    event CollectionRoyaltyUpdated(
        address indexed wrapper,
        address indexed token,
        address indexed receiver,
        uint96  bps
    );

    constructor(
        uint96 _platformFeeBps,
        address _feeReceiver,
        address initialOwner
    ) Ownable(initialOwner) {
        require(_feeReceiver != address(0), "feeReceiver=0");
        require(_platformFeeBps <= 10_000, "fee bps > 100%");
        platformFeeBps = _platformFeeBps;
        feeReceiver    = _feeReceiver;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Collection owner–controlled default royalty
    // The caller provides the WRAPPER (UsikoERC721HTSToken). We read:
    //  - wrapper.owner()         to verify caller is the collection owner
    //  - wrapper.tokenAddress()  to map default royalty under the HTS facade
    // ─────────────────────────────────────────────────────────────────────
    function setCollectionRoyaltyByOwner(
        address wrapper,
        address receiver,
        uint96  bps
    ) external {
        require(wrapper != address(0), "wrapper=0");
        require(bps <= 10_000, "bps > 100%");

        // Verify caller is the wrapper's owner
        address wrapperOwner = IUsikoCollectionWrapper(wrapper).owner();
        require(wrapperOwner == msg.sender, "not collection owner");

        // Resolve the HTS ERC721 facade
        address htsToken = IUsikoCollectionWrapper(wrapper).tokenAddress();
        require(htsToken != address(0), "hts token=0");

        collectionRoyalty[htsToken] = RoyaltyDefault({receiver: receiver, bps: bps});
        emit CollectionRoyaltyUpdated(wrapper, htsToken, receiver, bps);
    }

    // Optional admin knobs for the marketplace owner
    function setPlatformFee(uint96 bps) external onlyOwner {
        require(bps <= 10_000, "bps > 100%");
        platformFeeBps = bps;
    }

    function setFeeReceiver(address receiver) external onlyOwner {
        require(receiver != address(0), "receiver=0");
        feeReceiver = receiver;
    }

    // ─────────────────────────────────────────────────────────────────────
    // List
    // token: HTS ERC721 address; tokenId: serial; priceWei: HBAR wei (18-dec)
    // royalty{Receiver,Bps}: per-listing override (0 = use collection default)
    // ─────────────────────────────────────────────────────────────────────
    function list(
        address token,
        uint256 tokenId,
        uint256 priceWei,
        address royaltyReceiver,
        uint96  royaltyBps
    ) external returns (uint256 id) {
        require(priceWei > 0, "price=0");
        require(royaltyBps <= 10_000, "royalty > 100%");

        // must own the token
        address owner = IERC721(token).ownerOf(tokenId);
        require(owner == msg.sender, "not owner");

        // must approve marketplace to move it
        bool ok =
            IERC721(token).getApproved(tokenId) == address(this) ||
            IERC721(token).isApprovedForAll(msg.sender, address(this));
        require(ok, "marketplace not approved");

        // pick effective royalty (listing override or collection default)
        address effRoyaltyReceiver = royaltyReceiver;
        uint96  effRoyaltyBps      = royaltyBps;
        if (effRoyaltyReceiver == address(0) && effRoyaltyBps == 0) {
            RoyaltyDefault memory d = collectionRoyalty[token];
            effRoyaltyReceiver = d.receiver;
            effRoyaltyBps      = d.bps;
        }
        require(effRoyaltyBps <= 10_000, "bad royalty bps");

        id = ++nextListingId;
        listings[id] = Listing({
            seller: msg.sender,
            token:  token,
            tokenId: tokenId,
            priceWei: priceWei,
            royaltyReceiver: effRoyaltyReceiver,
            royaltyBps: effRoyaltyBps,
            active: true
        });

        emit Listed(id, token, tokenId, priceWei, msg.sender, effRoyaltyReceiver, effRoyaltyBps);
    }

    // Cancel by seller
    function cancel(uint256 id) external {
        Listing storage l = listings[id];
        require(l.active, "inactive");
        require(l.seller == msg.sender, "not seller");
        l.active = false;
        emit Cancelled(id);
    }

    // Buy (buyer must be associated to HTS token beforehand)
    function buy(uint256 id) external payable {
        Listing storage l = listings[id];
        require(l.active, "inactive");
        require(msg.sender != l.seller, "buyer=seller");
        require(msg.value == l.priceWei, "msg.value != price");

        // fees
        uint256 platformFee = (l.priceWei * platformFeeBps) / 10_000;
        uint256 royaltyPaid = (l.royaltyReceiver != address(0) && l.royaltyBps > 0)
            ? (l.priceWei * l.royaltyBps) / 10_000
            : 0;

        require(platformFee + royaltyPaid <= l.priceWei, "fees > price");
        uint256 sellerProceeds = l.priceWei - platformFee - royaltyPaid;

        // effects
        l.active = false;

        // payouts
        if (platformFee > 0) {
            (bool okFee, ) = payable(feeReceiver).call{value: platformFee}("");
            require(okFee, "fee xfer");
        }
        if (royaltyPaid > 0) {
            (bool okRoy, ) = payable(l.royaltyReceiver).call{value: royaltyPaid}("");
            require(okRoy, "royalty xfer");
        }
        (bool okSeller, ) = payable(l.seller).call{value: sellerProceeds}("");
        require(okSeller, "seller xfer");

        // transfer NFT (reverts if buyer not associated → whole tx reverts atomically)
        IERC721(l.token).transferFrom(l.seller, msg.sender, l.tokenId);

        emit Purchased(id, msg.sender, l.priceWei, platformFee, royaltyPaid, sellerProceeds);
    }

    // accept HBAR
    receive() external payable {}
}

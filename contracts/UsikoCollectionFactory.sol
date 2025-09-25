// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {UsikoERC721HTSToken} from "./UsikoERC721HTSToken.sol";

contract UsikoCollectionFactory {
    event CollectionDeployed(address indexed collection, address indexed owner);

    function createCollection721(
        string calldata name_,
        string calldata symbol_
    ) external returns (address collection) {
        UsikoERC721HTSToken c = new UsikoERC721HTSToken(msg.sender);
        collection = address(c);

        c.createNFTCollection(name_, symbol_);

        emit CollectionDeployed(collection, msg.sender);
    }
}

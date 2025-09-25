require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    "hedera-testnet": {
      url: `https://testnet.hashio.io/api`,
      accounts: [process.env.PRIVATE_KEY, process.env.PRIVATE_KEY], //Deployer & NFT creator same wallet
    },
  },
  mocha: {
    timeout: 120000, // 120s
  },
};

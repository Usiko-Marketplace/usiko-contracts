require("dotenv").config();
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const FormData = require("form-data");

const PINATA_JWT = process.env.PINATA_JWT; // Pinata → Auth → API Keys → JWT
const PINATA_BASE = "https://api.pinata.cloud";

async function uploadFile(filePath) {
  const data = new FormData();
  data.append("file", fs.createReadStream(filePath));
  const res = await axios.post(`${PINATA_BASE}/pinning/pinFileToIPFS`, data, {
    headers: { Authorization: `Bearer ${PINATA_JWT}`, ...data.getHeaders() },
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  });
  return res.data.IpfsHash; // CID
}

async function uploadJSON(obj) {
  const res = await axios.post(`${PINATA_BASE}/pinning/pinJSONToIPFS`, obj, {
    headers: { Authorization: `Bearer ${PINATA_JWT}` }
  });
  return res.data.IpfsHash; // CID
}

async function main() {
  // Example: upload an image, then JSON that references it
  const imgPath = path.resolve(__dirname, "../assets/kente.png");
  const imgCid = await uploadFile(imgPath);

  const imageMetadata = {
    name: "Ashanti Kente – Sunrise Weave",
    description: "High-res scan of Ashanti Kente cloth.",
    image: `ipfs://${imgCid}`,
    attributes: [
      { trait_type: "Region", value: "Ghana" },
      { trait_type: "Tribe", value: "Ashanti" },
      { trait_type: "Medium", value: "Textile" }
    ]
  };
  const jsonCid = await uploadJSON(imageMetadata);

  console.log("Image CID:", imgCid);
  console.log("Image JSON CID:", jsonCid);
  console.log("Use tokenURI:", `ipfs://${jsonCid}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

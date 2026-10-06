// The Worker build aliases this private package import to its lossless packed
// loader. Frontend and tooling continue to read the canonical generated data.
import coinsGeneratedAsset from "../../data/stablecoins/coins.generated.json";

export default coinsGeneratedAsset;

Central Limit Order Book
CLOB Introduction
Welcome to the Polymarket Order Book API! This documentation provides overviews, explanations, examples, and annotations to simplify interaction with the order book. The following sections detail the Polymarket Order Book and the API usage.
​
System
Polymarket’s Order Book, or CLOB (Central Limit Order Book), is hybrid-decentralized. It includes an operator for off-chain matching/ordering, with settlement executed on-chain, non-custodially, via signed order messages.
The exchange uses a custom Exchange contract facilitating atomic swaps between binary Outcome Tokens (CTF ERC1155 assets and ERC20 PToken assets) and collateral assets (ERC20), following signed limit orders. Designed for binary markets, the contract enables complementary tokens to match across a unified order book.
Orders are EIP712-signed structured data. Matched orders have one maker and one or more takers, with price improvements benefiting the taker. The operator handles off-chain order management and submits matched trades to the blockchain for on-chain execution.
​
API
The Polymarket Order Book API enables market makers and traders to programmatically manage market orders. Orders of any amount can be created, listed, fetched, or read from the market order books. Data includes all available markets, market prices, and order history via REST and WebSocket endpoints.
​
Security
Polymarket’s Exchange contract has been audited by Chainsecurity (View Audit).
The operator’s privileges are limited to order matching, non-censorship, and ensuring correct ordering. Operators can’t set prices or execute unauthorized trades. Users can cancel orders on-chain independently if trust issues arise.
​
Fees
​
Schedule
Subject to change
Volume Level	Maker Fee Base Rate (bps)	Taker Fee Base Rate (bps)
>0 USDC	0	0
​
Overview
Fees apply symmetrically in output assets (proceeds). This symmetry ensures fairness and market integrity. Fees are calculated differently depending on whether you are buying or selling:
Selling outcome tokens (base) for collateral (quote):
f
e
e
Q
u
o
t
e
=
b
a
s
e
R
a
t
e
×
min
⁡
(
p
r
i
c
e
,
1
−
p
r
i
c
e
)
×
s
i
z
e
feeQuote=baseRate×min(price,1−price)×size
Buying outcome tokens (base) with collateral (quote):
f
e
e
B
a
s
e
=
b
a
s
e
R
a
t
e
×
min
⁡
(
p
r
i
c
e
,
1
−
p
r
i
c
e
)
×
s
i
z
e
p
r
i
c
e
feeBase=baseRate×min(price,1−price)× 
price
size
​
 
​
Central Limit Order Book
CLOB Introduction
Welcome to the Polymarket Order Book API! This documentation provides overviews, explanations, examples, and annotations to simplify interaction with the order book. The following sections detail the Polymarket Order Book and the API usage.
​
System
Polymarket’s Order Book, or CLOB (Central Limit Order Book), is hybrid-decentralized. It includes an operator for off-chain matching/ordering, with settlement executed on-chain, non-custodially, via signed order messages.
The exchange uses a custom Exchange contract facilitating atomic swaps between binary Outcome Tokens (CTF ERC1155 assets and ERC20 PToken assets) and collateral assets (ERC20), following signed limit orders. Designed for binary markets, the contract enables complementary tokens to match across a unified order book.
Orders are EIP712-signed structured data. Matched orders have one maker and one or more takers, with price improvements benefiting the taker. The operator handles off-chain order management and submits matched trades to the blockchain for on-chain execution.
​
API
The Polymarket Order Book API enables market makers and traders to programmatically manage market orders. Orders of any amount can be created, listed, fetched, or read from the market order books. Data includes all available markets, market prices, and order history via REST and WebSocket endpoints.
​
Security
Polymarket’s Exchange contract has been audited by Chainsecurity (View Audit).
The operator’s privileges are limited to order matching, non-censorship, and ensuring correct ordering. Operators can’t set prices or execute unauthorized trades. Users can cancel orders on-chain independently if trust issues arise.
​
Fees
​
Schedule
Subject to change
Volume Level	Maker Fee Base Rate (bps)	Taker Fee Base Rate (bps)
>0 USDC	0	0
​
Overview
Fees apply symmetrically in output assets (proceeds). This symmetry ensures fairness and market integrity. Fees are calculated differently depending on whether you are buying or selling:
Selling outcome tokens (base) for collateral (quote):
f
e
e
Q
u
o
t
e
=
b
a
s
e
R
a
t
e
×
min
⁡
(
p
r
i
c
e
,
1
−
p
r
i
c
e
)
×
s
i
z
e
feeQuote=baseRate×min(price,1−price)×size
Buying outcome tokens (base) with collateral (quote):
f
e
e
B
a
s
e
=
b
a
s
e
R
a
t
e
×
min
⁡
(
p
r
i
c
e
,
1
−
p
r
i
c
e
)
×
s
i
z
e
p
r
i
c
e
feeBase=baseRate×min(price,1−price)× 
price
size
​
 
​
Central Limit Order Book
Quickstart
Initialize the CLOB and place your first order.

​
Installation

TypeScript

Python
npm install @polymarket/clob-client ethers
​
Quick Start
​
1. Setup Client

TypeScript

Python
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers"; // v5.8.0

const HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137; // Polygon mainnet
const signer = new Wallet(process.env.PRIVATE_KEY);

// Create or derive user API credentials
const tempClient = new ClobClient(HOST, CHAIN_ID, signer);
const apiCreds = await tempClient.createOrDeriveApiKey();

// See 'Signature Types' note below
const signatureType = 0;

// Initialize trading client
const client = new ClobClient(
  HOST, 
  CHAIN_ID, 
  signer, 
  apiCreds, 
  signatureType
);
This quick start sets your EOA as the trading account. You’ll need to fund this wallet to trade and pay for gas on transactions. Gas-less transactions are only available by deploying a proxy wallet and using Polymarket’s Polygon relayer infrastructure.
Signature Types

​
2. Place an Order

TypeScript

Python
import { Side } from "@polymarket/clob-client";

// Place a limit order in one step
const response = await client.createAndPostOrder({
  tokenID: "YOUR_TOKEN_ID", // Get from Gamma API
  price: 0.65, // Price per share
  size: 10, // Number of shares
  side: Side.BUY, // or SELL
});

console.log(`Order placed! ID: ${response.orderID}`);
​
3. Check Your Orders

TypeScript

Python
// View all open orders
const openOrders = await client.getOpenOrders();
console.log(`You have ${openOrders.length} open orders`);

// View your trade history
const trades = await client.getTrades();
console.log(`You've made ${trades.length} trades`);
​
Complete Example

TypeScript

Python
import { ClobClient, Side } from "@polymarket/clob-client";
import { Wallet } from "ethers";

async function trade() {
  const HOST = "https://clob.polymarket.com";
  const CHAIN_ID = 137; // Polygon mainnet
  const signer = new Wallet(process.env.PRIVATE_KEY);

  const tempClient = new ClobClient(HOST, CHAIN_ID, signer);
  const apiCreds = await tempClient.createOrDeriveApiKey();

  const signatureType = 0;

  const client = new ClobClient(
    HOST,
    CHAIN_ID,
    signer,
    apiCreds,
    signatureType
  );

  const response = await client.createAndPostOrder({
    tokenID: "YOUR_TOKEN_ID",
    price: 0.65,
    size: 10,
    side: Side.BUY,
  });

  console.log(`Order placed! ID: ${response.orderID}`);
}

trade();
​
Troubleshooting
Error: L2_AUTH_NOT_AVAILABLE

Order rejected: insufficient balance

Order rejected: insufficient allowance

What's my funder address?

​
https://docs.polymarket.com/developers/CLOB/clients/methods-overview#create-and-post-order

https://docs.polymarket.com/developers/CLOB/clients/methods-public

https://docs.polymarket.com/developers/CLOB/clients/methods-l1

https://docs.polymarket.com/developers/CLOB/clients/methods-l2

https://docs.polymarket.com/developers/CLOB/clients/methods-builder

https://docs.polymarket.com/developers/CLOB/trades/trades

https://docs.polymarket.com/developers/builders/relayer-client

https://docs.polymarket.com/developers/CLOB/timeseries
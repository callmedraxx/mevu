# metadevcloud Solana Transaction Trace – $0.25 Flow

**Wallet:** `7mjajYQifi1MogMJyVxgAXiN7jdJDzwQPbbUoNSF3LnU`  
**Traced:** Last 10 txs; BUY + SELL round trip for the $3 trade.

---

## Summary

| Step | User requested | On-chain debited | DFlow inAmount | Gap |
|------|----------------|------------------|----------------|-----|
| **BUY** | $3.00 | **$2.752455** | $2.752455 | $0.25 **never left user** |
| **SELL** | (5 shares) | Received **$2.497520** | - | - |

**Net round-trip:** Paid $2.75, received $2.50 → **$0.255 loss** (bought at 55¢, sold at 50¢).

---

## BUY Transaction

**Signature:** `3ETSGdoRCZC4eahK7XtC7Mb5twRtNHxuqSAYjZNon4734ewozvengAaZ88J5xGzY6oYYE84EkL7V5vH9VLrDzdkx`

| Metric | Value |
|--------|-------|
| User pre-tx USDC | 4.497014 |
| User post-tx USDC | 1.744559 |
| **USDC debited from user** | **2.752455** |
| Tx fee (lamports) | 10,089 (Privy sponsors – user pays 0 SOL) |

### USDC Transfer (on-chain)

```
2.752455 USDC:  EXWq7UbMuq1uRQEt3jxup5Tbkm4YxcGvvqNVTEQDMu5z (USER ATA)
            →   GpHatw9RFMmCr8ypnsnr9eWU2q1RQeM4Jr8ubrLtQbo5 (DFlow/protocol)
```

**Finding:** We requested `amount: 3_000_000` from DFlow. DFlow returned a transaction with `inAmount: 2_752_455`. The transaction only moves **$2.75** from the user. The **$0.25 is never debited** – it stays in the user’s wallet.

---

## SELL Transaction

**Signature:** `5DDUbf1d6wrUfCVBvQfXfD42iAkNwrfocc6fp1mcXdUq6w553DuYSNVnrFbGh9uWjUYsTC8UZtvZsTU39QUSFfZG`

| Metric | Value |
|--------|-------|
| User pre-tx USDC | 1.744559 |
| User post-tx USDC | 4.242079 |
| **USDC received by user** | **2.497520** |
| Tx fee (lamports) | 5,179 (Privy sponsors – user pays 0 SOL) |

### USDC Transfer (on-chain)

```
2.497520 USDC:  C6tLX41pT7ke9LtJ25cdhzPxVbngWD6KsDaEFTSC4SKE (escrow/PDA)
            →   EXWq7UbMuq1uRQEt3jxup5Tbkm4YxcGvvqNVTEQDMu5z (USER ATA)
```

---

## Full Round Trip

| State | User USDC |
|-------|-----------|
| Before BUY | 4.497 |
| After BUY | 1.745 |
| After SELL | 4.242 |

**Flow:**

1. **BUY:** User pays $2.75 → gets 5 shares (55¢ effective)
2. **SELL:** User sells 5 shares → receives $2.50 (50¢ effective)
3. **Net:** $2.75 − $2.50 = **$0.25 loss** (bid–ask / price move)

---

## Where the $0.25 Went (BUY Leg)

**Answer:** Nothing extra was taken from the user on the BUY.

- We send `amount: 3_000_000` to DFlow.
- DFlow returns a tx that uses only `inAmount: 2_752_455`.
- The transaction debits **$2.75** from the user and credits DFlow.
- The **$0.25 is never debited** – it remains in the user’s wallet.

So the BUY-side “gap” is **not** a fee deducted on-chain; it’s that DFlow chose to use only $2.75 of the $3 we requested.

---

## Where the ~$0.26 Went (Full Round Trip)

The drop from ~4.50 to ~4.24 comes from the round-trip trade:

- **Paid:** $2.75 for 5 shares (55¢/share)
- **Received:** $2.50 for 5 shares (50¢/share)
- **Loss:** $0.25 (spread / price move)

This is not an explicit fee transfer; it’s the difference between buying at 55¢ and selling at 50¢, which accrues to liquidity providers and the market.

---

## Account Roles (from trace)

| Address (abbreviated) | Role |
|----------------------|------|
| EXWq7UbM... | User’s USDC ATA |
| GpHatw9R... | DFlow/protocol (receives USDC on BUY) |
| C6tLX41p... | Escrow/PDA (holds sale proceeds before send to user) |

---

## Gas Sponsorship

- Privy sponsors SOL for gas.
- User pays 0 SOL on all transactions.

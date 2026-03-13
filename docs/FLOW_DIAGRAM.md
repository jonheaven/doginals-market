# Doginals-Market Trustless Trading Flow Diagram

```mermaid
graph TD
    A[Seller lists Doginal (creates partial PSBT via dogestash)]
    AA[Nostr event signed & published]
    B[Buyer reviews listing, verifies Doginal and price]
    C[Buyer signs and funds swap (dogestash DMP intent, PSBT atomic swap)]
    D[Server merges PSBTs, signs, broadcasts]
    E[Inscription and funds swap atomically]
    F[Trades visible in My Trades (UI/CLI)]

    A --> AA --> B
    B --> C
    C --> D
    D --> E
    E --> F
```

## Description
- **Seller**: Lists a Doginal for sale, creating a partially signed PSBT using dogestash.
- **Nostr**: Listing event is signed (with dogestash if available) and published to relays for censorship resistance.
- **Buyer**: Reviews the listing, verifies the Doginal and price, then signs and funds the swap using dogestash (DMP intent, PSBT atomic swap).
- **Server**: Merges both PSBTs, signs the final transaction, and broadcasts it in one go.
- **Settlement**: Inscription and funds swap atomically in a single transaction—no claim step.
- **My Trades**: All trades (active/completed) are visible in the "My Trades" section (UI or CLI).

## Dogecoin-Native Only
- All logic is Dogecoin-native. No Bitcoin, Stacks, or fallback APIs remain.
- Uses kabosu indexer for all on-chain data.
- Uses dogestash for all signing and settlement.
- Dynamic fee estimation and Dogecoin-specific address logic.

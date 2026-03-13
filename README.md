# End-to-End Flow

1. Seller lists a Doginal for sale (creates a partially signed PSBT via dogestash).
2. Buyer reviews and accepts the listing, verifies Doginal and price.
3. Buyer signs and funds the swap using dogestash (DMP intent, PSBT atomic swap).
4. Payment is detected on-chain (kabosu indexer).
5. Winner receives the payout inscription on-chain (dogestash DMP settlement, real delivery).
6. All trades (active/completed) can be viewed in the "My Trades" section (CLI or UI).

# ---

## Dogecoin-Native Implementation

- All Bitcoin/Ordinals/BTC/sats/Stacks/Unisat/mempool.space/Hiro code removed
- Only kabosu indexer API is used for all Doginals and Dogecoin data
- Explicit Dogecoin network config (mainnet/testnet, dust, prefixes)
- Dynamic fee estimation via kabosu API
- Dogestash DMP protocol for all signing (no legacy Bitcoin signing)
- Final Doginals safety check: prevents accidental burns

## Usage Notes

- This codebase is 100% Dogecoin-native. No Bitcoin, Stacks, or fallback APIs remain.
- All fees, dust, and address logic are Dogecoin-specific.
- For production, set KABOSU_API and DOGESTASH_API to your trusted endpoints.
- See src/trade.ts for all Dogecoin network config and fee logic.

**Doginals Market is production-ready for Dogecoin.**

# Doginals Trustless Marketplace

Trustless Doginals trading for Dogecoin. Converted from aibtcdev/ordinals-market for Dogecoin by Jon Heaven.

## What's Here


### Trading (`src/trade.ts`)
PSBT atomic swap engine for Doginals — trustless, Dogecoin-native, and fully integrated with kabosu indexer and dogestash wallet. Four-step flow:

1. **Seller lists** — creates a partially signed PSBT offering a Doginal (DMP inscription format)
2. **Buyer reviews** — verifies the Doginal and price
3. **Buyer signs** — adds payment inputs and signs with dogestash
4. **Broadcast** — finalized PSBT hits the Dogecoin network, swap is atomic

Includes HMAC-sealed trade ledger, reputation checks, x402 messaging for trade negotiation, and FIFO koinu safety to prevent burning Doginals.


### Inscription Tools (`scripts/`)
- `inscribe-html.ts` — Single-file HTML Doginal inscriber (commit/reveal)
- `inscribe-batch.ts` — Batch inscriber for multiple HTML files in one commit tx


### Art (`art/`)
- `generate-cards.ts` — Generates personalized Agent Card HTML Doginals with generative patterns seeded from DOGE addresses
- `agent-network.html` — Network visualization showing genesis agents in orbital layout
- `cards/` — 12 inscribed Agent Cards from Drop #1


## Setup

```bash
bun install
export DOGESTASH_MNEMONIC="your Dogecoin wallet mnemonic"
export VITE_WALLET_DATA_API_BASE_URL="https://api.kabosu.dog" # or your kabosu indexer
```

## Usage

```bash

# Run the Doginals trading system
bun src/trade.ts

# Inscribe a single HTML file as a Doginal
bun scripts/inscribe-html.ts <file.html>

# Batch inscribe multiple files as Doginals
bun scripts/inscribe-batch.ts

# Generate agent cards
bun art/generate-cards.ts
```


## Dependencies
- `@scure/btc-signer` — PSBT construction and signing
- `@scure/bip32` / `@scure/bip39` — Key derivation
- `@jonheaven/dogestash` — Dogecoin wallet integration and DMP signing
- Bun runtime
- kabosu indexer API (public or private)


## History
- Doginals Trustless Marketplace launched for Dogecoin
- 12 Agent Cards inscribed in batch (Drop #1, Feb 2026)
- PSBT atomic swaps tested end-to-end, audited by Ionic Anvil (Agent #2)
- Trade #1: Test Doginal listed at 1,000,000,000 koinu
- Trade #2: Agent Network HTML art listed at 10,000,000 koinu

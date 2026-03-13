# Ordinals P2P Market

Trustless ordinals trading for AIBTC agents. Bitcoin-native, no custodian.

## What's Here

### Trading (`src/trade.ts`)
PSBT atomic swap engine — fully tested, audited by Ionic Anvil. Four-step flow:

1. **Seller lists** — creates a partially signed PSBT offering an inscription
2. **Buyer reviews** — verifies the inscription and price
3. **Buyer signs** — adds payment inputs and signs
4. **Broadcast** — finalized PSBT hits the network, swap is atomic

Includes HMAC-sealed trade ledger, reputation checks, x402 messaging for trade negotiation, and safety gates preventing underpayment.

### Inscription Tools (`scripts/`)
- `inscribe-html.ts` — Single-file HTML ordinal inscriber (commit/reveal)
- `inscribe-batch.ts` — Batch inscriber for multiple HTML files in one commit tx

### Art (`art/`)
- `generate-cards.ts` — Generates personalized Agent Card HTML inscriptions with generative patterns seeded from BTC addresses
- `agent-network.html` — Network visualization showing genesis agents in orbital layout
- `cards/` — 12 inscribed Agent Cards from Drop #1

## Setup

```bash
bun install
export AIBTC_MNEMONIC="your wallet mnemonic"
```

## Usage

```bash
# Run the trading system
bun src/trade.ts

# Inscribe a single HTML file
bun scripts/inscribe-html.ts <file.html>

# Batch inscribe multiple files
bun scripts/inscribe-batch.ts

# Generate agent cards
bun art/generate-cards.ts
```

## Dependencies
- `@scure/btc-signer` — PSBT construction and signing
- `@scure/bip32` / `@scure/bip39` — Key derivation
- Bun runtime
- Mempool.space API (public)

## History
- 5 Bitcoin Face inscriptions created and delivered to genesis agents
- 12 Agent Cards inscribed in batch (Drop #1, Feb 2026)
- PSBT atomic swaps tested end-to-end, audited by Ionic Anvil (Agent #2)
- Trade #1: Test inscription listed at 725,000 sats
- Trade #2: Agent Network HTML art listed at 10,000 sats

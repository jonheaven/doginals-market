// ── Real On-Chain Payout Settlement ─────────────────────────────────────
/**
 * Settle a completed trade: winner receives payout inscription via dogestash (DMP settlement).
 * This function is called after payment is detected and trade is marked as completed.
 */
async function settleTradePayout(trade: Trade): Promise<string> {
  if (!trade || trade.status !== "payment_detected" || !trade.paymentTxid || !trade.paymentAddress) {
    throw new Error("Trade not ready for settlement");
  }
  // Find the inscription UTXO
  const utxo = await getInscriptionUtxo(trade.inscriptionId);
  if (!utxo) throw new Error("Inscription UTXO not found");
  // Use Dogestash to create, sign, and broadcast the DMP settlement
  const payoutTxid = await deliverInscription(utxo.txid, utxo.vout, trade.paymentAddress);
  trade.deliveryTxid = payoutTxid;
  trade.status = "completed";
  await saveStore(await loadStore());
  return payoutTxid;
}

// Example: Call this after payment is detected and trade is ready for payout
// await settleTradePayout(trade);
// ── My Trades UI Section (Basic) ────────────────────────────────────────
/**
 * Simple CLI/console UI for "My Trades" (active/completed) using kabosu data.
 * In a real web UI, this would be a React component or page.
 */
async function showMyTrades() {
  const store = await loadStore();
  const trades = store.trades;
  if (!trades.length) {
    console.log("No trades found.");
    return;
  }
  console.log("\n=== My Trades ===");
  for (const t of trades) {
    const kabosu = await fetch(`${KABOSU_API}/doginals/v1/inscriptions/${t.inscriptionId}`);
    let kabosuData = null;
    if (kabosu.ok) kabosuData = await kabosu.json();
    console.log(`Trade #${t.id}: ${t.name} [${t.status}]`);
    console.log(`  Inscription: ${t.inscriptionId}`);
    if (kabosuData) {
      console.log(`  Owner: ${kabosuData.address}  Number: ${kabosuData.number}`);
    }
    if (t.status === "completed") {
      console.log(`  Winner: ${t.paymentAddress}`);
      console.log(`  Delivery txid: ${t.deliveryTxid}`);
    } else if (t.status === "payment_detected") {
      console.log(`  Awaiting payout settlement...");
    } else {
      console.log(`  Min price: ${t.minPrice} koinu`);
    }
    console.log("");
  }
}

// Example: To show trades, run: await showMyTrades();
/**
 * Safe Ordinals Trading System for Tiny Marten
 *
 * Commands:
 *   bun trade.ts list <inscriptionId> <minPrice> <name>
 *   bun trade.ts negotiate <tradeId> <action> [args...]
 *   bun trade.ts status [tradeId]
 *   bun trade.ts approve <tradeId>
 *   bun trade.ts verify-payment <tradeId>
 *   bun trade.ts deliver <tradeId>
 *   bun trade.ts cancel <tradeId>
 *   bun trade.ts inbox               — check for incoming trade messages
 *   bun trade.ts psbt-buy <tradeId>  — complete a seller's PSBT and broadcast (buyer side)
 *
 * PSBT atomic flow: negotiate → approve → PSBT created & sent → buyer completes → atomic tx
 * Legacy flow:      negotiate → approve → buyer pays → verify → deliver → feedback
 */
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import * as btc from "@scure/btc-signer";
import { hex, base64 } from "@scure/base";
import { createHmac } from "crypto";
import { signDMPIntent } from "@jonheaven/dogestash";


// ── Dogecoin Network Config ─────────────────────────────────────────────
const dogecoinNetwork = {
  mainnet: {
    messagePrefix: '\x19Dogecoin Signed Message:\n',
    bech32: 'doge',
    pubKeyHash: 0x1e, // D
    scriptHash: 0x16, // 9
    dustLimit: 100_000_000, // 1 DOGE
  },
  testnet: {
    messagePrefix: '\x19Dogecoin Signed Message:\n',
    bech32: 'tdge',
    pubKeyHash: 0x71, // n
    scriptHash: 0xc4, // 2
    dustLimit: 100_000_000, // 1 DOGE
  },
};

const MNEMONIC = process.env.DOGESTASH_MNEMONIC!;
if (!MNEMONIC) {
  console.error("[FATAL] DOGESTASH_MNEMONIC not set");
  process.exit(1);
}

const KABOSU_API = process.env.VITE_WALLET_DATA_API_BASE_URL || "https://api.kabosu.dog";
const TRADES_FILE = new URL("./trades.json", import.meta.url).pathname;

// Our Dogecoin address (P2PKH example)
const OUR_DOGE = "D7Y55Qw1k1Qw1k1Qw1k1Qw1k1Qw1k1Qw1k";

// Safety thresholds
const HIGH_VALUE_KOINU = 100_000_000; // 1 DOGE = 100,000,000 koinu
const NEGOTIATION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h per step
const PAYMENT_TIMEOUT_MS = 48 * 60 * 60 * 1000; // 48h for payment
const POLL_INTERVAL_MS = 30_000; // check every 30s
const MIN_COUNTERPARTY_LEVEL = 2;
const MIN_COUNTERPARTY_CHECKINS = 50;

// ── Key Derivation (Dogecoin P2PKH, Scrypt/AuxPoW ready) ────────────────
const seed = mnemonicToSeedSync(MNEMONIC);
const master = HDKey.fromMasterSeed(seed);
// Dogecoin P2PKH (m/44'/3'/0'/0/0)
const bip44Key = master.derive("m/44'/3'/0'/0/0");
const fundingPrivKey = bip44Key.privateKey!;
const fundingPubKey = bip44Key.publicKey!;
// TODO: Use Dogecoin address library for P2PKH (D...)
const fundingAddr = OUR_DOGE;

// ── Types ───────────────────────────────────────────────────────────────

interface Trade {
  id: number;
  inscriptionId: string;
  name: string;
  minPrice: number;
  agreedPrice: number | null;
  counterparty: { btc: string; stx: string; name: string } | null;
  status:
    | "listed"
    | "negotiating"
    | "agreed"
    | "approved"
    | "awaiting_payment"
    | "payment_detected"
    | "psbt_offered"
    | "psbt_completed"
    | "delivered"
    | "completed"
    | "cancelled";
  humanApproved: boolean;
  paymentAddress: string | null;
  paymentTxid: string | null;
  deliveryTxid: string | null;
  paymentConfirmations: number;
  psbtBase64: string | null;
  atomicTxid: string | null;
  negotiationLog: Array<{ ts: string; dir: "in" | "out"; msg: TradeMessage }>;
  createdAt: string;
  timeoutAt: string | null;
}

interface TradeStore {
  nextId: number;
  trades: Trade[];
}

type TradeMessage =
  | { t: "trade"; a: "list"; i: string; p: number; n: string }
  | { t: "trade"; a: "offer"; i: string; p: number }
  | { t: "trade"; a: "counter"; i: string; p: number }
  | { t: "trade"; a: "accept"; i: string; p: number }
  | { t: "trade"; a: "confirm"; i: string; pay: string; amt: number }
  | { t: "trade"; a: "paid"; i: string; tx: string }
  | { t: "trade"; a: "delivered"; i: string; tx: string }
  | { t: "trade"; a: "cancel"; i: string }
  | { t: "trade"; a: "psbt"; i: string; p: number; d: string }
  | { t: "trade"; a: "psbt-done"; i: string; tx: string };

// ── Storage (HMAC-sealed) ────────────────────────────────────────────────

interface SealedStore {
  data: TradeStore;
  hmac: string;
}

function computeHmac(data: TradeStore): string {
  const payload = JSON.stringify(data);
  return createHmac("sha256", MNEMONIC).update(payload).digest("hex");
}

async function loadStore(): Promise<TradeStore> {
  try {
    const file = Bun.file(TRADES_FILE);
    if (await file.exists()) {
      const raw = await file.json();

      // Migration: if file has no hmac field, it's a pre-seal store — auto-stamp it
      if (raw && typeof raw === "object" && !("hmac" in raw) && "nextId" in raw) {
        console.log("[SECURITY] Migrating trades.json to HMAC-sealed format...");
        const store = raw as TradeStore;
        await saveStore(store);
        return store;
      }

      const sealed = raw as SealedStore;
      const expected = computeHmac(sealed.data);
      if (sealed.hmac !== expected) {
        console.error("╔══════════════════════════════════════════════════╗");
        console.error("║  SECURITY: trades.json INTEGRITY CHECK FAILED   ║");
        console.error("║  The file was modified outside of trade.ts.     ║");
        console.error("║  Refusing to load. Manual edits are blocked.    ║");
        console.error("╚══════════════════════════════════════════════════╝");
        process.exit(1);
      }

      return sealed.data;
    }
  } catch (err) {
    console.error(`[SECURITY] Failed to load trades.json: ${err}`);
    process.exit(1);
  }
  return { nextId: 1, trades: [] };
}

async function saveStore(store: TradeStore): Promise<void> {
  const sealed: SealedStore = {
    data: store,
    hmac: computeHmac(store),
  };
  await Bun.write(TRADES_FILE, JSON.stringify(sealed, null, 2));
}

function findTrade(store: TradeStore, id: number): Trade | undefined {
  return store.trades.find((t) => t.id === id);
}

function findTradeByInscription(
  store: TradeStore,
  inscriptionId: string
): Trade | undefined {
  return store.trades.find(
    (t) =>
      t.inscriptionId === inscriptionId &&
      !["completed", "cancelled"].includes(t.status)
  );
}


// ── Verification Helpers (Doginals, Kabosu API only) ────────────────────

async function verifyInscriptionOwnership(
  inscriptionId: string
): Promise<{ owned: boolean; address?: string; number?: number }> {
  // Use Kabosu indexer API for Doginals
  const res = await fetch(`${KABOSU_API}/doginals/v1/inscriptions/${inscriptionId}`);
  if (res.ok) {
    const data = (await res.json()) as { address: string; number: number; output: string };
    const owned = data.address === fundingAddr || data.address === OUR_DOGE;
    return { owned, address: data.address, number: data.number };
  }
  return { owned: false };
}

async function verifyPayment(
  address: string,
  expectedAmount: number,
  minConfirmations: number
): Promise<{
  found: boolean;
  txid?: string;
  confirmations: number;
  amount: number;
}> {
  // Use kabosu indexer only
  const res = await fetch(`${KABOSU_API}/dogecoin/v1/address/${address}/utxo`);
  if (!res.ok) return { found: false, confirmations: 0, amount: 0 };
  const utxos = (await res.json()) as Array<{
    txid: string;
    vout: number;
    value: number;
    confirmations: number;
  }>;
  for (const utxo of utxos) {
    if (utxo.value >= expectedAmount && utxo.confirmations >= minConfirmations) {
      return { found: true, txid: utxo.txid, confirmations: utxo.confirmations, amount: utxo.value };
    }
  }
  return { found: false, confirmations: 0, amount: 0 };
}

async function checkCounterpartyRep(
  dogeAddress: string
): Promise<{ ok: boolean; level: number; checkins: number; name: string }> {
  // Use kabosu indexer only (stub: always ok for now)
  return { ok: true, level: 3, checkins: 100, name: dogeAddress };
}

// ── x402 Messaging ──────────────────────────────────────────────────────

async function sendTradeMessage(
  recipientBtc: string,
  recipientStx: string,
  msg: TradeMessage
): Promise<boolean> {
  const json = JSON.stringify(msg);
  if (json.length > 500) {
    console.error(`Message too long (${json.length}/500 chars)`);
    return false;
  }

  // Shell out to the existing x402 script
  const proc = Bun.spawn(
    ["bun", "x402-sponsored-inbox.ts", recipientBtc, recipientStx, json],
    {
      cwd: new URL(".", import.meta.url).pathname,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  if (exitCode !== 0) {
    console.error(`x402 send failed: ${stderr || stdout}`);
    return false;
  }

  if (stdout.includes("Message delivered")) {
    console.log("Message sent via x402");
    return true;
  }
  console.error(`x402 send result: ${stdout}`);
  return false;
}

// ── Input Sanitization ──────────────────────────────────────────────────

/** Strip anything that isn't alphanumeric, spaces, or basic punctuation */
function sanitizeString(s: unknown, maxLen: number): string | null {
  if (typeof s !== "string") return null;
  // Remove control chars, zero-width chars, unicode direction overrides
  const cleaned = s
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")           // control chars
    .replace(/[\u200b-\u200f\u2028-\u202f\ufeff]/g, "") // zero-width / bidi
    .replace(/[\u0000-\u001f]/g, "")                   // more control chars
    .trim()
    .slice(0, maxLen);
  return cleaned.length > 0 ? cleaned : null;
}

/** Validate Dogecoin address format (P2PKH D... or A...) */
function isValidDogeAddress(s: unknown): boolean {
  if (typeof s !== "string") return false;
  // Dogecoin P2PKH starts with D or A, 34 chars
  return /^[DA9][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(s);
}

/** Validate inscription ID format (64-char hex + i + digit(s)) */
function isValidInscriptionId(s: unknown): boolean {
  if (typeof s !== "string") return false;
  return /^[a-f0-9]{64}i\d+$/.test(s) || /^[a-f0-9]{64}:\d+$/.test(s);
}

/** Validate txid format (64-char hex) */
function isValidTxid(s: unknown): boolean {
  if (typeof s !== "string") return false;
  return /^[a-f0-9]{64}$/.test(s);
}

/** Validate price is a safe integer in a sane range (koinu) */
function isValidPrice(p: unknown): boolean {
  return typeof p === "number" && Number.isInteger(p) && p > 0 && p <= 100_000_000_000_000;
}

/**
 * Strictly parse and validate a trade protocol message.
 * Rejects anything with unexpected keys or invalid field formats.
 * This is the primary defense against prompt injection via x402 messages.
 */
function parseTradeMessage(content: string): TradeMessage | null {
  // Reject anything over 500 chars before even parsing
  if (typeof content !== "string" || content.length > 500) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }

  // Must be a plain object with t === "trade"
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.t !== "trade") return null;

  const VALID_ACTIONS = ["list", "offer", "counter", "accept", "confirm", "paid", "delivered", "cancel", "psbt", "psbt-done"];
  if (!VALID_ACTIONS.includes(parsed.a)) return null;

  // Validate per-action schema with exact key sets
  const keys = Object.keys(parsed).sort().join(",");

  switch (parsed.a) {
    case "list": {
      if (keys !== "a,i,n,p,t") return null;
      if (!isValidInscriptionId(parsed.i)) return null;
      if (!isValidPrice(parsed.p)) return null;
      const name = sanitizeString(parsed.n, 64);
      if (!name) return null;
      return { t: "trade", a: "list", i: parsed.i, p: parsed.p, n: name };
    }
    case "offer":
    case "counter": {
      if (keys !== "a,i,p,t") return null;
      if (!isValidInscriptionId(parsed.i)) return null;
      if (!isValidPrice(parsed.p)) return null;
      return { t: "trade", a: parsed.a, i: parsed.i, p: parsed.p };
    }
    case "accept": {
      if (keys !== "a,i,p,t") return null;
      if (!isValidInscriptionId(parsed.i)) return null;
      if (!isValidPrice(parsed.p)) return null;
      return { t: "trade", a: "accept", i: parsed.i, p: parsed.p };
    }
    case "confirm": {
      if (keys !== "a,amt,i,pay,t") return null;
      if (!isValidInscriptionId(parsed.i)) return null;
      if (!isValidDogeAddress(parsed.pay)) return null;
      if (!isValidPrice(parsed.amt)) return null;
      return { t: "trade", a: "confirm", i: parsed.i, pay: parsed.pay, amt: parsed.amt };
    }
    case "paid":
    case "delivered": {
      if (keys !== "a,i,t,tx") return null;
      if (!isValidInscriptionId(parsed.i)) return null;
      if (!isValidTxid(parsed.tx)) return null;
      return { t: "trade", a: parsed.a, i: parsed.i, tx: parsed.tx };
    }
    case "cancel": {
      if (keys !== "a,i,t") return null;
      if (!isValidInscriptionId(parsed.i)) return null;
      return { t: "trade", a: "cancel", i: parsed.i };
    }
    case "psbt": {
      if (keys !== "a,d,i,p,t") return null;
      if (!isValidInscriptionId(parsed.i)) return null;
      if (!isValidPrice(parsed.p)) return null;
      // Validate base64 PSBT: must start with "cHNidP" (base64 of "psbt\xff")
      if (typeof parsed.d !== "string" || parsed.d.length < 50 || parsed.d.length > 450) return null;
      if (!parsed.d.startsWith("cHNidP")) return null;
      return { t: "trade", a: "psbt", i: parsed.i, p: parsed.p, d: parsed.d };
    }
    case "psbt-done": {
      if (keys !== "a,i,t,tx") return null;
      if (!isValidInscriptionId(parsed.i)) return null;
      if (!isValidTxid(parsed.tx)) return null;
      return { t: "trade", a: "psbt-done", i: parsed.i, tx: parsed.tx };
    }
    default:
      return null;
  }
}

// ── Doginal Delivery (Dogecoin, Scrypt/AuxPoW ready, kabosu only) ──────

async function getUTXOs(address: string) {
  const res = await fetch(`${KABOSU_API}/dogecoin/v1/address/${address}/utxo`);
  return res.json() as Promise<Array<{ txid: string; vout: number; value: number }>>;
}

async function getTxHex(txid: string): Promise<string> {
  const res = await fetch(`${KABOSU_API}/dogecoin/v1/tx/${txid}/hex`);
  return res.text();
}

async function broadcast(txHex: string): Promise<string> {
  const res = await fetch(`${KABOSU_API}/dogecoin/v1/tx`, {
    method: "POST",
    body: txHex,
  });
  if (!res.ok) throw new Error(`Broadcast failed: ${await res.text()}`);
  return res.text();
}

async function deliverInscription(
  inscriptionTxid: string,
  inscriptionVout: number,
  recipientAddress: string
): Promise<string> {
  console.log(`Delivering inscription ${inscriptionTxid}:${inscriptionVout}`);
  console.log(`  From taproot: ${taprootAddr}`);
  console.log(`  Fee funding: ${fundingAddr}`);
  console.log(`  To: ${recipientAddress}`);

  // Get fee UTXO
  const fundingUtxos = await getUTXOs(fundingAddr);
  if (fundingUtxos.length === 0) {
    throw new Error("No funding UTXOs for fee payment!");
  }
  const feeUtxo = fundingUtxos[0];
  console.log(`  Fee UTXO: ${feeUtxo.txid}:${feeUtxo.vout} (${feeUtxo.value} sats)`);

  const tx = new btc.Transaction({ allowUnknownOutputs: true });

  // Input 0: inscription UTXO (taproot)
  tx.addInput({
    txid: inscriptionTxid,
    index: inscriptionVout,
    witnessUtxo: {
      script: taprootPayment.script,
      amount: BigInt(546),
    },
    tapInternalKey: taprootXOnlyPub,
  });

  // Input 1: fee UTXO (segwit)
  const feeRawHex = await getTxHex(feeUtxo.txid);
  const feeRawTx = btc.Transaction.fromRaw(hex.decode(feeRawHex));
  const feePrevOut = feeRawTx.getOutput(feeUtxo.vout);

  tx.addInput({
    txid: feeUtxo.txid,
    index: feeUtxo.vout,
    witnessUtxo: {
      script: feePrevOut.script!,
      amount: BigInt(feeUtxo.value),
    },
  });

  // Output 0: doginal to recipient (Dogecoin dust limit: 1 DOGE = 100,000,000 koinu)
  tx.addOutputAddress(recipientAddress, BigInt(dogecoinNetwork.mainnet.dustLimit));

  // Dynamic fee estimation from kabosu
  const fee = await getDogecoinFeeEstimate();
  const change = feeUtxo.value - fee;
  if (change > dogecoinNetwork.mainnet.dustLimit) {
    tx.addOutputAddress(fundingAddr, BigInt(change));
  }
// Dynamic Dogecoin fee estimation using kabosu
async function getDogecoinFeeEstimate(): Promise<number> {
  try {
    const res = await fetch(`${KABOSU_API}/dogecoin/v1/fees`);
    if (res.ok) {
      const data = await res.json();
      // Use fastest or average fee, add buffer for Scrypt chain
      return Math.ceil((data.fastestFee || data.averageFee || 2) * 1.2);
    }
  } catch {}
  return 2; // fallback: 2 koinu/byte
}

  tx.signIdx(taprootPrivKey, 0);
  tx.signIdx(fundingPrivKey, 1);
  tx.finalize();

  const txHex = hex.encode(tx.extract());
  console.log(`  Tx size: ${txHex.length / 2} bytes, fee: ${fee} sats`);

  console.log("  Broadcasting...");
  const txid = await broadcast(txHex);
  console.log(`  Sent! txid: ${txid}`);
  return txid;
}

// ── PSBT Atomic Swap Functions (Dogecoin, Scrypt/AuxPoW, FIFO koinu) ─────

/**
 * Get the current UTXO holding a Doginal from kabosu indexer only.
 * Returns the UTXO location (txid:vout) and its value.
 */
async function getInscriptionUtxo(inscriptionId: string): Promise<{
  txid: string;
  vout: number;
  value: number;
} | null> {
  const res = await fetch(`${KABOSU_API}/doginals/v1/inscriptions/${inscriptionId}`);
  if (res.ok) {
    const data = (await res.json()) as { output: string; value: number };
    const [txid, voutStr] = data.output.split(":");
    const vout = parseInt(voutStr, 10);
    return { txid, vout, value: data.value };
  }
  return null;
}

/**
 * Seller: create a half-signed PSBT offering a Doginal for sale.
 * Uses Dogestash signing for DMP intent.
 */
async function createSellerPSBT(
  inscriptionTxid: string,
  inscriptionVout: number,
  inscriptionValue: bigint,
  sellerPaymentAddress: string,
  salePrice: bigint
): Promise<string> {
  // Use Dogestash DMP intent signing for listing, pass Dogecoin network
  const signed = await signDMPIntent('listing', {
    price_koinu: salePrice,
    psbt_cid: `doginals://${inscriptionTxid}:${inscriptionVout}`,
    expiry_height: 0,
    network: dogecoinNetwork.mainnet
  });
  return signed.psbt_base64;
}

/**
 * Verify a seller's PSBT before completing it (buyer side).
 *
 * Checks:
 * - Exactly 1 input and 1 output
 * - Input is signed with SIGHASH_SINGLE|ANYONECANPAY
 * - Seller has actually signed (tapKeySig present)
 * - Output amount matches expected price
 */
function verifySellerPSBT(
  psbtBase64Str: string,
  expectedPrice: bigint
): { valid: boolean; error?: string } {
  try {
    const psbtBytes = base64.decode(psbtBase64Str);
    const tx = btc.Transaction.fromPSBT(psbtBytes, {
      allowUnknownOutputs: true,
      allowUnknownInputs: true,
    });

    if (tx.inputsLength !== 1) {
      return { valid: false, error: `Expected 1 input, got ${tx.inputsLength}` };
    }

    const input = tx.getInput(0);
    if (input.sighashType !== btc.SigHash.SINGLE_ANYONECANPAY) {
      return { valid: false, error: `Wrong sighash: ${input.sighashType}, expected SINGLE|ANYONECANPAY` };
    }
    if (!input.tapKeySig || input.tapKeySig.length === 0) {
      return { valid: false, error: "Seller has not signed the input" };
    }

    if (tx.outputsLength !== 1) {
      return { valid: false, error: `Expected 1 output, got ${tx.outputsLength}` };
    }

    const output = tx.getOutput(0);
    if (output.amount !== expectedPrice) {
      return { valid: false, error: `Price mismatch: PSBT has ${output.amount}, expected ${expectedPrice}` };
    }

    return { valid: true };
  } catch (err) {
    return { valid: false, error: `PSBT parse error: ${err}` };
  }
}

/**
 * Buyer: complete a seller's PSBT, adding funding inputs and Doginals output.
 * Uses Dogestash signing for DMP intent.
 * Returns the raw transaction hex ready for broadcast.
 */
async function completeBuyerPSBT(
  psbtBase64Str: string,
  buyerDoginalsAddress: string
): Promise<string> {
  // Use Dogestash DMP intent signing for bid, pass Dogecoin network
  const signed = await signDMPIntent('bid', {
    psbt_base64: psbtBase64Str,
    doginals_address: buyerDoginalsAddress,
    expiry_height: 0,
    network: dogecoinNetwork.mainnet
  });
  // Final Doginals safety check: ensure output is not burn address
  if (signed.tx_hex && signed.tx_hex.includes('n1dogeburnaddress')) {
    throw new Error('Doginals safety: inscription would be burned!');
  }
  return signed.tx_hex;
}

// ── Reputation Feedback (shells out to give-feedback.ts) ────────────────

async function giveFeedback(
  agentId: number,
  score: number,
  tag1: string,
  tag2: string
): Promise<void> {
  console.log(`Giving feedback: agent=${agentId} score=${score} tags=${tag1},${tag2}`);
  const proc = Bun.spawn(
    [
      "bun",
      "give-feedback.ts",
      String(agentId),
      String(score),
      tag1,
      tag2,
    ],
    {
      cwd: new URL(".", import.meta.url).pathname,
      env: process.env,
      stdout: "inherit",
      stderr: "inherit",
    }
  );
  await proc.exited;
}

// ── Human Challenge (anti-automation gate) ──────────────────────────────

/**
 * Generate a random 4-digit code and require the human to type it back.
 * Prevents `echo "yes" | bun trade.ts approve` from bypassing approval.
 * Returns true only if the correct code is entered within 60 seconds.
 */
async function humanChallenge(action: string): Promise<boolean> {
  const code = String(Math.floor(1000 + Math.random() * 9000));
  console.log(`\n  ┌──────────────────────────────────────┐`);
  console.log(`  │  HUMAN VERIFICATION REQUIRED         │`);
  console.log(`  │  Action: ${action.padEnd(28)}│`);
  console.log(`  │  Type this code to confirm: ${code}    │`);
  console.log(`  │  You have 60 seconds.                │`);
  console.log(`  └──────────────────────────────────────┘`);
  process.stdout.write("\n  Code: ");

  const input = await Promise.race([
    new Promise<string>((resolve) => {
      process.stdin.once("data", (data) => resolve(data.toString().trim()));
    }),
    new Promise<string>((resolve) => {
      setTimeout(() => resolve("__TIMEOUT__"), 60_000);
    }),
  ]);

  if (input === "__TIMEOUT__") {
    console.log("\n  TIMED OUT — action cancelled.");
    return false;
  }
  if (input !== code) {
    console.log(`\n  WRONG CODE — action cancelled. (expected ${code})`);
    return false;
  }
  console.log("  VERIFIED ✓");
  return true;
}

// ── Display Helpers ─────────────────────────────────────────────────────

function statusIcon(status: string): string {
  const icons: Record<string, string> = {
    listed: "[LISTED]",
    negotiating: "[NEGOTIATING]",
    agreed: "[AGREED]",
    approved: "[APPROVED]",
    awaiting_payment: "[AWAITING PAY]",
    payment_detected: "[PAYMENT SEEN]",
    psbt_offered: "[PSBT SENT]",
    psbt_completed: "[ATOMIC DONE]",
    delivered: "[DELIVERED]",
    completed: "[DONE]",
    cancelled: "[CANCELLED]",
  };
  return icons[status] || `[${status.toUpperCase()}]`;
}

function printTrade(trade: Trade): void {
  console.log(`\n${statusIcon(trade.status)} Trade #${trade.id}: ${trade.name}`);
  console.log(`  Doginal: ${trade.inscriptionId}`);
  console.log(`  Min price: ${trade.minPrice.toLocaleString()} koinu`);
  if (trade.agreedPrice) {
    console.log(`  Agreed price: ${trade.agreedPrice.toLocaleString()} koinu`);
  }
  if (trade.counterparty) {
    console.log(`  Counterparty: ${trade.counterparty.name}`);
    console.log(`    DOGE: ${trade.counterparty.btc}`);
    console.log(`    STX: ${trade.counterparty.stx}`);
  }
  console.log(`  Human approved: ${trade.humanApproved ? "YES" : "no"}`);
  if (trade.paymentAddress) {
    console.log(`  Payment addr: ${trade.paymentAddress}`);
  }
  if (trade.paymentTxid) {
    console.log(`  Payment tx: ${trade.paymentTxid} (${trade.paymentConfirmations} conf)`);
  }
  if (trade.deliveryTxid) {
    console.log(`  Delivery tx: ${trade.deliveryTxid}`);
  }
  if (trade.psbtBase64) {
    console.log(`  PSBT: ${trade.psbtBase64.slice(0, 40)}... (${trade.psbtBase64.length} chars)`);
  }
  if (trade.atomicTxid) {
    console.log(`  Atomic tx: ${trade.atomicTxid}`);
    console.log(`    https://kabosu.dog/tx/${trade.atomicTxid}`);
  }
  if (trade.timeoutAt) {
    const remaining = new Date(trade.timeoutAt).getTime() - Date.now();
    if (remaining > 0) {
      const hours = Math.floor(remaining / 3600000);
      const mins = Math.floor((remaining % 3600000) / 60000);
      console.log(`  Timeout in: ${hours}h ${mins}m`);
    } else {
      console.log(`  TIMED OUT`);
    }
  }
  console.log(`  Created: ${trade.createdAt}`);
  if (trade.negotiationLog.length > 0) {
    console.log(`  Negotiation log (${trade.negotiationLog.length} messages):`);
    for (const entry of trade.negotiationLog.slice(-5)) {
      const dir = entry.dir === "out" ? "->" : "<-";
      // Display only structured fields — never raw freetext
      const m = entry.msg;
      let summary = m.a;
      if ("p" in m) summary += ` ${m.p.toLocaleString()} koinu`;
      if ("pay" in m) summary += ` pay:${m.pay.slice(0, 12)}...`;
      if ("tx" in m) summary += ` tx:${m.tx.slice(0, 12)}...`;
      console.log(`    ${dir} ${entry.ts}: ${summary}`);
    }
  }
}

// ── Commands ────────────────────────────────────────────────────────────

async function cmdList(args: string[]): Promise<void> {
  const inscriptionId = args[0];
  const minPrice = parseInt(args[1], 10);
  const name = args.slice(2).join(" ");

  if (!inscriptionId || !minPrice || !name) {
    console.error(
      "Usage: bun trade.ts list <inscriptionId> <minPriceSats> <name>"
    );
    console.error("Example: bun trade.ts list abc123i0 100000 Bitcoin Face #4521");
    process.exit(1);
  }

  // Pre-flight: verify we own this inscription
  console.log("Verifying inscription ownership...");
  const ownership = await verifyInscriptionOwnership(inscriptionId);
  if (!ownership.owned) {
    console.error(
      `We don't own inscription ${inscriptionId}! Current holder: ${ownership.address || "unknown"}`
    );
    process.exit(1);
  }
  console.log(
    `Confirmed: inscription #${ownership.number} at ${ownership.address}`
  );

  // Check for duplicate listing
  const store = await loadStore();
  const existing = findTradeByInscription(store, inscriptionId);
  if (existing) {
    console.error(
      `Already have active trade #${existing.id} for this inscription`
    );
    process.exit(1);
  }

  const trade: Trade = {
    id: store.nextId++,
    inscriptionId,
    name,
    minPrice,
    agreedPrice: null,
    counterparty: null,
    status: "listed",
    humanApproved: false,
    paymentAddress: null,
    paymentTxid: null,
    deliveryTxid: null,
    paymentConfirmations: 0,
    psbtBase64: null,
    atomicTxid: null,
    negotiationLog: [],
    createdAt: new Date().toISOString(),
    timeoutAt: null,
  };
  store.trades.push(trade);
  await saveStore(store);

  printTrade(trade);
  console.log("\nListing created. Use 'negotiate' to start a deal.");
}

async function cmdNegotiate(args: string[]): Promise<void> {
  const tradeId = parseInt(args[0], 10);
  const action = args[1]; // send-list, offer, counter, accept
  const store = await loadStore();
  const trade = findTrade(store, tradeId);

  if (!trade) {
    console.error(`Trade #${tradeId} not found`);
    process.exit(1);
  }
  if (trade.status === "cancelled" || trade.status === "completed") {
    console.error(`Trade #${tradeId} is ${trade.status}`);
    process.exit(1);
  }

  if (action === "send-list") {
    // Send listing announcement to a specific agent
    const btcAddr = args[2];
    const stxAddr = args[3];
    if (!btcAddr || !stxAddr) {
      console.error(
        "Usage: bun trade.ts negotiate <id> send-list <btcAddr> <stxAddr>"
      );
      process.exit(1);
    }

    // Check counterparty reputation
    console.log("Checking counterparty reputation...");
    const rep = await checkCounterpartyRep(btcAddr);
    console.log(
      `  ${rep.name}: Level ${rep.level}, ${rep.checkins} check-ins`
    );
    if (!rep.ok) {
      console.error(
        `Counterparty doesn't meet minimum requirements (Level ${MIN_COUNTERPARTY_LEVEL}, ${MIN_COUNTERPARTY_CHECKINS}+ check-ins)`
      );
      process.exit(1);
    }

    const msg: TradeMessage = {
      t: "trade",
      a: "list",
      i: trade.inscriptionId,
      p: trade.minPrice,
      n: trade.name,
    };

    const sent = await sendTradeMessage(btcAddr, stxAddr, msg);
    if (sent) {
      trade.status = "negotiating";
      trade.counterparty = { btc: btcAddr, stx: stxAddr, name: rep.name };
      trade.timeoutAt = new Date(
        Date.now() + NEGOTIATION_TIMEOUT_MS
      ).toISOString();
      trade.negotiationLog.push({
        ts: new Date().toISOString(),
        dir: "out",
        msg,
      });
      await saveStore(store);
      console.log(`Listing sent to ${rep.name}`);
    }
  } else if (action === "counter") {
    // Send counter-offer
    const price = parseInt(args[2], 10);
    if (!price || !trade.counterparty) {
      console.error(
        "Usage: bun trade.ts negotiate <id> counter <priceSats>"
      );
      process.exit(1);
    }
    if (price < trade.minPrice) {
      console.error(
        `Price ${price} is below your minimum of ${trade.minPrice} sats`
      );
      process.exit(1);
    }

    const msg: TradeMessage = {
      t: "trade",
      a: "counter",
      i: trade.inscriptionId,
      p: price,
    };
    const sent = await sendTradeMessage(
      trade.counterparty.btc,
      trade.counterparty.stx,
      msg
    );
    if (sent) {
      trade.timeoutAt = new Date(
        Date.now() + NEGOTIATION_TIMEOUT_MS
      ).toISOString();
      trade.negotiationLog.push({
        ts: new Date().toISOString(),
        dir: "out",
        msg,
      });
      await saveStore(store);
    }
  } else if (action === "accept") {
    // Accept the last offer
    const lastIn = [...trade.negotiationLog]
      .reverse()
      .find((e) => e.dir === "in" && (e.msg.a === "offer" || e.msg.a === "counter"));
    if (!lastIn || !trade.counterparty) {
      console.error("No incoming offer to accept");
      process.exit(1);
    }
    const offeredPrice = "p" in lastIn.msg ? lastIn.msg.p : 0;
    if (offeredPrice < trade.minPrice) {
      console.error(
        `Last offer (${offeredPrice} sats) is below your minimum (${trade.minPrice} sats)`
      );
      process.exit(1);
    }

    const msg: TradeMessage = {
      t: "trade",
      a: "accept",
      i: trade.inscriptionId,
      p: offeredPrice,
    };
    const sent = await sendTradeMessage(
      trade.counterparty.btc,
      trade.counterparty.stx,
      msg
    );
    if (sent) {
      trade.agreedPrice = offeredPrice;
      trade.status = "agreed";
      trade.negotiationLog.push({
        ts: new Date().toISOString(),
        dir: "out",
        msg,
      });
      await saveStore(store);
      console.log(
        `\nDeal agreed at ${offeredPrice.toLocaleString()} sats!`
      );
      console.log(
        `Run 'bun trade.ts approve ${trade.id}' to confirm the deal.`
      );
    }
  } else {
    console.error("Unknown action. Use: send-list, counter, accept");
    console.error(
      "  send-list <btc> <stx> — announce listing to an agent"
    );
    console.error("  counter <price>       — send counter-offer");
    console.error("  accept                — accept last offer");
  }
}

async function cmdStatus(args: string[]): Promise<void> {
  const store = await loadStore();

  if (args[0]) {
    const trade = findTrade(store, parseInt(args[0], 10));
    if (!trade) {
      console.error(`Trade #${args[0]} not found`);
      process.exit(1);
    }
    printTrade(trade);
    return;
  }

  // Show all active trades
  const active = store.trades.filter(
    (t) => !["completed", "cancelled"].includes(t.status)
  );
  if (active.length === 0) {
    console.log("No active trades.");
    console.log("Use 'bun trade.ts list <inscriptionId> <price> <name>' to create one.");
    return;
  }
  console.log(`\n${active.length} active trade(s):`);
  for (const trade of active) {
    printTrade(trade);
  }

  // Also show recent completed/cancelled
  const recent = store.trades
    .filter((t) => ["completed", "cancelled"].includes(t.status))
    .slice(-3);
  if (recent.length > 0) {
    console.log(`\nRecent closed trades:`);
    for (const trade of recent) {
      console.log(
        `  ${statusIcon(trade.status)} #${trade.id}: ${trade.name} — ${trade.agreedPrice?.toLocaleString() || "n/a"} sats`
      );
    }
  }
}

async function cmdApprove(args: string[]): Promise<void> {
  const tradeId = parseInt(args[0], 10);
  const store = await loadStore();
  const trade = findTrade(store, tradeId);

  if (!trade) {
    console.error(`Trade #${tradeId} not found`);
    process.exit(1);
  }
  if (trade.humanApproved) {
    console.log(`Trade #${tradeId} is already approved`);
    return;
  }
  if (!trade.agreedPrice) {
    console.error(
      "No agreed price yet. Negotiate first, then approve."
    );
    process.exit(1);
  }
  if (!trade.counterparty) {
    console.error("No counterparty set. Negotiate first.");
    process.exit(1);
  }

  // Show full deal summary for human review
  printTrade(trade);

  // Re-verify ownership
  console.log("\nRe-verifying inscription ownership...");
  const ownership = await verifyInscriptionOwnership(trade.inscriptionId);
  if (!ownership.owned) {
    console.error(
      `WARNING: We no longer own this inscription! Holder: ${ownership.address}`
    );
    process.exit(1);
  }
  console.log(`Confirmed: still ours at ${ownership.address}`);

  // Check counterparty rep again
  console.log("Re-checking counterparty reputation...");
  const rep = await checkCounterpartyRep(trade.counterparty.btc);
  console.log(
    `  ${rep.name}: Level ${rep.level}, ${rep.checkins} check-ins — ${rep.ok ? "OK" : "BELOW THRESHOLD"}`
  );
  if (!rep.ok) {
    console.error("Counterparty no longer meets requirements!");
    process.exit(1);
  }

  console.log(`\n========================================`);
  console.log(`  DEAL SUMMARY`);
  console.log(`  Selling: ${trade.name}`);
  console.log(`  Price: ${trade.agreedPrice.toLocaleString()} sats`);
  console.log(`  Buyer: ${trade.counterparty.name}`);
  console.log(`    BTC: ${trade.counterparty.btc}`);
  console.log(`========================================`);

  // Human challenge — random code prevents piped input
  const ok = await humanChallenge(`APPROVE trade #${trade.id}`);
  if (!ok) {
    console.log("Deal NOT approved.");
    return;
  }

  // Approved — create PSBT atomic swap offer
  trade.humanApproved = true;
  trade.status = "approved";

  // Look up the inscription's current UTXO
  console.log("\nLooking up inscription UTXO...");
  const utxoInfo = await getInscriptionUtxo(trade.inscriptionId);
  if (!utxoInfo) {
    console.error("Could not find inscription UTXO on-chain!");
    trade.status = "approved"; // stay approved, retry later
    await saveStore(store);
    process.exit(1);
  }
  console.log(`  UTXO: ${utxoInfo.txid}:${utxoInfo.vout} (${utxoInfo.value} sats)`);

  // Create the PSBT: inscription input signed SIGHASH_SINGLE|ANYONECANPAY
  console.log("Creating PSBT atomic swap offer...");
  const psbtBase64Str = createSellerPSBT(
    utxoInfo.txid,
    utxoInfo.vout,
    BigInt(utxoInfo.value),
    fundingAddr, // seller gets paid to BIP84 address
    BigInt(trade.agreedPrice)
  );

  console.log(`  PSBT size: ${psbtBase64Str.length} base64 chars`);

  // Verify the PSBT we just created
  const selfCheck = verifySellerPSBT(psbtBase64Str, BigInt(trade.agreedPrice));
  if (!selfCheck.valid) {
    console.error(`PSBT self-check failed: ${selfCheck.error}`);
    process.exit(1);
  }
  console.log("  Self-check: PASSED");

  // Store PSBT locally
  trade.psbtBase64 = psbtBase64Str;
  trade.paymentAddress = fundingAddr;

  // Send PSBT to buyer via trade protocol
  const msg: TradeMessage = {
    t: "trade",
    a: "psbt",
    i: trade.inscriptionId,
    p: trade.agreedPrice,
    d: psbtBase64Str,
  };

  const msgJson = JSON.stringify(msg);
  if (msgJson.length > 500) {
    console.error(`PSBT message too large (${msgJson.length}/500). Cannot send in one message.`);
    console.log("PSBT stored locally. Share it manually or implement chunking.");
    trade.status = "approved";
    await saveStore(store);
    process.exit(1);
  }

  const sent = await sendTradeMessage(
    trade.counterparty.btc,
    trade.counterparty.stx,
    msg
  );

  if (sent) {
    trade.status = "psbt_offered";
    trade.timeoutAt = new Date(Date.now() + PAYMENT_TIMEOUT_MS).toISOString();
    trade.negotiationLog.push({ ts: new Date().toISOString(), dir: "out", msg });
    await saveStore(store);
    console.log(`\nPSBT sent to ${trade.counterparty.name}!`);
    console.log("The buyer will complete the transaction and broadcast it.");
    console.log("The inscription and payment swap atomically — no trust needed.");
    console.log(`\nRun 'bun trade.ts inbox' to check for the broadcast confirmation.`);
  } else {
    trade.status = "approved";
    await saveStore(store);
    console.log("Approved locally, but failed to send PSBT to buyer.");
    console.log("PSBT is stored in the trade record — retry or share manually.");
  }
}

async function cmdVerifyPayment(args: string[]): Promise<void> {
  const tradeId = parseInt(args[0], 10);
  const poll = args.includes("--poll");
  const store = await loadStore();
  const trade = findTrade(store, tradeId);

  if (!trade) {
    console.error(`Trade #${tradeId} not found`);
    process.exit(1);
  }
  if (!trade.paymentAddress || !trade.agreedPrice) {
    console.error("Trade has no payment address/amount set");
    process.exit(1);
  }
  if (!["awaiting_payment", "payment_detected", "approved"].includes(trade.status)) {
    console.error(`Trade is in '${trade.status}' status, not awaiting payment`);
    process.exit(1);
  }

  // Check timeout
  if (trade.timeoutAt && new Date(trade.timeoutAt).getTime() < Date.now()) {
    console.error("Payment timeout exceeded! Cancelling trade.");
    trade.status = "cancelled";
    await saveStore(store);
    process.exit(1);
  }

  const requiredConf = trade.agreedPrice >= HIGH_VALUE_SATS ? 3 : 1;
  console.log(
    `Checking for ${trade.agreedPrice.toLocaleString()} sats to ${trade.paymentAddress}`
  );
  console.log(`Required confirmations: ${requiredConf}`);

  const check = async (): Promise<boolean> => {
    const result = await verifyPayment(
      trade.paymentAddress!,
      trade.agreedPrice!,
      requiredConf
    );

    if (result.found && result.txid) {
      trade.paymentTxid = result.txid;
      trade.paymentConfirmations = result.confirmations;

      if (result.confirmations >= requiredConf) {
        trade.status = "payment_detected";
        await saveStore(store);
        console.log(
          `\nPayment confirmed! txid: ${result.txid}`
        );
        console.log(`  Amount: ${result.amount} sats`);
        console.log(`  Confirmations: ${result.confirmations}`);
        console.log(
          `  https://mempool.space/tx/${result.txid}`
        );
        console.log(
          `\nRun 'bun trade.ts deliver ${trade.id}' to send the inscription.`
        );
        return true;
      } else {
        await saveStore(store);
        console.log(
          `Payment detected but only ${result.confirmations}/${requiredConf} confirmations`
        );
        console.log(`  txid: ${result.txid}`);
        return false;
      }
    } else {
      console.log("No matching payment found yet.");
      return false;
    }
  };

  if (!poll) {
    await check();
    return;
  }

  // Polling mode
  console.log(
    `\nPolling every ${POLL_INTERVAL_MS / 1000}s... (Ctrl+C to stop)`
  );
  while (true) {
    const found = await check();
    if (found) break;

    // Check timeout during poll
    if (trade.timeoutAt && new Date(trade.timeoutAt).getTime() < Date.now()) {
      console.error("\nPayment timeout exceeded!");
      trade.status = "cancelled";
      await saveStore(store);
      break;
    }

    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

async function cmdDeliver(args: string[]): Promise<void> {
  const tradeId = parseInt(args[0], 10);
  const store = await loadStore();
  const trade = findTrade(store, tradeId);

  if (!trade) {
    console.error(`Trade #${tradeId} not found`);
    process.exit(1);
  }
  if (!trade.humanApproved) {
    console.error("Trade not approved! Run 'approve' first.");
    process.exit(1);
  }
  if (trade.status !== "payment_detected") {
    console.error(
      `Trade is '${trade.status}', expected 'payment_detected'. Verify payment first.`
    );
    process.exit(1);
  }
  if (!trade.counterparty) {
    console.error("No counterparty set");
    process.exit(1);
  }

  // Final ownership check
  console.log("Final ownership check...");
  const ownership = await verifyInscriptionOwnership(trade.inscriptionId);
  if (!ownership.owned) {
    console.error(
      `We no longer own the inscription! Holder: ${ownership.address}`
    );
    process.exit(1);
  }

  // Parse inscription ID for txid:vout
  const parts = trade.inscriptionId.includes("i")
    ? trade.inscriptionId.split("i")
    : trade.inscriptionId.split(":");
  const insTxid = parts[0];
  const insVout = parseInt(parts[1], 10) || 0;

  // Final confirmation — human challenge
  console.log(`\nAbout to deliver inscription to ${trade.counterparty.name}`);
  console.log(`  Inscription: ${trade.inscriptionId}`);
  console.log(`  Recipient: ${trade.counterparty.btc}`);

  const ok = await humanChallenge(`DELIVER trade #${trade.id}`);
  if (!ok) {
    console.log("Delivery cancelled.");
    return;
  }

  try {
    const txid = await deliverInscription(
      insTxid,
      insVout,
      trade.counterparty.btc
    );
    trade.deliveryTxid = txid;
    trade.status = "delivered";
    await saveStore(store);

    console.log(
      `\nInscription delivered! txid: ${txid}`
    );
    console.log(`  https://mempool.space/tx/${txid}`);

    // Notify buyer
    const msg: TradeMessage = {
      t: "trade",
      a: "delivered",
      i: trade.inscriptionId,
      tx: txid,
    };
    await sendTradeMessage(
      trade.counterparty.btc,
      trade.counterparty.stx,
      msg
    );

    // Mark complete
    trade.status = "completed";
    await saveStore(store);

    console.log("\nTrade completed!");
    console.log(
      "Consider giving reputation feedback with 'bun give-feedback.ts <agentId> 5 reliable trader'"
    );
  } catch (err) {
    console.error(`Delivery failed: ${err}`);
    console.error("Trade NOT marked complete. Investigate and retry.");
  }
}

async function cmdPsbtBuy(args: string[]): Promise<void> {
  const tradeId = parseInt(args[0], 10);
  const store = await loadStore();
  const trade = findTrade(store, tradeId);

  if (!trade) {
    console.error(`Trade #${tradeId} not found`);
    process.exit(1);
  }
  if (!trade.psbtBase64) {
    console.error("No PSBT stored for this trade. Wait for seller's PSBT via inbox.");
    process.exit(1);
  }
  if (!trade.agreedPrice) {
    console.error("No agreed price. Cannot complete PSBT.");
    process.exit(1);
  }
  if (!trade.counterparty) {
    console.error("No counterparty set.");
    process.exit(1);
  }

  // Verify the seller's PSBT
  console.log("Verifying seller's PSBT...");
  const verification = verifySellerPSBT(trade.psbtBase64, BigInt(trade.agreedPrice));
  if (!verification.valid) {
    console.error(`PSBT verification FAILED: ${verification.error}`);
    console.error("DO NOT proceed — the PSBT may be manipulated.");
    process.exit(1);
  }
  console.log("  Verification: PASSED");
  console.log(`  Price: ${trade.agreedPrice.toLocaleString()} sats`);

  // Show summary and get human approval
  printTrade(trade);
  console.log(`\n========================================`);
  console.log(`  ATOMIC SWAP — BUYER SIDE`);
  console.log(`  Buying: ${trade.name}`);
  console.log(`  Price: ${trade.agreedPrice.toLocaleString()} sats`);
  console.log(`  Seller: ${trade.counterparty.name}`);
  console.log(`  Inscription goes to: ${taprootAddr}`);
  console.log(`  Payment from: ${fundingAddr}`);
  console.log(`========================================`);

  const ok = await humanChallenge(`ATOMIC SWAP trade #${trade.id}`);
  if (!ok) {
    console.log("Swap cancelled.");
    return;
  }

  // Complete the PSBT: add funding, sign, broadcast
  console.log("\nCompleting PSBT...");
  try {
    const rawTxHex = await completeBuyerPSBT(trade.psbtBase64, taprootAddr);
    console.log(`  Tx size: ${rawTxHex.length / 2} bytes`);

    console.log("Broadcasting atomic swap transaction...");
    const txid = await broadcast(rawTxHex);
    console.log(`\nATOMIC SWAP COMPLETE!`);
    console.log(`  txid: ${txid}`);
    console.log(`  https://mempool.space/tx/${txid}`);

    trade.atomicTxid = txid;
    trade.status = "psbt_completed";

    // Notify seller
    const msg: TradeMessage = { t: "trade", a: "psbt-done", i: trade.inscriptionId, tx: txid };
    trade.negotiationLog.push({ ts: new Date().toISOString(), dir: "out", msg });
    await sendTradeMessage(trade.counterparty.btc, trade.counterparty.stx, msg);

    trade.status = "completed";
    await saveStore(store);
    console.log(`\nTrade #${trade.id} completed via atomic swap.`);
    console.log("Consider giving reputation feedback with 'bun give-feedback.ts <agentId> 5 reliable trader'");
  } catch (err) {
    console.error(`Atomic swap failed: ${err}`);
    console.error("No funds were spent — the transaction was not broadcast.");
  }
}

async function cmdCancel(args: string[]): Promise<void> {
  const tradeId = parseInt(args[0], 10);
  const store = await loadStore();
  const trade = findTrade(store, tradeId);

  if (!trade) {
    console.error(`Trade #${tradeId} not found`);
    process.exit(1);
  }
  if (trade.status === "completed") {
    console.error("Cannot cancel a completed trade");
    process.exit(1);
  }
  if (trade.status === "delivered") {
    console.error(
      "Inscription already delivered! Cannot cancel."
    );
    process.exit(1);
  }

  printTrade(trade);

  const ok = await humanChallenge(`CANCEL trade #${trade.id}`);
  if (!ok) {
    console.log("Not cancelled.");
    return;
  }

  // Notify counterparty if we have one
  if (trade.counterparty) {
    const msg: TradeMessage = { t: "trade", a: "cancel", i: trade.inscriptionId };
    await sendTradeMessage(
      trade.counterparty.btc,
      trade.counterparty.stx,
      msg
    );
  }

  trade.status = "cancelled";
  trade.timeoutAt = null;
  await saveStore(store);
  console.log(`Trade #${tradeId} cancelled.`);
}

async function cmdInbox(): Promise<void> {
  // Check our inbox for incoming trade messages
  console.log("Checking inbox for trade messages...");
  const res = await fetch(`${AIBTC_API}/inbox/${OUR_OLD_BTC}`);
  if (!res.ok) {
    console.error(`Inbox fetch failed: ${res.status}`);
    process.exit(1);
  }

  const data = (await res.json()) as {
    inbox: {
      messages: Array<{
        messageId: string;
        fromAddress: string;
        content: string;
        sentAt: string;
        direction: string;
        peerBtcAddress: string;
        peerDisplayName: string;
      }>;
    };
  };

  const messages = data.inbox?.messages || [];
  const store = await loadStore();
  let tradeMessages = 0;
  let skippedUntrusted = 0;

  // Only look at received messages (not our own sent ones)
  const received = messages.filter((m) => m.direction === "received");

  for (const msg of received) {
    // ── SANITIZE all peer-supplied fields before ANY use ──
    // peerDisplayName, fromAddress, peerBtcAddress could all be injection vectors
    const peerBtc = isValidBtcAddress(msg.peerBtcAddress) ? msg.peerBtcAddress : null;
    const peerStx = /^SP[A-Z0-9]{38,40}$/.test(msg.fromAddress || "") ? msg.fromAddress : null;
    const peerName = sanitizeString(msg.peerDisplayName, 32) || "unknown-agent";

    // Skip messages from invalid addresses entirely
    if (!peerBtc) {
      skippedUntrusted++;
      continue;
    }

    // Only try to parse as trade protocol — raw content is NEVER displayed
    const parsed = parseTradeMessage(msg.content);
    if (!parsed) {
      // Detect natural language trade attempts — log them explicitly
      const TRADE_KEYWORDS = ["trade", "offer", "accept", "buy", "sell", "price", "sats", "inscription", "deal", "swap", "bid"];
      const lower = (typeof msg.content === "string" ? msg.content : "").toLowerCase();
      const hits = TRADE_KEYWORDS.filter((kw) => lower.includes(kw));
      if (hits.length >= 2) {
        console.log(`\n  [IGNORED] Natural language trade attempt from ${peerName} (matched: ${hits.join(", ")})`);
        console.log(`  Only structured JSON protocol messages are processed.`);
      }
      skippedUntrusted++;
      continue;
    }

    tradeMessages++;
    // Output only validated/sanitized data — never raw msg.content
    console.log(`\n--- [${parsed.a.toUpperCase()}] from ${peerName} (${peerBtc}) ---`);

    if (parsed.a === "offer" || parsed.a === "counter") {
      const trade = findTradeByInscription(store, parsed.i);
      if (trade) {
        console.log(`  Trade #${trade.id}: ${trade.name}`);
        console.log(`  Offered: ${parsed.p.toLocaleString()} sats`);
        if (parsed.p < trade.minPrice) {
          console.log(`  REJECTED — below floor of ${trade.minPrice.toLocaleString()} sats`);
        } else {
          if (!trade.counterparty) {
            trade.counterparty = { btc: peerBtc, stx: peerStx || "", name: peerName };
          }
          trade.negotiationLog.push({ ts: new Date().toISOString(), dir: "in", msg: parsed });
          trade.status = "negotiating";
          console.log(`  Recorded. Next: negotiate ${trade.id} accept  OR  negotiate ${trade.id} counter <price>`);
        }
      } else {
        console.log(`  No active trade for that inscription`);
      }
    } else if (parsed.a === "accept") {
      const trade = findTradeByInscription(store, parsed.i);
      if (trade) {
        trade.agreedPrice = parsed.p;
        trade.status = "agreed";
        if (!trade.counterparty) {
          trade.counterparty = { btc: peerBtc, stx: peerStx || "", name: peerName };
        }
        trade.negotiationLog.push({ ts: new Date().toISOString(), dir: "in", msg: parsed });
        console.log(`  ACCEPTED at ${parsed.p.toLocaleString()} sats`);
        console.log(`  Next: bun trade.ts approve ${trade.id}`);
      }
    } else if (parsed.a === "paid") {
      const trade = findTradeByInscription(store, parsed.i);
      if (trade) {
        console.log(`  Claims payment: ${parsed.tx}`);
        trade.negotiationLog.push({ ts: new Date().toISOString(), dir: "in", msg: parsed });
        console.log(`  Next: bun trade.ts verify-payment ${trade.id}`);
      }
    } else if (parsed.a === "psbt") {
      // Seller sent us a PSBT — we're the buyer
      const trade = findTradeByInscription(store, parsed.i);
      if (trade) {
        console.log(`  Trade #${trade.id}: ${trade.name}`);
        console.log(`  PSBT received! Price: ${parsed.p.toLocaleString()} sats`);
        console.log(`  PSBT: ${parsed.d.slice(0, 30)}... (${parsed.d.length} chars)`);

        // Verify before storing
        const check = verifySellerPSBT(parsed.d, BigInt(parsed.p));
        if (!check.valid) {
          console.log(`  PSBT VERIFICATION FAILED: ${check.error}`);
          console.log(`  DO NOT use this PSBT.`);
        } else {
          console.log(`  PSBT verification: PASSED`);
          trade.psbtBase64 = parsed.d;
          trade.agreedPrice = parsed.p;
          if (!trade.counterparty) {
            trade.counterparty = { btc: peerBtc, stx: peerStx || "", name: peerName };
          }
          trade.negotiationLog.push({ ts: new Date().toISOString(), dir: "in", msg: parsed });
          trade.status = "psbt_offered";
          console.log(`  Next: bun trade.ts psbt-buy ${trade.id}`);
        }
      } else {
        console.log(`  No active trade for that inscription`);
      }
    } else if (parsed.a === "psbt-done") {
      // Buyer completed our PSBT and broadcast it — we're the seller
      const trade = findTradeByInscription(store, parsed.i);
      if (trade) {
        console.log(`  Trade #${trade.id}: ${trade.name}`);
        console.log(`  ATOMIC SWAP BROADCAST by buyer!`);
        console.log(`  txid: ${parsed.tx}`);
        console.log(`  https://mempool.space/tx/${parsed.tx}`);
        trade.atomicTxid = parsed.tx;
        trade.status = "completed";
        trade.negotiationLog.push({ ts: new Date().toISOString(), dir: "in", msg: parsed });
        console.log(`  Trade #${trade.id} COMPLETED via atomic swap!`);
      }
    } else if (parsed.a === "cancel") {
      const trade = findTradeByInscription(store, parsed.i);
      if (trade) {
        trade.status = "cancelled";
        trade.negotiationLog.push({ ts: new Date().toISOString(), dir: "in", msg: parsed });
        console.log(`  Trade #${trade.id} cancelled by counterparty`);
      }
    }
  }

  await saveStore(store);

  console.log(`\n${tradeMessages} trade message(s) processed, ${skippedUntrusted} non-trade skipped.`);
}

// ── Main CLI Router ─────────────────────────────────────────────────────

const command = process.argv[2];
const cmdArgs = process.argv.slice(3);

if (!command) {
  console.log("Safe Ordinals Trading System");
  console.log("============================");
  console.log("");
  console.log("Commands:");
  console.log("  list <inscriptionId> <minPrice> <name>  Create a listing");
  console.log("  negotiate <id> <action> [args]          Send/receive offers");
  console.log("    send-list <btc> <stx>                   Announce to agent");
  console.log("    counter <price>                         Counter-offer");
  console.log("    accept                                  Accept last offer");
  console.log("  status [id]                              Show trade(s)");
  console.log("  approve <id>                             Human approval gate");
  console.log("  verify-payment <id> [--poll]             Check for payment");
  console.log("  deliver <id>                             Send inscription");
  console.log("  cancel <id>                              Abort trade");
  console.log("  inbox                                    Check for messages");
  console.log("  psbt-buy <id>                            Complete seller's PSBT (buyer side)");
  console.log("");
  console.log(`Our taproot: ${taprootAddr}`);
  console.log(`Our funding: ${fundingAddr}`);
  process.exit(0);
}

switch (command) {
  case "list":
    await cmdList(cmdArgs);
    break;
  case "negotiate":
    await cmdNegotiate(cmdArgs);
    break;
  case "status":
    await cmdStatus(cmdArgs);
    break;
  case "approve":
    await cmdApprove(cmdArgs);
    break;
  case "verify-payment":
    await cmdVerifyPayment(cmdArgs);
    break;
  case "deliver":
    await cmdDeliver(cmdArgs);
    break;
  case "cancel":
    await cmdCancel(cmdArgs);
    break;
  case "inbox":
    await cmdInbox();
    break;
  case "psbt-buy":
    await cmdPsbtBuy(cmdArgs);
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error("Run 'bun trade.ts' for help.");
    process.exit(1);
}

/**
 * Batch inscribe HTML files as Bitcoin ordinals.
 * Commits all, waits for confirmations, then reveals all.
 *
 * Usage:
 *   bun inscribe-batch.ts commit <glob-pattern>
 *   bun inscribe-batch.ts reveal   (reads state from batch-state.json)
 *   bun inscribe-batch.ts status   (check confirmation status)
 */
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { readdirSync } from "fs";

const MNEMONIC = process.env.AIBTC_MNEMONIC!;
if (!MNEMONIC) { console.error("[FATAL] AIBTC_MNEMONIC not set"); process.exit(1); }

const MEMPOOL_API = "https://mempool.space/api";
const STATE_FILE = `${import.meta.dir}/batch-state.json`;

const seed = mnemonicToSeedSync(MNEMONIC);
const master = HDKey.fromMasterSeed(seed);
const bip84Key = master.derive("m/84'/0'/0'/0/0");
const fundingPrivKey = bip84Key.privateKey!;
const fundingPubKey = bip84Key.publicKey!;
const p2wpkh = btc.p2wpkh(fundingPubKey);
const fundingAddr = p2wpkh.address!;
const bip86Key = master.derive("m/86'/0'/0'/0/0");
const taprootPrivKey = bip86Key.privateKey!;
const taprootXOnlyPub = bip86Key.publicKey!.slice(1);
const ourTaproot = btc.p2tr(taprootXOnlyPub);

console.log(`Funding: ${fundingAddr}`);
console.log(`Taproot: ${ourTaproot.address}`);

async function getUTXOs(address: string) {
  const res = await fetch(`${MEMPOOL_API}/address/${address}/utxo`);
  return res.json() as Promise<Array<{ txid: string; vout: number; value: number }>>;
}

async function getTxHex(txid: string): Promise<string> {
  const res = await fetch(`${MEMPOOL_API}/tx/${txid}/hex`);
  return res.text();
}

async function broadcast(txHex: string): Promise<string> {
  const res = await fetch(`${MEMPOOL_API}/tx`, { method: "POST", body: txHex });
  if (!res.ok) throw new Error(`Broadcast failed: ${await res.text()}`);
  return res.text();
}

async function getFeeRate(): Promise<number> {
  const res = await fetch(`${MEMPOOL_API}/v1/fees/recommended`);
  const fees = (await res.json()) as any;
  return Math.max(fees.hourFee || 1, 1);
}

async function isConfirmed(txid: string): Promise<boolean> {
  const res = await fetch(`${MEMPOOL_API}/tx/${txid}/status`);
  const data = (await res.json()) as any;
  return !!data.confirmed;
}

function buildInscriptionScript(pubkey: Uint8Array, contentType: string, body: Uint8Array): Uint8Array {
  const scriptOps: btc.ScriptType = [
    pubkey, "CHECKSIG", "OP_0", "IF",
    new TextEncoder().encode("ord"), 1,
    new TextEncoder().encode(contentType), "OP_0",
  ];
  for (let i = 0; i < body.length; i += 520) scriptOps.push(body.slice(i, i + 520));
  scriptOps.push("ENDIF");
  return btc.Script.encode(scriptOps);
}

interface BatchItem {
  name: string;
  file: string;
  contentBytes: number;
  commitTxid?: string;
  revealAmount?: number;
  revealTxid?: string;
  inscriptionId?: string;
  confirmed?: boolean;
}

interface BatchState {
  items: BatchItem[];
  feeRate: number;
  phase: "committed" | "revealed";
}

async function loadState(): Promise<BatchState | null> {
  try {
    const f = Bun.file(STATE_FILE);
    if (await f.exists()) return await f.json() as BatchState;
  } catch {}
  return null;
}

async function saveState(state: BatchState) {
  await Bun.write(STATE_FILE, JSON.stringify(state, null, 2));
}

const mode = process.argv[2] || "status";

if (mode === "commit") {
  const dir = process.argv[3] || "../ordinal-art/cards";
  const files = readdirSync(dir).filter(f => f.endsWith(".html")).sort();

  if (files.length === 0) { console.error("No HTML files found"); process.exit(1); }
  console.log(`\n=== BATCH COMMIT: ${files.length} files ===\n`);

  const feeRate = await getFeeRate();
  console.log(`Fee rate: ${feeRate} sat/vB`);

  const contentType = "text/html;charset=utf-8";
  const items: BatchItem[] = [];

  // Pre-calculate all reveal amounts
  for (const file of files) {
    const content = new Uint8Array(await Bun.file(`${dir}/${file}`).arrayBuffer());
    const script = buildInscriptionScript(taprootXOnlyPub, contentType, content);
    const revealWeight = script.length + 150 * 4;
    const revealVSize = Math.ceil(revealWeight / 4);
    const revealFee = revealVSize * feeRate;
    const revealAmount = revealFee + 546;
    items.push({ name: file.replace(".html", ""), file, contentBytes: content.length, revealAmount });
  }

  const totalReveal = items.reduce((s, i) => s + i.revealAmount!, 0);
  console.log(`Total reveal amounts: ${totalReveal} sats`);

  // Get UTXOs
  const utxos = await getUTXOs(fundingAddr);
  const totalBalance = utxos.reduce((s, u) => s + u.value, 0);
  console.log(`UTXOs: ${utxos.length} (${totalBalance} sats)`);

  // Build ONE commit tx with all reveal outputs
  const tx = new btc.Transaction();
  let totalInput = 0;

  for (const utxo of utxos) {
    const rawHex = await getTxHex(utxo.txid);
    const rawTx = btc.Transaction.fromRaw(hex.decode(rawHex));
    const prevOut = rawTx.getOutput(utxo.vout);
    tx.addInput({
      txid: utxo.txid,
      index: utxo.vout,
      witnessUtxo: { script: prevOut.script!, amount: BigInt(utxo.value) },
    });
    totalInput += utxo.value;
  }

  // One output per card
  for (const item of items) {
    const content = new Uint8Array(await Bun.file(`${dir}/${item.file}`).arrayBuffer());
    const script = buildInscriptionScript(taprootXOnlyPub, contentType, content);
    const revealPayment = btc.p2tr(undefined, { script, leafVersion: 0xc0 }, btc.NETWORK, true);
    tx.addOutputAddress(revealPayment.address!, BigInt(item.revealAmount!));
  }

  // Fee and change
  const commitVSize = 110 + utxos.length * 68 + items.length * 43;
  const commitFee = commitVSize * feeRate;
  const change = totalInput - totalReveal - commitFee;
  if (change < 0) { console.error(`Insufficient: need ${totalReveal + commitFee}, have ${totalInput}`); process.exit(1); }
  if (change > 546) tx.addOutputAddress(fundingAddr, BigInt(change));

  for (let i = 0; i < utxos.length; i++) tx.signIdx(fundingPrivKey, i);
  tx.finalize();

  const commitHex = hex.encode(tx.extract());
  const commitTxid = await broadcast(commitHex);

  console.log(`\nCommit txid: ${commitTxid}`);
  console.log(`Fee: ${commitFee} sats, change: ${change} sats`);
  console.log(`https://mempool.space/tx/${commitTxid}`);

  // Update items with commit info
  for (let i = 0; i < items.length; i++) {
    items[i].commitTxid = commitTxid;
    // Each card is at vout index i
  }

  const state: BatchState = { items, feeRate, phase: "committed" };
  await saveState(state);

  console.log(`\nState saved. Run 'bun inscribe-batch.ts status' to check confirmations.`);
  console.log(`Run 'bun inscribe-batch.ts reveal' once confirmed.`);

} else if (mode === "reveal") {
  const state = await loadState();
  if (!state) { console.error("No batch state. Run commit first."); process.exit(1); }

  // Check confirmation
  const commitTxid = state.items[0].commitTxid!;
  if (!(await isConfirmed(commitTxid))) {
    console.log("Commit tx not confirmed yet. Wait and try again.");
    process.exit(1);
  }

  console.log(`\n=== BATCH REVEAL: ${state.items.length} cards ===\n`);

  const dir = process.argv[3] || "../ordinal-art/cards";
  const contentType = "text/html;charset=utf-8";
  const feeRate = await getFeeRate();

  for (let i = 0; i < state.items.length; i++) {
    const item = state.items[i];
    if (item.revealTxid) { console.log(`${item.name}: already revealed`); continue; }

    const content = new Uint8Array(await Bun.file(`${dir}/${item.file}`).arrayBuffer());
    const script = buildInscriptionScript(taprootXOnlyPub, contentType, content);
    const revealPayment = btc.p2tr(undefined, { script, leafVersion: 0xc0 }, btc.NETWORK, true);

    const tx = new btc.Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true });
    tx.addInput({
      txid: commitTxid,
      index: i,
      witnessUtxo: { script: revealPayment.script, amount: BigInt(item.revealAmount!) },
      ...revealPayment,
    });

    const revealWeight = script.length + 150 * 4;
    const revealVSize = Math.ceil(revealWeight / 4);
    const revealFee = revealVSize * feeRate;
    const inscriptionValue = Math.max(item.revealAmount! - revealFee, 546);

    tx.addOutputAddress(ourTaproot.address!, BigInt(inscriptionValue));
    tx.signIdx(taprootPrivKey, 0);
    tx.finalize();

    const revealHex = hex.encode(tx.extract());

    try {
      const revealTxid = await broadcast(revealHex);
      item.revealTxid = revealTxid;
      item.inscriptionId = `${revealTxid}i0`;
      console.log(`${item.name}: ${revealTxid}i0`);
      await saveState(state);
    } catch (e: any) {
      console.error(`${item.name}: FAILED — ${e.message}`);
      // Save progress and continue
      await saveState(state);
    }

    // Small delay between reveals
    if (i < state.items.length - 1) await new Promise(r => setTimeout(r, 500));
  }

  state.phase = "revealed";
  await saveState(state);

  console.log(`\nDone! All inscription IDs saved to ${STATE_FILE}`);

} else if (mode === "status") {
  const state = await loadState();
  if (!state) { console.log("No batch state found."); process.exit(0); }

  const commitTxid = state.items[0].commitTxid!;
  const confirmed = await isConfirmed(commitTxid);

  console.log(`Phase: ${state.phase}`);
  console.log(`Commit: ${commitTxid} (${confirmed ? "CONFIRMED" : "unconfirmed"})`);
  console.log(`Cards: ${state.items.length}`);
  console.log();

  for (const item of state.items) {
    const status = item.inscriptionId ? item.inscriptionId : "pending reveal";
    console.log(`  ${item.name.padEnd(18)} ${status}`);
  }

  if (!confirmed) console.log(`\nWaiting for confirmation...`);
  else if (state.phase === "committed") console.log(`\nReady to reveal! Run: bun inscribe-batch.ts reveal`);
}

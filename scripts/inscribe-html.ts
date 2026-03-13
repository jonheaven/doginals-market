/**
 * Inscribe HTML art as a Bitcoin ordinal.
 * Usage:
 *   bun inscribe-html.ts commit <path-to-html>
 *   bun inscribe-html.ts reveal <commitTxid> <revealAmount>
 */
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";

const MNEMONIC = process.env.AIBTC_MNEMONIC!;
if (!MNEMONIC) {
  console.error("[FATAL] AIBTC_MNEMONIC not set");
  process.exit(1);
}

// const MEMPOOL_API = "https://mempool.space/api"; // Removed all Bitcoin/Stacks/Unisat/mempool.space/Hiro fallbacks

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

console.log(`Funding: ${fundingAddr}`);
console.log(`Taproot: ${btc.p2tr(taprootXOnlyPub).address}`);

// async function getUTXOs(address: string) {
//   // Use kabosu indexer only
// }

// async function getTxHex(txid: string): Promise<string> {
//   // Use kabosu indexer only
// }

// async function broadcast(txHex: string): Promise<string> {
//   // Use kabosu indexer only
// }

// async function getFeeRate(): Promise<number> {
//   // Use kabosu indexer only
// }

function buildInscriptionScript(
  pubkey: Uint8Array,
  contentType: string,
  body: Uint8Array
): Uint8Array {
  const scriptOps: btc.ScriptType = [
    pubkey,
    "CHECKSIG",
    "OP_0",
    "IF",
    new TextEncoder().encode("ord"),
    1,
    new TextEncoder().encode(contentType),
    "OP_0",
  ];
  const CHUNK_SIZE = 520;
  for (let i = 0; i < body.length; i += CHUNK_SIZE) {
    scriptOps.push(body.slice(i, i + CHUNK_SIZE));
  }
  scriptOps.push("ENDIF");
  return btc.Script.encode(scriptOps);
}

// Load HTML content
const htmlPath = process.argv[3] === "reveal" ? "" : (process.argv[3] || "../ordinal-art/agent-network.html");
const mode = process.argv[2] || "commit";

let contentBytes: Uint8Array;
const contentType = "text/html;charset=utf-8";

if (mode === "commit") {
  const file = Bun.file(htmlPath);
  if (!(await file.exists())) {
    console.error(`File not found: ${htmlPath}`);
    process.exit(1);
  }
  contentBytes = new Uint8Array(await file.arrayBuffer());
  console.log(`Content: ${htmlPath} (${contentBytes.length} bytes, ${contentType})`);
} else {
  // For reveal, we still need the content to rebuild the inscription script
  const defaultPath = "../ordinal-art/agent-network.html";
  const file = Bun.file(defaultPath);
  contentBytes = new Uint8Array(await file.arrayBuffer());
}

const inscriptionScript = buildInscriptionScript(taprootXOnlyPub, contentType, contentBytes);
console.log(`Script: ${inscriptionScript.length} bytes`);

const revealPayment = btc.p2tr(
  undefined,
  { script: inscriptionScript, leafVersion: 0xc0 },
  btc.NETWORK,
  true
);
console.log(`Reveal address: ${revealPayment.address}`);

if (mode === "commit") {
  console.log("\n=== COMMIT ===");
  const feeRate = await getFeeRate();
  console.log(`Fee rate: ${feeRate} sat/vB`);

  const revealWeight = inscriptionScript.length + 150 * 4;
  const revealVSize = Math.ceil(revealWeight / 4);
  const revealFee = revealVSize * feeRate;
  const dust = 546;
  const revealAmount = revealFee + dust;
  console.log(`Reveal amount needed: ${revealAmount} sats`);

  const utxos = await getUTXOs(fundingAddr);
  if (utxos.length === 0) { console.error("No UTXOs!"); process.exit(1); }
  console.log(`UTXOs: ${utxos.length} (${utxos.reduce((s, u) => s + u.value, 0)} sats)`);

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

  tx.addOutputAddress(revealPayment.address!, BigInt(revealAmount));

  const commitVSize = 110 + utxos.length * 68;
  const commitFee = commitVSize * feeRate;
  const change = totalInput - revealAmount - commitFee;
  if (change < 0) { console.error(`Insufficient funds: need ${revealAmount + commitFee}, have ${totalInput}`); process.exit(1); }
  if (change > 546) tx.addOutputAddress(fundingAddr, BigInt(change));

  for (let i = 0; i < utxos.length; i++) tx.signIdx(fundingPrivKey, i);
  tx.finalize();

  const commitHex = hex.encode(tx.extract());
  console.log(`Commit: ${commitHex.length / 2} bytes, fee: ${commitFee} sats, change: ${change} sats`);

  console.log("\nBroadcasting...");
  const commitTxid = await broadcast(commitHex);
  console.log(`\nCommit txid: ${commitTxid}`);
  console.log(`https://mempool.space/tx/${commitTxid}`);
  console.log(`\nNext: bun inscribe-html.ts reveal ${commitTxid} ${revealAmount}`);

} else if (mode === "reveal") {
  const commitTxid = process.argv[3];
  const revealAmount = parseInt(process.argv[4]);
  if (!commitTxid || !revealAmount) {
    console.error("Usage: bun inscribe-html.ts reveal <commitTxid> <revealAmount>");
    process.exit(1);
  }

  console.log("\n=== REVEAL ===");
  const feeRate = await getFeeRate();

  const tx = new btc.Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true });
  tx.addInput({
    txid: commitTxid,
    index: 0,
    witnessUtxo: { script: revealPayment.script, amount: BigInt(revealAmount) },
    ...revealPayment,
  });

  const ourTaproot = btc.p2tr(taprootXOnlyPub);
  const revealWeight = inscriptionScript.length + 150 * 4;
  const revealVSize = Math.ceil(revealWeight / 4);
  const revealFee = revealVSize * feeRate;
  const inscriptionValue = Math.max(revealAmount - revealFee, 546);

  tx.addOutputAddress(ourTaproot.address!, BigInt(inscriptionValue));

  tx.signIdx(taprootPrivKey, 0);
  tx.finalize();

  const revealHex = hex.encode(tx.extract());
  console.log(`Reveal: ${revealHex.length / 2} bytes, fee: ${revealFee} sats`);

  console.log("\nBroadcasting...");
  const revealTxid = await broadcast(revealHex);
  console.log(`\nInscription ID: ${revealTxid}i0`);
  console.log(`https://mempool.space/tx/${revealTxid}`);
  console.log(`https://ordinals.com/inscription/${revealTxid}i0`);
}

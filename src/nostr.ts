// Nostr NIP-78 listing publisher for Doginals Market
// Publishes listings to configured relays for censorship resistance
// Usage: import and call publishNostrListing(listing)


import config from "../marketplace.config";
import { signDMPIntent } from "@jonheaven/dogestash";

export interface NostrRelay {
  url: string;
  ws?: WebSocket;
}

export interface ListingEvent {
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
  id?: string;
  sig?: string;
}

function getRelays(): NostrRelay[] {
  if (!config.nostr.enabled) return [];
  return config.nostr.relays.map((url: string) => ({ url }));
}

export async function publishNostrListing(listing: any, pubkey?: string) {
  const relays = getRelays();
  if (!relays.length) return;
  // Use configured pubkey or passed pubkey
  const nostrPubkey = pubkey || config.nostr.pubkey || "";
  const event: ListingEvent = {
    kind: config.nostr.kind || 78,
    pubkey: nostrPubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["app", "doginals-market"],
      ["inscription", listing.inscriptionId],
      ["price", String(listing.price_koinu)],
      ["network", "dogecoin"]
    ],
    content: JSON.stringify(listing)
  };
  // Auto-sign event with dogestash if available
  try {
    const signed = await signDMPIntent("nostr", { event });
    if (signed && signed.sig) {
      event.sig = signed.sig;
      event.pubkey = signed.pubkey || event.pubkey;
    }
  } catch (err) {
    // Fallback: unsigned event
  }
  for (const relay of relays) {
    try {
      const ws = new WebSocket(relay.url);
      ws.onopen = () => {
        ws.send(JSON.stringify(["EVENT", event]));
        ws.close();
      };
    } catch (err) {
      console.warn(`[NOSTR] Failed to publish to relay ${relay.url}:`, err);
    }
  }
}

// Nostr NIP-78 listing publisher for Doginals Market
// Publishes listings to configured relays for censorship resistance
// Usage: import and call publishNostrListing(listing)

import config from "../marketplace.config";

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
  const event: ListingEvent = {
    kind: config.nostr.kind || 78,
    pubkey: pubkey || config.nostr.pubkey || "",
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["app", "doginals-market"],
      ["inscription", listing.inscriptionId],
      ["price", String(listing.price_koinu)],
      ["network", "dogecoin"]
    ],
    content: JSON.stringify(listing)
  };
  // TODO: sign event if pubkey/private key available
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

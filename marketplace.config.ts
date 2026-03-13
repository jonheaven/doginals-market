// Lava-style white-label config for Doginals Market
// Edit this file to customize branding, fees, and Nostr relays

export default {
  branding: {
    name: "Doginals Market",
    logoUrl: "/logo.png",
    theme: "crt", // Options: 'crt', 'dark', 'light'
    description: "Best of aibtcdev/ordinals-market + lava-marketplace, adapted for Dogecoin Doginals by Jon Heaven."
  },
  fees: {
    marketplaceFeeBps: 50, // 0.5% fee
    payoutAddress: "D7Y55Qw1k1Qw1k1Qw1k1Qw1k1Qw1k1Qw1k" // Change to your payout address
  },
  nostr: {
    enabled: true,
    relays: [
      "wss://nostr-pub.wellorder.net",
      "wss://relay.damus.io",
      "wss://nostr.oxtr.dev"
    ],
    // Nostr pubkey for event signing. Set via env NOSTR_PUBKEY or here.
    pubkey: process.env.NOSTR_PUBKEY || "", 
    kind: 78 // NIP-78 for listing events
  }
};

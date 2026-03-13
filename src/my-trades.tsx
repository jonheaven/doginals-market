import React, { useEffect, useState } from "react";

const KABOSU_API = process.env.VITE_WALLET_DATA_API_BASE_URL || "https://api.kabosu.dog";

interface Trade {
  id: number;
  inscriptionId: string;
  name: string;
  minPrice: number;
  status: string;
  paymentAddress: string | null;
  deliveryTxid: string | null;
}

async function fetchTrades(): Promise<Trade[]> {
  // In real app, fetch from backend or local storage
  const res = await fetch("/trades.json");
  if (!res.ok) return [];
  const sealed = await res.json();
  return sealed.data.trades || [];
}

async function fetchKabosu(inscriptionId: string) {
  const res = await fetch(`${KABOSU_API}/doginals/v1/inscriptions/${inscriptionId}`);
  if (!res.ok) return null;
  return await res.json();
}

export default function MyTradesPage() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [kabosuData, setKabosuData] = useState<Record<string, any>>({});

  useEffect(() => {
    fetchTrades().then(setTrades);
  }, []);

  useEffect(() => {
    trades.forEach(async (t) => {
      if (!kabosuData[t.inscriptionId]) {
        const data = await fetchKabosu(t.inscriptionId);
        setKabosuData((prev) => ({ ...prev, [t.inscriptionId]: data }));
      }
    });
  }, [trades]);

  return (
    <div style={{ padding: "2rem", background: "#181818", color: "#fff" }}>
      <h2>My Trades</h2>
      {trades.length === 0 ? (
        <p>No trades found.</p>
      ) : (
        trades.map((t) => (
          <div key={t.id} style={{ marginBottom: "1.5rem", border: "1px solid #333", borderRadius: "8px", padding: "1rem" }}>
            <strong>{t.name}</strong> <span style={{ color: "#facc15" }}>[{t.status}]</span>
            <div>Inscription: {t.inscriptionId}</div>
            {kabosuData[t.inscriptionId] && (
              <div>Owner: {kabosuData[t.inscriptionId].address} | Number: {kabosuData[t.inscriptionId].number}</div>
            )}
            {t.status === "completed" ? (
              <div>
                <div>Buyer: {t.paymentAddress}</div>
                <div>Delivery txid: {t.deliveryTxid}</div>
              </div>
            ) : t.status === "payment_detected" ? (
              <div>Awaiting payout settlement...</div>
            ) : (
              <div>Min price: {t.minPrice} koinu</div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

import React, { useEffect, useState } from "react";
// @ts-ignore

import "./my-trades.css";
import "./my-trades-spinner.css";

type Trade = {
  id: number;
  inscriptionId: string;
  name: string;
  minPrice: number;
  status: string;
  paymentAddress: string | null;
  deliveryTxid: string | null;
};

const KABOSU_API = (window as any).VITE_WALLET_DATA_API_BASE_URL || "https://api.kabosu.dog";

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

function MyTradesPage() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [kabosuData, setKabosuData] = useState<Record<string, any>>({});
  const [loadingId, setLoadingId] = useState<number | null>(null);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);

  useEffect(() => {
    fetchTrades().then(setTrades);
  }, []);

  useEffect(() => {
    (async () => {
      for (const t of trades) {
        if (!kabosuData[t.inscriptionId]) {
          const data = await fetchKabosu(t.inscriptionId);
          setKabosuData((prev: Record<string, any>) => ({ ...prev, [t.inscriptionId]: data }));
        }
      }
    })();
  }, [trades]);

  return (
    <div className="mytrades-container">
      <h2 className="mytrades-title">My Trades</h2>
      {toast && (
        <div className={`mytrades-toast ${toast.type === "success" ? "mytrades-toast-success" : "mytrades-toast-error"}`}>{toast.message}</div>
      )}
      {trades.length === 0 ? (
        <p>No trades found.</p>
      ) : (
        trades.map((t) => (
          <div key={t.id} className="mytrades-card">
            <strong className="mytrades-name">{t.name}</strong> <span className="mytrades-status">[{t.status}]</span>
            <div className="mytrades-inscription">Inscription: {t.inscriptionId}</div>
            {kabosuData[t.inscriptionId] && (
              <div className="mytrades-owner">Owner: {kabosuData[t.inscriptionId].address} | Number: {kabosuData[t.inscriptionId].number}</div>
            )}
            {t.status === "completed" ? (
              <div className="mytrades-completed">
                <div>Buyer: {t.paymentAddress}</div>
                <div>Delivery txid: <span className="mytrades-txid">{t.deliveryTxid}</span></div>
              </div>
            ) : (
              <div className="mytrades-minprice">Min price: {t.minPrice} koinu</div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

export default MyTradesPage;

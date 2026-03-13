import React, { useEffect, useMemo, useState } from "react";
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
  const [loadingId] = useState<number | null>(null);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [persona, setPersona] = useState<"collector" | "creator">("collector");

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

  const completedTrades = useMemo(() => trades.filter((trade) => trade.status === "completed").length, [trades]);

  return (
    <div className="mytrades-shell">
      <div className="mytrades-noise" />
      <header className="mytrades-navbar glass-panel">
        <div className="mytrades-brand">
          <span className="mytrades-brand-mark">D</span>
          <div>
            <p className="mytrades-brand-title">Doginals Market</p>
            <p className="mytrades-brand-subtitle">Trustless swaps + launchpad</p>
          </div>
        </div>
        <nav className="mytrades-navlinks">
          <a href="#" className="mytrades-navlink">Marketplace</a>
          <a href="#" className="mytrades-navlink">Batch Send</a>
          <a href="#" className="mytrades-navlink mytrades-navlink-active">My Trades</a>
        </nav>
      </header>

      <main className="mytrades-container">
        <section className="mytrades-hero glass-panel">
          <div>
            <p className="mytrades-kicker">Doginals • cyber dark mode</p>
            <h1 className="mytrades-title">My Trades</h1>
            <p className="mytrades-description">High-contrast, trustless swap activity synced with Kabosu indexer and Dogestash DMP intent signatures.</p>
          </div>
          <div className="mytrades-toggle">
            <button className={`mytrades-toggle-pill ${persona === "collector" ? "is-active" : ""}`} onClick={() => setPersona("collector")}>Collector</button>
            <button className={`mytrades-toggle-pill ${persona === "creator" ? "is-active" : ""}`} onClick={() => setPersona("creator")}>Creator</button>
          </div>
        </section>

        <section className="mytrades-toolbar">
          <article className="glass-panel mytrades-stat-card">
            <p className="mytrades-stat-label">Total trades</p>
            <p className="mytrades-stat-value">{trades.length}</p>
          </article>
          <article className="glass-panel mytrades-stat-card">
            <p className="mytrades-stat-label">Completed swaps</p>
            <p className="mytrades-stat-value">{completedTrades}</p>
          </article>
          <article className="glass-panel mytrades-batch-card">
            <p className="mytrades-stat-label">Batch Send Tool</p>
            <div className="mytrades-batch-row">
              <input className="mytrades-input" placeholder="Recipient address" />
              <input className="mytrades-input" placeholder="Inscription id" />
              <button className="mytrades-button">Queue Send</button>
            </div>
          </article>
        </section>

        {toast && (
          <div className={`mytrades-toast ${toast.type === "success" ? "mytrades-toast-success" : "mytrades-toast-error"}`}>{toast.message}</div>
        )}

        {trades.length === 0 ? (
          <div className="glass-panel mytrades-empty">No trades found.</div>
        ) : (
          <section className="mytrades-grid">
            {trades.map((t) => (
              <article key={t.id} className="mytrades-card glass-panel">
                <div className="mytrades-card-head">
                  <strong className="mytrades-name">{t.name}</strong>
                  <span className="mytrades-status">{t.status}</span>
                </div>
                <div className="mytrades-inscription">Inscription: {t.inscriptionId}</div>
                {kabosuData[t.inscriptionId] && (
                  <div className="mytrades-owner">Owner: {kabosuData[t.inscriptionId].address} · #{kabosuData[t.inscriptionId].number}</div>
                )}
                {t.status === "completed" ? (
                  <div className="mytrades-completed">
                    <div>Buyer: {t.paymentAddress}</div>
                    <div>Delivery txid: <span className="mytrades-txid">{t.deliveryTxid}</span></div>
                  </div>
                ) : (
                  <div className="mytrades-minprice">Min price: {t.minPrice} koinu</div>
                )}
                {loadingId === t.id && (
                  <div className="mytrades-spinner-container">
                    <span className="mytrades-spinner" /> Settling swap...
                  </div>
                )}
              </article>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}

export default MyTradesPage;

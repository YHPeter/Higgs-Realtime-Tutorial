import { useState } from "react";

interface TokenResponse {
  value: string;
  expires_at: number;
}

/**
 * Part 0's whole app: prove the token path works before writing a line of
 * WebSocket code. If this button cannot produce a `bai-eph-…` value, nothing
 * later in the tutorial can work.
 */
export default function App() {
  const [token, setToken] = useState<TokenResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function mint() {
    setBusy(true);
    setError(null);
    setToken(null);
    try {
      const res = await fetch("/api/token");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setToken(body as TokenResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app">
      <h1>Higgs Realtime Tutorial</h1>
      <p className="lede">
        Part 0 — the token endpoint. Your real API key lives on the server; the
        browser only ever sees a short-lived ephemeral key.
      </p>

      <button onClick={mint} disabled={busy}>
        {busy ? "Minting…" : "Mint ephemeral key"}
      </button>

      {error && <p className="error">{error}</p>}

      {token && (
        <dl className="result">
          <dt>value</dt>
          {/* Show only the prefix. Even an ephemeral key is a credential. */}
          <dd>
            <code>{token.value.slice(0, 12)}…</code> ({token.value.length} chars)
          </dd>
          <dt>expires_at</dt>
          <dd>
            <code>{token.expires_at}</code> —{" "}
            {new Date(token.expires_at * 1000).toLocaleTimeString()}
          </dd>
        </dl>
      )}
    </main>
  );
}

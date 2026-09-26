"use client";

import { useEffect, useState } from "react";

export type TradingScope = {
  stock_symbols: string[];
  option_underlyings: string[];
  stock_symbol: string;
  stock_enabled: boolean;
  options_enabled: boolean;
  crypto_symbols: string[];
  crypto_symbol: string;
  crypto_enabled: boolean;
};

type Asset = { symbol: string; name: string };

type ScopeMode = "equities" | "crypto";

export default function ScopeEditor({
  saved,
  running,
  feedBase,
  onSaved,
  mode,
}: {
  saved: TradingScope;
  running: boolean;
  feedBase: string;
  onSaved: (scope: TradingScope) => void;
  mode: ScopeMode;
}) {
  const [draft, setDraft] = useState<TradingScope | null>(null);
  const [target, setTarget] = useState<"option_underlyings" | "stock_symbols">(
    "option_underlyings",
  );
  const searchTarget = mode === "crypto" ? "crypto_symbols" : target;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Asset[]>([]);
  const [searchState, setSearchState] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    error: boolean;
    text: string;
  } | null>(null);
  const scope = draft ?? saved;

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      if (!query.trim()) return;
      try {
        const assetClass =
          searchTarget === "crypto_symbols" ? "crypto" : "us_equity";
        const response = await fetch(
          `${feedBase}/assets?asset_class=${assetClass}&query=${encodeURIComponent(query.trim())}`,
          { signal: controller.signal },
        );
        const result = await response.json();
        if (!response.ok || !result.ok)
          throw new Error(result.error || "Ticker search failed");
        if (controller.signal.aborted) return;
        setResults(result.assets);
        setSearchState(
          result.assets.length
            ? ""
            : assetClass === "crypto"
              ? "No matching tradable crypto pairs."
              : "No matching tradable stocks or ETFs.",
        );
      } catch (error) {
        if (!controller.signal.aborted)
          setSearchState(
            error instanceof Error
              ? error.message
              : "Ticker search unavailable",
          );
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, feedBase, searchTarget]);

  const change = (patch: Partial<TradingScope>) => {
    setDraft({ ...scope, ...patch });
    setFeedback(null);
  };
  const remove = (
    field: "option_underlyings" | "stock_symbols" | "crypto_symbols",
    symbol: string,
  ) => {
    const remaining = scope[field].filter((item) => item !== symbol);
    if (field === "stock_symbols") {
      change({
        stock_symbols: remaining,
        stock_symbol:
          scope.stock_symbol === symbol
            ? (remaining[0] ?? "")
            : scope.stock_symbol,
        stock_enabled: remaining.length > 0 && scope.stock_enabled,
      });
    } else if (field === "crypto_symbols") {
      change({
        crypto_symbols: remaining,
        crypto_symbol:
          scope.crypto_symbol === symbol
            ? (remaining[0] ?? "")
            : scope.crypto_symbol,
        crypto_enabled: remaining.length > 0 && scope.crypto_enabled,
      });
    } else {
      change({
        option_underlyings: remaining,
        options_enabled: remaining.length > 0 && scope.options_enabled,
      });
    }
  };
  const save = async () => {
    if (!draft || saving) return;
    if (
      scope.stock_enabled &&
      (!scope.stock_symbol || !scope.stock_symbols.includes(scope.stock_symbol))
    ) {
      setFeedback({
        error: true,
        text: "Choose a stock strategy symbol or turn stock automation off.",
      });
      return;
    }
    if (scope.options_enabled && !scope.option_underlyings.length) {
      setFeedback({
        error: true,
        text: "Add an options underlying or turn options automation off.",
      });
      return;
    }
    if (
      scope.crypto_enabled &&
      (!scope.crypto_symbol ||
        !scope.crypto_symbols.includes(scope.crypto_symbol))
    ) {
      setFeedback({
        error: true,
        text: "Choose a crypto strategy pair or turn crypto automation off.",
      });
      return;
    }
    if (
      !window.confirm(
        `Save Alpaca PAPER trading scope? This applies account-wide, across both the equities/options and crypto views.\n\nOptions watchlist: ${scope.option_underlyings.join(", ") || "empty"}\nOptions automation: ${scope.options_enabled ? "on" : "off"}\nStock watchlist: ${scope.stock_symbols.join(", ") || "empty"}\nStock automation: ${scope.stock_enabled ? "on — " + scope.stock_symbol : "off"}\nCrypto watchlist: ${scope.crypto_symbols.join(", ") || "empty"}\nCrypto automation: ${scope.crypto_enabled ? "on — " + scope.crypto_symbol : "off"}\n\nMaster automation stays ${running ? "ON; new decisions can use this scope immediately" : "PAUSED"}. Removing tickers blocks new entries; it does not cancel existing orders or close positions. Protective exits continue. Saved scope survives restart; master automation restarts paused.`,
      )
    )
      return;
    setSaving(true);
    setFeedback(null);
    try {
      const response = await fetch(`${feedBase}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trading_scope: scope }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok)
        throw new Error(result.error || "Could not save trading scope");
      onSaved(result.trading_scope);
      setDraft(null);
      setFeedback({
        error: false,
        text: "Trading scope saved. Existing positions and protective exits are unchanged.",
      });
    } catch (error) {
      setFeedback({
        error: true,
        text:
          error instanceof Error
            ? error.message
            : "Could not save trading scope",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className="settings-card scope-editor"
      aria-labelledby="scope-title"
    >
      <div className="panel-head">
        <div>
          <h2 id="scope-title">
            {mode === "crypto"
              ? "Crypto trading scope"
              : "Equities & options trading scope"}
          </h2>
          <p className="muted">
            Choose what Jev can trade. Applies account-wide; viewing a chart
            never changes this scope.
          </p>
        </div>
        <span className={draft ? "draft-status" : "muted"}>
          {draft ? "Unsaved changes" : "Saved on server"}
        </span>
      </div>
      <fieldset disabled={saving}>
        <legend className="sr-only">Trading watchlists and strategies</legend>
        {mode === "equities" ? (
          <div className="scope-columns">
            <div>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={scope.options_enabled}
                  onChange={(event) =>
                    change({ options_enabled: event.target.checked })
                  }
                />
                Options automation
              </label>
              <p className="muted">
                Scans calls and puts across these underlying tickers.
              </p>
              <div className="ticker-chips" aria-label="Options watchlist">
                {scope.option_underlyings.map((symbol) => (
                  <button
                    type="button"
                    key={symbol}
                    onClick={() => remove("option_underlyings", symbol)}
                    aria-label={`Remove ${symbol} from options watchlist`}
                  >
                    {symbol}
                    <span aria-hidden="true">×</span>
                  </button>
                ))}
                {!scope.option_underlyings.length && (
                  <span className="muted">
                    No options underlyings selected.
                  </span>
                )}
              </div>
            </div>
            <div>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={scope.stock_enabled}
                  onChange={(event) =>
                    change({ stock_enabled: event.target.checked })
                  }
                />
                Stock automation
              </label>
              <p className="muted">
                One active stock strategy; the watchlist also permits manual
                stock entries.
              </p>
              <div className="ticker-chips" aria-label="Stock watchlist">
                {scope.stock_symbols.map((symbol) => (
                  <button
                    type="button"
                    key={symbol}
                    onClick={() => remove("stock_symbols", symbol)}
                    aria-label={`Remove ${symbol} from stock watchlist`}
                  >
                    {symbol}
                    <span aria-hidden="true">×</span>
                  </button>
                ))}
                {!scope.stock_symbols.length && (
                  <span className="muted">No stock entries configured.</span>
                )}
              </div>
              <label className="field">
                Stock strategy symbol
                <select
                  value={scope.stock_symbol}
                  onChange={(event) =>
                    change({ stock_symbol: event.target.value })
                  }
                >
                  <option value="">Select a ticker</option>
                  {scope.stock_symbols.map((symbol) => (
                    <option key={symbol}>{symbol}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        ) : (
          <div>
            <label className="toggle-label">
              <input
                type="checkbox"
                checked={scope.crypto_enabled}
                onChange={(event) =>
                  change({ crypto_enabled: event.target.checked })
                }
              />
              Crypto automation
            </label>
            <p className="muted">
              Trades a single crypto pair 24/7, no margin or short selling; the
              watchlist also permits manual crypto entries.
            </p>
            <div className="ticker-chips" aria-label="Crypto watchlist">
              {scope.crypto_symbols.map((symbol) => (
                <button
                  type="button"
                  key={symbol}
                  onClick={() => remove("crypto_symbols", symbol)}
                  aria-label={`Remove ${symbol} from crypto watchlist`}
                >
                  {symbol}
                  <span aria-hidden="true">×</span>
                </button>
              ))}
              {!scope.crypto_symbols.length && (
                <span className="muted">No crypto pairs selected.</span>
              )}
            </div>
            <label className="field">
              Crypto strategy pair
              <select
                value={scope.crypto_symbol}
                onChange={(event) =>
                  change({ crypto_symbol: event.target.value })
                }
              >
                <option value="">Select a pair</option>
                {scope.crypto_symbols.map((symbol) => (
                  <option key={symbol}>{symbol}</option>
                ))}
              </select>
            </label>
          </div>
        )}
        <div className="asset-search">
          {mode === "equities" && (
            <label className="field">
              Add to
              <select
                value={target}
                onChange={(event) =>
                  setTarget(event.target.value as typeof target)
                }
              >
                <option value="option_underlyings">Options watchlist</option>
                <option value="stock_symbols">Stock watchlist</option>
              </select>
            </label>
          )}
          <label className="field search-field">
            {mode === "crypto"
              ? "Search crypto pair"
              : "Search ticker or company"}
            <input
              type="search"
              value={query}
              maxLength={80}
              placeholder={
                mode === "crypto"
                  ? "Search BTC, ETH, SOL…"
                  : "Search SPY, Apple, Microsoft…"
              }
              onChange={(event) => {
                setQuery(event.target.value);
                setResults([]);
                setSearchState(
                  event.target.value.trim() ? "Searching broker assets…" : "",
                );
              }}
            />
          </label>
        </div>
        {query.trim() && (
          <div className="search-results" aria-label="Ticker search results">
            <output className="muted">{searchState}</output>
            {results.map((asset) => (
              <button
                type="button"
                key={asset.symbol}
                disabled={scope[searchTarget].includes(asset.symbol)}
                onClick={() =>
                  change({
                    [searchTarget]: [...scope[searchTarget], asset.symbol],
                    ...(searchTarget === "stock_symbols" && !scope.stock_symbol
                      ? { stock_symbol: asset.symbol }
                      : {}),
                    ...(searchTarget === "crypto_symbols" &&
                    !scope.crypto_symbol
                      ? { crypto_symbol: asset.symbol }
                      : {}),
                  })
                }
              >
                <strong>{asset.symbol}</strong>
                <span>{asset.name}</span>
                <span>
                  {scope[searchTarget].includes(asset.symbol) ? "Added" : "Add"}
                </span>
              </button>
            ))}
          </div>
        )}
        <p className="help-text">
          {mode === "crypto"
            ? "Search uses Alpaca’s tradable USD-quoted crypto pairs. Crypto trades 24/7 with no margin or short selling; Alpaca charges taker fees up to 0.25%."
            : "Search uses Alpaca’s active tradable stock/ETF directory. Options eligibility is checked during scanning. Turn stock automation off for options-only automation; empty the stock watchlist to also disallow new manual stock entries."}
        </p>
        <div className="form-actions">
          <button
            type="button"
            className="primary"
            disabled={!draft || saving}
            onClick={() => void save()}
          >
            {saving ? "Saving scope…" : "Save trading scope"}
          </button>
          <button
            type="button"
            disabled={!draft || saving}
            onClick={() => {
              setDraft(null);
              setFeedback(null);
            }}
          >
            Discard scope changes
          </button>
        </div>
      </fieldset>
      {feedback && (
        <p
          role={feedback.error ? "alert" : "status"}
          className={`feedback-banner ${feedback.error ? "error" : "success"}`}
        >
          {feedback.text}
        </p>
      )}
    </section>
  );
}

State = {
  "symbol": "BTC-USD",
  "current_price": "332.41",
  "oscillators": {
    "relative_strength_index_14": 62.64,
    "stochastic_percent_k_14_3_3": 81.43,
    "commodity_channel_index_20": 102.57,
    "average_directional_index_14": 19.27,
    "awesome_oscillator": 0.38,
    "momentum_10": 0.37,
    "macd_level_12_26": 0.16,
    "stochastic_rsi_fast_3_3_14_14": 66.05,
    "williams_percent_range_14": -11.11,
    "bull_bear_power": 0.34,
    "ultimate_oscillator_7_14_28": 53.28
  },
  "moving_averages": {
    "ema_10": 332.31,
    "sma_10": 332.34,
    "ema_20": 332.17,
    "sma_20": 332.09,
    "ema_30": 332.09,
    "sma_30": 332.09,
    "ema_50": 332.10,
    "sma_50": 331.70,
    "ema_100": 332.36,
    "sma_100": 332.56,
    "ema_200": 332.62,
    "sma_200": 332.86,
    "ichimoku_base_line_9_26_52_26": 332.05,
    "vwma_20": 332.27,
    "hull_ma_9": 332.40
  },
  "position" : "None",
  "qauntity" : 0,
  "time_frame" : "1 minute",
  "cash_balance" : "",
  "position_quantity" : "",
  "average_entry_price" : "",
  "unrealized_pnl_pct" : "",
  "position_age_bars" : "",
  "stop_loss_price": "",
  "take_profit_price": "",
  "stop_loss_pct": "",
  "take_profit_pct": "",
  "max_wallet_position_pct" : "75%",
  "price" : {
    "atr14" : "day high - day low",
    "change_percent" : "",
    "day_high" : "",
    "day_low" : "",
    "open_price" : "",
    "day_volume" : ""
  }
}


Questions = {
  "action_choice": {
    "type": "choice",
    "instructions": "Given `current_price`, `oscillators`, `moving_averages`, `change_percent`, `day_high`, `day_low`, the current `position`/`quantity`/`average_entry_price`, and `risk_appetite`, which action best matches the weight of evidence right now? Respect the supplied risk appetite: aggressive may act on a promising but incomplete setup, balanced requires broader agreement, and conservative requires strong confirmation.",
    "criteria": {
      "buy": "Momentum and trend indicators are broadly bullish-aligned, no oscillator shows extreme overbought exhaustion, and there is no open position or an existing long the evidence supports adding to.",
      "hold": "Signals are mixed, contradictory, or already reflected in the existing position.",
      "sell": "Oscillators show overbought exhaustion or moving averages are rolling over, and there is an open long position the evidence supports reducing or closing."
    }
  },
  "trend_alignment": {
    "type": "choice",
    "instructions": "Compare `current_price` against short (10-20), medium (30-50), and long (100-200) period moving averages. Classify the trend structure.",
    "criteria": {
      "strong_uptrend": "Price above all tiers, shorter averages stacked above longer ones.",
      "weak_or_transitional": "Averages clustered close together or crossing.",
      "downtrend": "Price below all tiers, shorter averages stacked below longer ones."
    }
  },
  "overbought_condition": {
    "type": "noul",
    "instructions": "Do RSI, Stochastic %K, Stochastic RSI Fast, and Williams %R collectively indicate the instrument is overbought and due for a pause, given `current_price` is also near `day_high`?"
  },
  "volatility_regime": {
    "type": "score",
    "instructions": "Using the spread between `day_high` and `day_low` relative to `current_price`, and how tightly the moving averages are clustered, how volatile is the current environment?",
    "criteria": [
      "Calm: tight day range, moving averages closely bunched.",
      "Normal: moderate day range, some separation between MA tiers.",
      "Volatile: wide day range, MA tiers widely separated or whipsawing."
    ]
  },
  "signal_confluence": {
    "type": "score",
    "instructions": "How much agreement is there between `oscillators` and `moving_averages`?",
    "criteria": [
      "Conflicting: they point in clearly opposite directions.",
      "Partial: most agree, a subset disagrees.",
      "Strong: near-total alignment."
    ]
  },
  "buying_quantity": {
    "type": "score",
    "instructions": "Assuming the evidence favored a Buy, and factoring in `risk_appetite`, the current volatility regime, and `max_wallet_position_pct`, how large should the position be relative to a full-size position? Aggressive can choose a larger size when evidence is promising; conservative should prefer a probe unless alignment is strong.",
    "criteria": [
      "Small probe: directionally bullish but limited confidence, or a volatile regime that argues for caution.",
      "Standard size: solid agreement across indicators in a normal volatility regime.",
      "Full size: near-total alignment with no overbought warning, in a calm-to-normal regime."
    ]
  },
  "selling_quantity": {
    "type": "score",
    "instructions": "Assuming the evidence favored a Sell, and there is an open position with a given `unrealized_pnl_pct`, how much should be reduced?",
    "criteria": [
      "Partial trim: one mild warning sign, trend structure still intact.",
      "Half reduction: multiple exhaustion signals or MAs flattening.",
      "Full exit: broad-based reversal evidence or a clear trend breakdown."
    ]
  },
  "stop_loss_target": {
    "type": "choice",
    "instructions": "If entering or managing a position, what stop loss distance is appropriate given the current volatility regime, recent swing low, and support levels?",
    "criteria": {
      "tight": "Tight stop loss (0.75% to 1.5% below entry) for quick scalp or high conviction setups with tight invalidation.",
      "moderate": "Standard stop loss (2.0% to 3.5% below entry) placed below key short-term moving average support (EMA 20 / SMA 50).",
      "wide": "Wide stop loss (4.0% to 6.0% below entry) for volatile swings or longer holding periods."
    }
  },
  "take_profit_target": {
    "type": "choice",
    "instructions": "If entering or managing a position, what take profit target aligns best with momentum and upside resistance?",
    "criteria": {
      "conservative": "Quick profit target (1.5% to 3.0% gain) near immediate local resistance or oscillator peak.",
      "balanced": "Balanced target (3.5% to 6.5% gain) aiming for trend expansion with healthy risk-reward.",
      "aggressive": "Extended runner target (7.0% to 12.0%+ gain) targeting multi-tier breakout or strong momentum rally."
    }
  },
  "low_reliability_setup": {
    "type": "noul",
    "instructions": "Given `time_frame` is 1 minute and the current volatility regime, are the signals more likely to be noise than a reliable, tradeable edge right now?"
  },
  "conviction_level": {
    "type": "score",
    "instructions": "Independent of direction, how much conviction does the full picture provide for taking any action at all, versus staying flat?",
    "criteria": [
      "Low: indicators mostly Neutral or contradictory.",
      "Moderate: clear majority agree, a few holdouts.",
      "High: near-unanimous agreement."
    ]
  }
}
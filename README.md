# 🧠 SAGE — Self-Improving AI Trading & Sportsbook Gambling Agents

> Inspired by [ATLAS (General Intelligence Capital)](https://github.com/chrisworsey55/atlas-gic) + Karpathy's autoresearch pattern.  
> **100% free to run.** No paid API required. Works locally via Ollama or free cloud tiers.

---

## What is SAGE?

SAGE is a local-first research framework where swarms of AI agents debate daily trade ideas and sportsbook bets, track their own performance, and automatically rewrite their own prompts when they underperform — keeping changes only if results actually improve.

---

## LLM Provider Cascade — Fully Free

SAGE tries each provider in priority order. If one is unavailable, it silently falls back to the next:

| Priority | Provider | Cost | How to enable |
|---|---|---|---|
| 1 | 🖥️ **Ollama** (local) | Free forever | Install [Ollama](https://ollama.com), run `ollama pull llama3.3` |
| 2 | ✨ **Google Gemini** | Free (1M tokens/day) | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| 3 | ⚡ **Groq** | Free tier | [console.groq.com/keys](https://console.groq.com/keys) |
| 4 | 🌐 **OpenRouter** | Free models | [openrouter.ai/keys](https://openrouter.ai/keys) |

**Recommended setup:** Ollama at home + Gemini key for when you're away. That covers 100% of usage for free.

---

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/YOUR_USERNAME/SAGE.git
cd SAGE

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Open .env and add your free API keys (see table above)

# 4. Start Ollama (if using locally)
ollama serve
ollama pull llama3.3   # or: mistral, llama3.1, qwen2.5, etc.

# 5. Start SAGE
npm start
# → Open http://localhost:3000
```

---

## Architecture

### Trading Agents — 20 agents across 4 layers

**Layer 1 — Macro (5 agents)**
- Fed & Rates Analyst
- Global Macro & FX Analyst
- Geopolitical Risk Analyst
- Volatility & Sentiment Analyst
- Liquidity & Credit Analyst

**Layer 2 — Sector Specialists (7 agents)**
- Semiconductor & AI Hardware
- Software & Cloud
- Energy & Commodities
- Healthcare & Biotech
- Financials & Fintech
- Consumer & Retail
- Industrials & Supply Chain

**Layer 3 — Famous Investor Style Agents (4 agents)**
- Druckenmiller (macro momentum + asymmetric sizing)
- Buffett (quality value + durable moats)
- Lynch (GARP — Growth at Reasonable Price)
- Simons (quantitative + statistical patterns)

**Layer 4 — Decision Layer (4 agents)**
- CRO — Adversarial risk officer, attacks every idea
- Alpha Discovery — Finds overlooked names
- Execution Agent — Converts signals to sized trades
- CIO — Final synthesis, weighted by Darwinian scores

### Sports Betting Agents — 12 agents across 3 layers

**Sport Specialists (5):** NFL, NBA, MMA/UFC, MLB, NHL

**Support Analysts (4):**
- Sharp Money & Line Movement
- Injury & Roster Intelligence
- Situational & Schedule Analysis
- Historical Trends & Props

**Decision Layer (3):**
- Value Identification (enforces -200 or better odds only)
- Kelly Criterion Sizing (25% fractional Kelly)
- Sports CIO (final approval)

---

## The Self-Improvement Loop

```
Every session:
  → Each agent submits thesis → layers debate → CIO synthesizes

After enough data accumulates:
  → Score predictions vs outcomes (Sharpe for trading, ROI for sports)
  → Identify worst-performing agent (lowest Darwinian weight)
  → Rewrite that agent's prompt using failure pattern analysis
  → Shadow mode: new prompt runs alongside old for 5 sessions
  → If new prompt Sharpe/ROI improves → keep it
  → If not → revert to old prompt

Darwinian weights:
  → Top quartile per session:    weight × 1.05  (max 2.50×)
  → Bottom quartile per session: weight × 0.95  (min 0.30×)
  → CIO weights each agent's input proportionally
```

---

## Regime-Specific Cohorts

**Market Regimes:** Bull / Bear / Sideways / High-Vol / Low-Vol / Crisis

Each regime activates a different cohort. E.g. in Crisis: CRO, Liquidity, and Druckenmiller agents get boosted; Lynch and Buffett agents are suppressed. The meta-layer tracks which cohort performed best in each regime over time.

**Sports Regimes:** Early Season / Mid Season / Playoffs / Championship

---

## Sports Betting Rules

- **Odds filter:** American odds **-200 or more negative ONLY** (implied prob ≥ 66.7%)
- **Sports:** NFL, NBA, MMA/UFC, MLB, NHL
- **Bet types:** Moneyline, Spread, Over/Under, Team Props, Player Props, Game Props, Quarter/Half/Inning/Round Props, Method of Victory, Special Props
- **Sizing:** 25% fractional Kelly Criterion, hard cap at 3 units per bet

---

## Google Sheets Logging

All picks are auto-logged to your Google Sheet after every session:

| Sheet Tab | Contents |
|---|---|
| `Trading Picks` | Every trade idea — ticker, action, entry, target, stop, thesis, outcome |
| `Sports Picks` | Every bet — sport, game, type, pick, odds, units, outcome, P&L |
| `Agent Performance` | Per-agent accuracy, Sharpe, ROI, weight, rewrites, blind spots |
| `Equity Curve` | Session-by-session portfolio value and daily returns |

### Setting up Google Sheets (one time)
1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project → Enable **Google Sheets API**
3. Create **OAuth2 credentials** (Desktop app type)
4. Download and note your Client ID + Client Secret
5. Add to `.env`: `GOOGLE_CLIENT_ID=` and `GOOGLE_CLIENT_SECRET=`
6. Restart server → go to **Settings tab** → click **Authorize Google Sheets**

---

## Backtesting

Go to the **Backtest** tab to simulate N sessions of full agent debates with synthetic or custom market contexts. After the run, view:
- Equity curve
- Per-agent weight evolution over time
- Session-by-session Sharpe / ROI
- Which agents survived Darwinian selection

---

## Agent Spawning

SAGE detects "blind spots" — patterns in repeated losses shared across agents. When 3+ consecutive losses share a common factor, SAGE proposes spawning a new specialist agent for that factor, complete with an auto-generated prompt. New agents start at 0.70× weight and must earn trust through performance.

---

## Project Structure

```
SAGE/
├── server.js              # Express server — provider proxy, Sheets OAuth, results API
├── providers.js           # LLM cascade: Ollama → Gemini → Groq → OpenRouter
├── .env.example           # Environment template (copy to .env)
├── package.json
├── results/               # Local JSON saves of backtest results
└── public/
    ├── index.html         # Full dashboard UI
    ├── css/style.css      # Dark research framework theme
    └── js/
        ├── db.js                      # IndexedDB persistence layer
        ├── app.js                     # Main application controller
        ├── agents/
        │   ├── definitions.js         # All 32 agent prompts and configs
        │   └── manager.js             # Weights, Darwinian evolution, autoresearch
        ├── engine/
        │   ├── debate.js              # Layered multi-agent debate engine
        │   ├── regime.js              # Regime detection + cohort weighting
        │   └── backtest.js            # Backtest simulation engine
        ├── integrations/
        │   └── sheets.js              # Google Sheets logging client
        └── ui/
            └── dashboard.js           # All rendering and event handling
```

---

## Tech Stack

| Layer | Technology | Cost |
|---|---|---|
| Frontend | Vanilla JS + CSS (zero build step) | Free |
| Backend | Node.js + Express | Free |
| LLM | Ollama / Gemini / Groq / OpenRouter | Free |
| Persistence | IndexedDB (browser) + local JSON | Free |
| Logging | Google Sheets API | Free |
| Infrastructure | Your own machine | Free |

---

## Pushing to GitHub

```bash
# First time setup (from inside the SAGE folder)
git init
git add .
git commit -m "Initial SAGE commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/SAGE.git
git push -u origin main

# After future changes
git add .
git commit -m "describe what changed"
git push
```

> ⚠️ **Never commit your `.env` file.** It's in `.gitignore` by default — keep it that way. Add free API keys to `.env` locally; teammates use their own `.env`.

---

## Disclaimer

SAGE is a research and educational tool. Nothing it produces is financial or gambling advice. All trading and betting carries risk. Past performance of agents does not guarantee future results.

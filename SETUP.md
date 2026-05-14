# SAGE — Setup Cheat Sheet

## Step 1 — Install Node.js
Download from https://nodejs.org (LTS version). Verify: `node -v`

## Step 2 — Install Ollama (free, local AI)
Download from https://ollama.com and install.
Then pull a model:
```bash
ollama pull llama3.3        # best all-round (recommended)
# alternatives:
ollama pull mistral
ollama pull llama3.1
ollama pull qwen2.5
```

## Step 3 — Clone & install SAGE
```bash
git clone https://github.com/YOUR_USERNAME/SAGE.git
cd SAGE
npm install
```

## Step 4 — Configure .env
```bash
cp .env.example .env
```
Open `.env` in any text editor. The minimum config to get started:
```
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3.3
```
Optional free cloud backups (for when Ollama isn't running):
```
GEMINI_API_KEY=     # https://aistudio.google.com/apikey
GROQ_API_KEY=       # https://console.groq.com/keys
OPENROUTER_API_KEY= # https://openrouter.ai/keys
```

## Step 5 — Start Ollama + SAGE
```bash
# Terminal 1
ollama serve

# Terminal 2
npm start
```
Open http://localhost:3000

## Step 6 — Optional: Google Sheets logging
1. Go to https://console.cloud.google.com
2. Create project → Enable "Google Sheets API"
3. Create OAuth2 credentials (type: Desktop app)
4. Copy Client ID and Secret into your `.env`
5. Restart server → Settings tab → "Authorize Google Sheets"

## Running a session
**Trading:** Paste today's market context → Run Trading Session  
**Sports:** Paste today's games + injury news → Run Sports Session  
**Only bets at -200 or better American odds will appear in Sports picks.**

## Pushing updates to GitHub
```bash
git add .
git commit -m "your message"
git push
```

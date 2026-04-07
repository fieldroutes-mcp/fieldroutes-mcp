# EcoArmor FieldRoutes MCP Server

Connects Claude to your FieldRoutes account via the Model Context Protocol.

## Tools Included

| Tool | What it does |
|---|---|
| `search_customer` | Find customers by name, phone, email, city, address |
| `get_customer` | Full account detail + balance for a specific customer |
| `get_appointments` | Service history and upcoming appointments |
| `get_subscriptions` | Active service plans |
| `get_tickets` | Invoice lookup with balance info |
| `get_payments` | Payment history |
| `add_note` | Log a note directly to a customer account |

---

## Deploy to Railway (Recommended — ~5 minutes)

### 1. Push to GitHub

Create a new GitHub repo and push this folder to it.

### 2. Create Railway project

1. Go to [railway.app](https://railway.app) and sign in
2. Click **New Project → Deploy from GitHub Repo**
3. Select your repo

### 3. Add environment variables

In Railway → your service → **Variables**, add:

```
FR_AUTH_KEY=your_fieldroutes_authentication_key
FR_AUTH_TOKEN=your_fieldroutes_authentication_token
FR_HOST=ecoarmor.fieldroutes.com
PORT=3000
```

### 4. Deploy

Railway auto-deploys. Once live, your MCP URL will be:
```
https://your-app-name.up.railway.app/mcp
```

---

## Connect to Claude.ai

1. Go to **Claude.ai → Settings → Integrations**
2. Click **Add Integration**
3. Paste your Railway URL: `https://your-app-name.up.railway.app/mcp`
4. Save — Claude will now have access to your FieldRoutes data

---

## Local Testing

```bash
npm install
FR_AUTH_KEY=your_key FR_AUTH_TOKEN=your_token node index.js
```

Server runs at `http://localhost:3000/mcp`

---

## Getting Your API Credentials

In FieldRoutes: **Settings → API Keys**

You need:
- **Authentication Key** → `FR_AUTH_KEY`
- **Authentication Token** → `FR_AUTH_TOKEN`

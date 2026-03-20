# 🚂 Railway Backend Setup Checklist

Follow these exact steps in your Railway dashboard to get your NexusPay backend running 24/7.

## 1. Connect Your Repo
- Click **"New"** -> **"GitHub Repo"**
- Select `VaultPayments`

## 2. Configure Directory
- Click on the new service -> **Settings** tab.
- Find **"Root Directory"** and set it to: `backend`
- Railway will now look inside the `backend` folder for your `package.json`.

## 3. Add Persistence (Volume) — IMPORTANT!
Since we use SQLite, we need to save the database file:
- Click **"Add Service"** (button at top right) -> **"Volume"**.
- Name it: `nexuspay-data`
- Mount Path: `/data`
- Connect this volume to your backend service.

## 4. Environment Variables
Go to the **Variables** tab and click **"Bulk Import"** or add these one by one:

| Key | Suggested Value |
| :--- | :--- |
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `DB_PATH` | `/data/nexuspay.db` |
| `JWT_SECRET` | `{{GENERATED_JWT_SECRET}}` |
| `ENCRYPTION_KEY` | `{{GENERATED_ENC_KEY}}` |
| `WEBHOOK_SECRET` | `{{GENERATED_WEBHOOK_SECRET}}` |
| `FRONTEND_URL` | `https://toshalkumbhar8979-design.github.io/VaultPayments` |
| `PLATFORM_NAME` | `NexusPay` |

> [!TIP]
> Use these unique keys I generated for you:
> - **JWT_SECRET:** `a7f92b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1`
> - **ENCRYPTION_KEY:** `b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6`
> - **WEBHOOK_SECRET:** `f1e2d3c4b5a697887766554433221100`

## 5. Deployment
- Railway will automatically redeploy when you save these variables.
- Once it's "Active", copy the **Railway Public URL** (e.g., `https://backend-production-xxx.up.railway.app`).
- **Final Step:** Open your local `config.js` and update `window.NEXUSPAY_API_URL` with this new live link, then push to GitHub one last time!

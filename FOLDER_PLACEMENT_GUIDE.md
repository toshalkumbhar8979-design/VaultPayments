# 📁 NexusPay: Folder Placement & Deployment Architecture

This guide explains exactly which folders belong to which part of your infrastructure when deploying to a public server.

---

## 🏗️ Architecture Overview

NexusPay is split into three main logical parts:
1. **The Static Frontend** (HTML/CSS/JS) — Hosted on a CDN or Web Server.
2. **The Backend API** (Node.js) — Hosted on an App Server.
3. **The Settlement Worker** (Go) — Hosted as a Background Service.

---

## 1️⃣ Static Web Hosting (Nginx / Cloudflare Pages / Vercel)
These folders contain the code that runs in the user's browser. They should be placed in your web server's "Public" or "Root" directory.

| Folder / File | Description | Destination |
|:--- |:--- |:--- |
| `index.html` | main Landing Page | Web Root `/` |
| `signup.html` / `login.html` | Auth Pages | Web Root `/` |
| `onboarding.html` | Merchant setup flow | Web Root `/` |
| `integrations.html` | Docs & SDK directory | Web Root `/` |
| `/dashboard/` | Merchant Portal | Web Root `/dashboard/` |
| `/pay/` | Customer Checkout UI | Web Root `/pay/` |
| `/assets/` | Global CSS/JS/Images | Web Root `/assets/` |

> [!TIP]
> **Pro Tip:** If using Cloudflare Pages or Netlify, simply upload the **entire root directory** but ensure your build settings ignore the `backend/` and `settlement-worker/` folders to keep the bundle small.

---

## 2️⃣ Backend API Server (Node.js / VPS / Railway)
This is the core engine. It needs a Node.js environment to run.

| Folder | Description | Destination |
|:--- |:--- |:--- |
| `/backend/` | Node.js API Server | App Server `/app/backend/` |

### 🚀 To Deployment this folder:
1. Copy the `backend/` folder to your server.
2. Ensure you have a `.env` file inside `backend/` (Refer to `backend/.env.example`).
3. Run `npm install --production`.
4. Run `npm start` (or use `pm2 start server.js`).

---

## 3️⃣ Background Services (Go / Docker)
This service handles high-speed settlement logic and does not serve web traffic directly.

| Folder | Description | Destination |
|:--- |:--- |:--- |
| `/settlement-worker/` | Go Worker service | Worker Server `/app/worker/` |

### 🚀 To Deploy this folder:
1. Ensure **Redis** and **Postgres** are reachable.
2. Run `go build -o worker ./cmd/worker/`.
3. Run `./worker` (or use the provided `Dockerfile`).

---

## 4️⃣ Development & Support Folders (Optional)
These folders are generally **NOT** needed on your production server.

| Folder | Stay or Go? | Reason |
|:--- |:--- |:--- |
| `/proto/` | ❌ Go | Used for generating code; compiled results stay in services. |
| `/demo-store/` | ❌ Go | Only for your local testing; merchants use their own sites. |
| `.agents/` | ❌ Go | Internal tool metadata for development. |
| `README.md` | ❌ Go | Not needed for the machine to run. |

---

## 📝 Example VPS Directory Map
If you are using a single Linux server (VPS), your folder structure should look like this:

```text
/var/www/nexuspay/          <-- Nginx points here (Static Frontend)
  ├── assets/
  ├── dashboard/
  ├── pay/
  ├── index.html
  └── ... (other html files)

/opt/nexuspay-api/          <-- PM2 runs here (Node.js Backend)
  └── backend/
      ├── server.js
      └── package.json

/opt/nexuspay-worker/       <-- Systemd runs here (Go Worker)
  └── settlement-worker/
      └── main.go
```

---

> [!IMPORTANT]
> **Environment Sync:** Always remember that your **Frontend** (in cards/scripts) needs to know the URL of your **Backend**. Check `dashboard/assets/js/app.js` or similar config files to ensure they point to `https://api.yourdomain.com`.

# Render Deployment Guide (Docker)

This guide walks through deploying **Algorithm Auction / Code Clash** to [Render](https://render.com) as a Docker container.

---

## 🚀 Deployment Steps (Render Web Service)

### Step 1: Push Code to GitHub / GitLab
Make sure your latest code including `Dockerfile`, `.dockerignore`, and `render.yaml` is pushed to your Git repository:

```bash
git add .
git commit -m "Add Docker and Render configuration"
git push origin main
```

---

### Step 2: Deploy on Render

#### Option A: Automatic Deployment using Render Blueprint (Recommended)

1. Log in to [Render Dashboard](https://dashboard.render.com).
2. Click **New +** in the top right and select **Blueprint**.
3. Connect your GitHub/GitLab repository.
4. Render will automatically read `render.yaml` and configure:
   - **Environment:** Docker
   - **Build Command:** Built via `Dockerfile`
   - **Environment Variables:** `PORT=10000`, `DB_DIR=/app/database`, `PYTHON_BIN=python3`, and an auto-generated `ADMIN_PASSWORD`.
5. Click **Apply**. Render will build and launch your application!

---

#### Option B: Manual Web Service Setup

1. Log in to [Render Dashboard](https://dashboard.render.com).
2. Click **New +** → **Web Service**.
3. Select **Build and deploy from a Git repository**.
4. Choose your repository.
5. Configure the service settings:
   - **Name:** `code-auction`
   - **Language / Runtime:** `Docker`
   - **Dockerfile Path:** `./Dockerfile`
   - **Region:** Pick a region closest to your participants (e.g. Singapore, Frankfurt, Oregon).
   - **Instance Type:** Free or Starter.
6. Add **Environment Variables**:
   | Variable | Value | Description |
   |---|---|---|
   | `ADMIN_PASSWORD` | `your-secure-password` | Administrator login password |
   | `PORT` | `10000` | Port for web traffic |
   | `DB_DIR` | `/app/database` | SQLite database directory |
   | `PYTHON_BIN` | `python3` | Python binary path for judging |
7. Click **Create Web Service**.

---

## 🔒 SQLite Database Persistence Notes

* **Free Plan:** The SQLite database is created inside the container at `/app/database/code_auction.db`. On free tier instances, data resets if the instance is redeployed or restarts due to inactivity.
* **Persistent Storage (Paid Plan):**
  - To keep database data permanently across redeployments:
  - In Render Dashboard under your web service, go to **Disks** → **Add Disk**.
  - **Name:** `code-auction-db`
  - **Mount Path:** `/app/database`
  - **Size:** `1 GB` (or larger).

---

## 🌐 Post-Deployment Checklist

1. Open your Render Web Service URL (e.g. `https://code-auction.onrender.com`).
2. Log in to the **Administrator Control Room** using your `ADMIN_PASSWORD`.
3. Verify that:
   - Participant access requests and auto-approvals work.
   - Code judging for Python 3 and C++17 completes successfully.
   - Real-time updates and proctoring telemetry function smoothly.

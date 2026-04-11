# Full Guide: Hosting your Bot with Cloudflare Tunnels

This guide covers everything from buying a domain to making your local bot accessible via HTTPS.

---

## Phase 1: Domain Setup (Namecheap Example)

1. **Buy a Domain:**
   - Go to Namecheap (or any registrar) and purchase your domain (e.g., `yourdomain.com`).

2. **Verify your Email:**
   - **CRITICAL:** Check your inbox for an ICANN verification email. If you don't click the link, your domain will be suspended within 15 days, and nothing will work.

3. **Connect to Cloudflare:**
   - Create a free account at [Cloudflare](https://dash.cloudflare.com/).
   - Click "Add a Site" and enter your domain.
   - Cloudflare will give you two Nameservers (e.g., `ashley.ns.cloudflare.com`).
   - Go back to your registrar (Namecheap) → Domain List → Manage → Nameservers.
   - Select "Custom DNS" and paste the Cloudflare Nameservers.
   - Wait for the "Active" status in Cloudflare (usually 15-30 mins).

---

## Phase 2: Server Setup (Linux)

1. **Install cloudflared:**
   ```bash
   sudo apt install cloudflared
   # or download the binary manually for your architecture
   ```

2. **Authenticate:**
   ```bash
   cloudflared tunnel login
   ```
   Click the link, log in to Cloudflare, and select your domain.

3. **Create the Tunnel:**
   ```bash
   cloudflared tunnel create my-tunnel
   ```
   This generates a JSON credentials file on your server.

---

## Phase 3: Routing & Connectivity

1. **Create DNS Entry:**
   ```bash
   cloudflared tunnel route dns my-tunnel helyx.yourdomain.com
   ```
   > If you get a "Record already exists" error, go to Cloudflare Dashboard → DNS → Records and delete the existing CNAME for `helyx` first.

2. **Configure Zero Trust (The "Bridge"):**
   - Go to [Zero Trust Dashboard](https://one.dash.cloudflare.com/) → Networks → Tunnels.
   - Click your tunnel → Configure → Public Hostname.
   - Click **Add a public hostname**:
     - Subdomain: `helyx`
     - Domain: `yourdomain.com`
     - Type: `HTTP`
     - URL: `localhost:3847`
   - Click Save.

---

## Phase 4: Final Launch

1. **Docker Preparation:**
   Ensure your `docker-compose.yml` has the port mapped:
   ```yaml
   ports:
     - "3847:3847"
   ```

2. **Start the Tunnel:**
   ```bash
   # Run manually:
   cloudflared tunnel run my-tunnel

   # Or install as a system service:
   sudo cloudflared service install <YOUR_TOKEN>
   ```

---

## Phase 5: Enable Webhook in the Bot

Once the tunnel is active, switch the bot from polling to webhook:

1. **Update `.env`:**
   ```env
   TELEGRAM_TRANSPORT=webhook
   TELEGRAM_WEBHOOK_URL=https://helyx.yourdomain.com/telegram/webhook
   TELEGRAM_WEBHOOK_SECRET=<random-secret-string>
   ```

   Generate a secret:
   ```bash
   python3 -c "import secrets; print(secrets.token_urlsafe(32))"
   ```

2. **Rebuild the bot:**
   ```bash
   helyx restart
   # or: docker compose up -d --build bot
   ```

3. **Verify:**
   ```bash
   # Check logs for "webhook registered at ..."
   helyx logs

   # Check webhook status via Telegram API
   curl -s https://api.telegram.org/bot<TOKEN>/getWebhookInfo | jq .
   ```

---

## Test your Setup

```bash
# Health check through the tunnel
curl https://helyx.yourdomain.com/health
```

You should see:
```json
{"status":"ok","db":"connected","uptime":...,"sessions":...}
```

Send a message to your bot in Telegram — it should respond through the webhook.

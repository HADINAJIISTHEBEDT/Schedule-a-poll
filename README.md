# WhatsApp Poll Scheduler

Schedule and send **native WhatsApp polls** to your chats — delivered with human-like timing so they don't look automated. Works with both **WhatsApp** and **WhatsApp Business** (via Linked Devices).

![Poll Scheduler](https://img.shields.io/badge/WhatsApp-Poll%20Scheduler-00a884)

## Features

- **Native polls** — Real WhatsApp poll messages (not fake text polls)
- **WhatsApp + WhatsApp Business** — Connect either app via QR code (Linked Devices)
- **Schedule polls** — Pick a date/time; the app sends automatically
- **Send now** — Immediate delivery with natural delays
- **Multi-chat** — Send the same poll to multiple groups or contacts
- **Human-like delivery** — Random pauses, typing indicators, and staggered sends between chats
- **Web dashboard** — Simple UI to create polls, select chats, and track status

## How it works

This app uses [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js) to connect to your WhatsApp account through the official **Linked Devices** feature (same as WhatsApp Web). Polls are sent as real WhatsApp poll messages from your account.

Before each poll is sent, the app:
1. Waits a random pause (configurable seconds)
2. Shows the **typing...** indicator in the chat
3. Simulates typing duration based on the question length
4. Sends the poll
5. Staggers delivery when sending to multiple chats

## Requirements

- **Node.js 18+**
- **Google Chrome/Chromium** (installed automatically by Puppeteer)
- A phone with WhatsApp or WhatsApp Business

## Quick start

```bash
# Install dependencies
npm install

# Start the server
npm start
```

Open **http://localhost:3000** in your browser.

### Connect WhatsApp

1. Click **Connect WhatsApp**
2. Scan the QR code with your phone:
   - **WhatsApp**: Settings → Linked Devices → Link a Device
   - **WhatsApp Business**: Settings → Linked Devices → Link a Device
3. Wait until status shows **Connected**

### Create a poll

1. Enter your poll question and options (2–12)
2. Select one or more chats
3. Set a schedule time, or click **Send Now**
4. Adjust the human-like delay range (seconds between chats)

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/status` | Connection state and QR code |
| POST | `/api/connect` | Start WhatsApp connection |
| POST | `/api/disconnect` | Disconnect session |
| GET | `/api/chats` | List available chats |
| GET | `/api/polls` | List all scheduled polls |
| POST | `/api/polls` | Create / schedule a poll |
| DELETE | `/api/polls/:id` | Delete a pending poll |
| POST | `/api/polls/:id/send-now` | Send a pending poll immediately |

### Create poll example

```json
POST /api/polls
{
  "question": "What time works best for the meeting?",
  "options": ["9:00 AM", "12:00 PM", "3:00 PM"],
  "chatIds": ["120363123456789@g.us"],
  "allowMultiple": false,
  "scheduledAt": "2026-07-22 14:30:00",
  "humanDelayMin": 3,
  "humanDelayMax": 12,
  "sendNow": false
}
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Web server port |

## Data storage

- **SQLite database**: `data/polls.db` — scheduled polls
- **WhatsApp session**: `data/whatsapp-session/` — keeps you logged in

## Important notes

- **Unofficial API**: This uses WhatsApp Web automation, not the Meta Business API. Use responsibly and follow WhatsApp's terms of service.
- **Keep session alive**: Your phone needs internet occasionally; don't unlink the device.
- **Rate limits**: Avoid sending too many polls too quickly. Use the human delay settings.
- **Poll limits**: WhatsApp supports up to 12 options per poll.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| QR code not showing | Click Connect again; check terminal for Chrome/Puppeteer errors |
| Chats not loading | Ensure status is "Connected"; click Refresh |
| Poll failed to send | Check the chat still exists; reconnect WhatsApp |
| Session expired | Disconnect and scan QR again |

## Deploy on Render

1. Use the **`main`** branch (must contain `package.json` at the repo root)
2. Go to [render.com](https://render.com) → **New** → **Blueprint**
3. Connect your GitHub repo `HADINAJIISTHEBEDT/Schedule-a-poll`
4. Render will read `render.yaml` and deploy automatically
5. Open your Render URL (e.g. `https://schedule-a-poll.onrender.com`)
6. Connect WhatsApp via QR code

**Important for Render:**
- Use **Docker** environment (not Node) — WhatsApp needs Chromium
- **Root Directory must be blank** — do NOT set it to `src`
- Use the **Starter** plan or higher
- A **persistent disk** is configured for WhatsApp session data (`/app/data`)
- Scan the QR **once** — the login is saved on the disk and survives deploys/restarts
- Only tap **Disconnect** if you want to unlink and require a new QR scan

### Fix: `ENOENT package.json` / `project/src/package.json`

This error means Render is looking in the wrong folder. Fix it:

| Setting | Correct value |
|---------|----------------|
| **Environment** | **Docker** |
| **Root Directory** | *(leave blank)* |
| **Branch** | `main` |
| **Dockerfile Path** | `./Dockerfile` |

If you created a **Node** service by mistake, delete it and redeploy with **Docker** or **Blueprint**.

### Manual Render setup (without Blueprint)

| Setting | Value |
|---------|-------|
| Environment | **Docker** |
| Root Directory | *(blank — not `src`)* |
| Branch | `main` |
| Dockerfile Path | `./Dockerfile` |
| Health Check | `/api/health` |
| Disk | Mount `/app/data` (1 GB) |

## Android APK

Download the mobile app:

**[Download poll-scheduler.apk](https://p-3000-pod-vdzcpbtkyndxlpcmjqfuozh5o4-8d6b3a75d5a0d05a8a0f-us3.agent.cvm.dev/download/apk?_ingress_token=nto-frwbpiremvehxl25t44fr7nzpe)**

Or from GitHub: `https://github.com/HADINAJIISTHEBEDT/Schedule-a-poll/raw/main/releases/poll-scheduler.apk`

Or from your running server: `http://localhost:3000/download/apk`

### How to use the APK

1. Install the APK on your Android phone (enable "Install from unknown sources" if asked)
2. On your PC, run the server: `npm start`
3. Find your PC's local IP (e.g. `192.168.1.5`)
4. Open the app on your phone → tap **⚙️** → enter `http://YOUR_PC_IP:3000`
5. Connect WhatsApp and schedule polls from your phone

> The WhatsApp connection runs on your PC/server. The APK is the remote control UI.

### Build APK yourself

```bash
npm install
npm run build:apk
```

Output: `releases/poll-scheduler.apk`

## License

MIT

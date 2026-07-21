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

## License

MIT

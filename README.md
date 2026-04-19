# Mammotion Mower for Homey

Control your Mammotion robot mower directly from [Homey](https://homey.app).

## Features

- 🔋 Battery level monitoring with low-battery alarm
- 🌿 Start / Stop / Pause mowing
- 🏠 Return to charging dock
- 📊 Real-time mower state tracking (idle, mowing, charging, paused, error, returning)
- 🔄 Homey Flow support (triggers, conditions, actions)
- 🌐 Cloud-based — works anywhere via Mammotion Cloud (Aliyun IoT)

## Supported Devices

- Mammotion Luba Mini AWD 800
- Mammotion Luba AWD 1000 / 3000 / 5000
- Mammotion Luba 2 AWD 1000 / 3000 / 5000 / 10000
- Mammotion Yuka 1500 / 2000
- Mammotion Spino

> Other Mammotion devices using the Mammotion Cloud may also work.

## Prerequisites

### ⚠️ Create a Secondary Mammotion Account (Important!)

The Mammotion cloud only allows **one active session per account**. If you use your primary account credentials in this Homey app, **you will be logged out of the official Mammotion mobile app**.

**To avoid this, create a dedicated secondary account:**

1. Open the Mammotion app on your phone
2. Register a **new account** with a different email address
3. From your **primary account**, go to your mower's settings and **share the mower** with the new account's email
4. Accept the share invitation from the secondary account
5. Use the **secondary account** credentials when pairing in Homey

This way both the mobile app (primary account) and Homey (secondary account) can control the mower simultaneously without conflicts.

## Installation

### Via Homey CLI (development)

```bash
# Install Homey CLI if you haven't already
npm install -g homey

# Clone the repository
git clone https://github.com/adagues/homey-mammotion.git
cd homey-mammotion

# Install dependencies
npm install

# Run on your Homey (development mode)
homey app run

# Or install persistently
homey app install
```

## Configuration

1. After installing the app, go to **Devices → Add Device → Mammotion Mower**
2. Enter the **email** and **password** of your (secondary) Mammotion account
3. The app will discover all mowers bound to that account
4. Select your mower and add it

## How It Works

The app communicates with Mammotion's cloud infrastructure:

1. **Authentication** — OAuth2 login to Mammotion's identity service (`id.mammotion.com`)
2. **Aliyun IoT Session** — Obtains IoT tokens via the Alibaba Cloud IoT platform
3. **Status Polling** — Polls device properties every 30 seconds via the cloud API
4. **MQTT (optional)** — Connects to the Aliyun MQTT broker for real-time status updates when available
5. **Commands** — Sends mowing commands via the Aliyun IoT cloud-side API

## Flow Cards

### Triggers
| Card | Description |
|------|-------------|
| **Mower status changed** | Fires when the mower state changes (e.g., idle → mowing) |
| **Mower error** | Fires when the mower reports an error |

### Conditions
| Card | Description |
|------|-------------|
| **Mower is mowing** | True when the mower is actively mowing |
| **Mower is charging** | True when the mower is on the charging dock |

### Actions
| Card | Description |
|------|-------------|
| **Start mowing** | Begin a mowing session |
| **Stop mowing** | Stop the mower |
| **Pause mowing** | Pause the current mowing session |
| **Return to dock** | Send the mower back to the charging station |

## Troubleshooting

### "Authentication failed"
- Verify your email and password are correct
- Try logging into the Mammotion mobile app first to confirm credentials work
- Make sure you're using the secondary account credentials (see Prerequisites above)

### Mower not found after login
- Ensure the mower is powered on and connected to Wi-Fi
- Check that the mower has been properly shared with the secondary account
- Open the Mammotion app with the secondary account and verify the mower appears

### Commands not responding
- The mower must be online and reachable via the cloud
- Some commands require the mower to be in a specific state (e.g., cannot pause if not mowing)
- Check if the mower's Wi-Fi connection is stable

### Connection timeouts
- The app connects to Mammotion/Aliyun servers in China (`api.link.aliyun.com`)
- If your network blocks Chinese endpoints, the app will not work
- VPN or firewall rules may need to be adjusted

## Compatibility

- **Homey Pro (2019)** — ✅ Supported
- **Homey Pro (Early 2023)** — ✅ Supported
- **Homey Cloud** — ❌ Not supported (local platform only)

## Credits

- Protocol research and API documentation based on the excellent [PyMammotion](https://github.com/mikey0000/PyMammotion) project
- Inspired by the [Mammotion Home Assistant integration](https://github.com/mikey0000/Mammotion-HA)

## License

MIT — see [LICENSE](LICENSE) for details.

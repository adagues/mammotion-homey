# Mammotion Mower for Homey

Control your Mammotion robot mower from Homey.

## Features

- 🔋 Battery level monitoring
- 🌿 Start / Stop / Pause mowing
- 🏠 Return to charging dock
- 📊 Real-time mower state tracking
- 🔄 Homey Flow support (triggers, conditions, actions)
- 🇫🇷 French & English localization

## Supported Devices

- Mammotion Luba Mini AWD 800
- Mammotion Luba AWD 1000 / 3000 / 5000
- Mammotion Luba 2 AWD 1000 / 3000 / 5000
- Mammotion Yuka 1500 / 2000
- Mammotion Spino

> Other Mammotion devices using the Mammotion Cloud may also work.

## Installation

```bash
# Install Homey CLI
npm i -g homey

# Clone and install
cd homey-mammotion
npm install

# Run on your Homey
homey app run
```

## Configuration

During pairing, enter your Mammotion account credentials (email + password).

> ⚠️ **Recommended:** Create a secondary Mammotion account and share your mower with it. This avoids conflicts with the official app and keeps your main account safe.

### Creating a secondary account:
1. Register a new account in the Mammotion app
2. From your main account, share the mower with the new account
3. Use the secondary account credentials in Homey

## How It Works

The app communicates with Mammotion's cloud API (via Aliyun IoT platform):
1. Authenticates via OAuth2 to Mammotion's identity service
2. Obtains Aliyun IoT session tokens
3. Polls device status every 30 seconds
4. Sends commands via Aliyun IoT cloud-side API

## Flow Cards

### Triggers
- **Mower status changed** — fires when the mower state changes
- **Mower error** — fires when the mower reports an error

### Conditions
- **Mower is mowing** — true when actively mowing
- **Mower is charging** — true when on the dock

### Actions
- **Start mowing** — begin a mowing session
- **Stop mowing** — stop the mower
- **Pause mowing** — pause the current session
- **Return to dock** — send the mower back to charge

## Troubleshooting

### "Authentication failed"
- Verify your email and password are correct
- Try logging into the Mammotion app first
- If using a Chinese account, the API endpoints may differ

### Mower not found
- Ensure the mower is online and connected to Wi-Fi
- Check that the account has the mower shared/bound

### Commands not working
- Some commands require the mower to be in a specific state
- The mower must be online and reachable via the cloud

## Credits

- Protocol research based on [PyMammotion](https://github.com/mikey0000/PyMammotion)
- Aliyun IoT integration inspired by the open-source community

## License

MIT

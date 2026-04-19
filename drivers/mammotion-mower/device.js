'use strict';

const Homey = require('homey');
const MammotionAPI = require('../../lib/MammotionAPI');
const MammotionMQTT = require('../../lib/MammotionMQTT');

const POLL_INTERVAL = 30000; // 30 seconds

class MammotionMowerDevice extends Homey.Device {

  async onInit() {
    this.log('MammotionMowerDevice has been initialized');

    this.api = new MammotionAPI();
    this.mqtt = null;
    this._pollInterval = null;

    // Restore credentials and login
    const email = this.getStoreValue('email');
    const password = this.getStoreValue('password');

    if (!email || !password) {
      this.setUnavailable('No credentials configured. Please re-pair the device.');
      return;
    }

    try {
      await this.api.login(email, password);
      this.log('Successfully authenticated with Mammotion Cloud');

      // Try MQTT connection for real-time updates
      this._connectMQTT();

      // Start polling as fallback / primary status source
      this._startPolling();

      await this.setAvailable();
    } catch (err) {
      this.error('Failed to authenticate:', err.message);
      this.setUnavailable(`Authentication failed: ${err.message}`);
    }

    // Register capability listeners (for future settable capabilities)
    this._registerCapabilityListeners();
  }

  _registerCapabilityListeners() {
    this.registerCapabilityListener('button_start', async () => {
      this.log('Button: Start mowing');
      await this.startMowing();
    });

    this.registerCapabilityListener('button_pause', async () => {
      this.log('Button: Pause mowing');
      await this.pauseMowing();
    });

    this.registerCapabilityListener('button_stop', async () => {
      this.log('Button: Stop mowing');
      await this.stopMowing();
    });

    this.registerCapabilityListener('button_dock', async () => {
      this.log('Button: Return to dock');
      await this.returnToDock();
    });
  }

  _connectMQTT() {
    try {
      if (!this.api.mqttEndpoint || !this.api.iotToken || !this.api.identityId) {
        this.log('MQTT credentials not available, using HTTP polling only');
        return;
      }

      this.mqtt = new MammotionMQTT({
        mqttEndpoint: this.api.mqttEndpoint,
        iotToken: this.api.iotToken,
        identityId: this.api.identityId,
      });

      const iotId = this.getData().id;

      this.mqtt.on('connected', () => {
        this.log('MQTT connected');
        this.mqtt.subscribeDevice(iotId);
      });

      this.mqtt.on(`device:${iotId}`, (payload) => {
        this.log('MQTT device update:', JSON.stringify(payload));
        this._processStatusPayload(payload);
      });

      this.mqtt.on('error', (err) => {
        this.error('MQTT error:', err.message);
      });

      this.mqtt.connect();
    } catch (err) {
      this.error('MQTT connection failed:', err.message);
    }
  }

  _startPolling() {
    // Initial poll
    this.pollStatus().catch(err => this.error('Initial poll failed:', err.message));

    this._pollInterval = this.homey.setInterval(async () => {
      try {
        await this.pollStatus();
      } catch (err) {
        this.error('Poll failed:', err.message);

        // Try to re-authenticate on auth errors
        if (err.message.includes('token') || err.message.includes('auth') || err.message.includes('401')) {
          try {
            await this.api.refreshToken();
            this.log('Token refreshed successfully');
          } catch (refreshErr) {
            this.error('Token refresh failed:', refreshErr.message);
            this.setUnavailable('Authentication expired. Please re-pair.');
          }
        }
      }
    }, POLL_INTERVAL);
  }

  async pollStatus() {
    const iotId = this.getData().id;

    // Try status endpoint first
    try {
      const status = await this.api.getDeviceStatus(iotId);
      this.log('Device status:', JSON.stringify(status));
      this._processStatusPayload(status);
    } catch (err) {
      this.log('Status endpoint failed:', err.message);
    }

    // Also try properties endpoint
    try {
      const props = await this.api.getDeviceProperties(iotId);
      this.log('Device properties:', JSON.stringify(props));
      this._processPropertiesPayload(props);
    } catch (err) {
      this.log('Properties endpoint failed:', err.message);
    }
  }

  _processStatusPayload(data) {
    try {
      // Aliyun thing/status/get returns device online status
      if (data && data.status !== undefined) {
        this.log('Device online status:', data.status);
        // status 1 = online, 0 = offline
        if (data.status === 0) {
          this.setCapabilityValue('mower_activity', 'Offline').catch(this.error);
        }
      }

      // Try to extract properties from various response formats
      const props = data.properties || data.items || data;
      this._applyProperties(props);
    } catch (err) {
      this.error('Error processing status payload:', err.message);
    }
  }

  _processPropertiesPayload(data) {
    try {
      const props = data.properties || data.items || data;
      this._applyProperties(props);
    } catch (err) {
      this.error('Error processing properties payload:', err.message);
    }
  }

  _applyProperties(props) {
    if (!props || typeof props !== 'object') return;

    // Helper to extract value from Aliyun property format {time, value}
    const val = (obj) => (obj && obj.value !== undefined) ? obj.value : obj;

    // Battery level — Mammotion uses 'batteryPercentage'
    const batteryRaw = val(props.batteryPercentage) ?? val(props.battery_level);
    if (batteryRaw !== undefined) {
      const battery = Number(batteryRaw);
      if (!isNaN(battery)) {
        this.setCapabilityValue('measure_battery', battery).catch(this.error);
        this.setCapabilityValue('alarm_battery', battery < 15).catch(this.error);
      }
    }

    // Device state — Mammotion 'deviceState' values:
    // 0=idle, 1=mowing, 2=charging, 3=paused, 4=error, 5=returning
    // 6=upgrading, 7=standby, 8=area_training, 9=border_recording
    // 10=docked_idle, 11=docked_charging, 12=docked_charged
    const stateMap = {
      0: 'idle',
      1: 'mowing',
      2: 'charging',
      3: 'paused',
      4: 'error',
      5: 'returning',
      6: 'idle',       // upgrading
      7: 'idle',       // standby
      8: 'mowing',     // area training
      9: 'mowing',     // border recording
      10: 'idle',      // docked idle
      11: 'charging',  // docked charging
      12: 'idle',      // docked fully charged
    };

    const stateRaw = val(props.deviceState) ?? val(props.device_state);
    if (stateRaw !== undefined) {
      const stateNum = Number(stateRaw);
      const stateId = stateMap[stateNum] || 'idle';
      const currentState = this.getCapabilityValue('mower_state');

      if (currentState !== stateId) {
        this.setCapabilityValue('mower_state', stateId).catch(this.error);
        this.homey.flow.getDeviceTriggerCard('mower_status_changed')
          .trigger(this, { state: stateId })
          .catch(this.error);
        if (stateId === 'error') {
          this.homey.flow.getDeviceTriggerCard('mower_error')
            .trigger(this, { error_code: String(stateNum) })
            .catch(this.error);
        }
      }
    }

    // Activity — build a human-readable activity string
    const deviceStateNum = val(props.deviceState);
    const activityMap = {
      0: 'Idle', 1: 'Mowing', 2: 'Charging', 3: 'Paused',
      4: 'Error', 5: 'Returning to dock', 6: 'Upgrading firmware',
      7: 'Standby', 8: 'Area training', 9: 'Recording border',
      10: 'Docked (idle)', 11: 'Docked (charging)', 12: 'Docked (fully charged)',
    };
    if (deviceStateNum !== undefined) {
      const activity = activityMap[Number(deviceStateNum)] || `State ${deviceStateNum}`;
      this.setCapabilityValue('mower_activity', activity).catch(this.error);
    }

    // Blade height — Mammotion uses 'knifeHeight'
    const knifeHeight = val(props.knifeHeight);
    if (knifeHeight !== undefined) {
      this.log(`Blade height: ${knifeHeight}mm`);
    }
  }

  // ── Commands ────────────────────────────────────────────

  async startMowing() {
    const iotId = this.getData().id;
    this.log('Starting mowing');
    await this.api.startMowing(iotId);
  }

  async stopMowing() {
    const iotId = this.getData().id;
    this.log('Stopping mowing');
    await this.api.stopMowing(iotId);
  }

  async pauseMowing() {
    const iotId = this.getData().id;
    this.log('Pausing mowing');
    await this.api.pauseMowing(iotId);
  }

  async returnToDock() {
    const iotId = this.getData().id;
    this.log('Returning to dock');
    await this.api.returnToDock(iotId);
  }

  // ── Lifecycle ───────────────────────────────────────────

  async onDeleted() {
    this.log('MammotionMowerDevice has been deleted');

    if (this._pollInterval) {
      this.homey.clearInterval(this._pollInterval);
      this._pollInterval = null;
    }

    if (this.mqtt) {
      this.mqtt.disconnect();
      this.mqtt = null;
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    this.log('Settings changed:', changedKeys);
  }

}

module.exports = MammotionMowerDevice;

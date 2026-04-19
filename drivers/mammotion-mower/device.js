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
    // Currently all custom capabilities are read-only
    // Future: add listeners for settable capabilities
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
    const props = await this.api.getDeviceProperties(iotId);
    this._processStatusPayload(props);
  }

  _processStatusPayload(props) {
    try {
      // Battery level
      if (props.battery_level !== undefined) {
        const battery = Number(props.battery_level);
        if (!isNaN(battery)) {
          this.setCapabilityValue('measure_battery', battery).catch(this.error);
          this.setCapabilityValue('alarm_battery', battery < 15).catch(this.error);
        }
      }

      // Device state mapping
      const stateMap = {
        0: 'idle',
        1: 'mowing',
        2: 'charging',
        3: 'paused',
        4: 'error',
        5: 'returning',
      };

      if (props.device_state !== undefined) {
        const stateId = stateMap[props.device_state] || 'idle';
        const currentState = this.getCapabilityValue('mower_state');

        if (currentState !== stateId) {
          this.setCapabilityValue('mower_state', stateId).catch(this.error);

          // Trigger flow: state changed
          this.homey.flow.getDeviceTriggerCard('mower_status_changed')
            .trigger(this, { state: stateId })
            .catch(this.error);

          // Trigger flow: error
          if (stateId === 'error') {
            const errorCode = props.error_code || 'unknown';
            this.homey.flow.getDeviceTriggerCard('mower_error')
              .trigger(this, { error_code: String(errorCode) })
              .catch(this.error);
          }
        }
      }

      // Activity / work mode
      if (props.work_mode !== undefined) {
        this.setCapabilityValue('mower_activity', String(props.work_mode)).catch(this.error);
      }
    } catch (err) {
      this.error('Error processing status payload:', err.message);
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

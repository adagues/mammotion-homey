'use strict';

const Homey = require('homey');
const MammotionAPI = require('../../lib/MammotionAPI');
const MammotionMQTTDirect = require('../../lib/MammotionMQTTDirect');

const POLL_INTERVAL = 60000; // 60 seconds (Aliyun rate limit is strict)

class MammotionMowerDevice extends Homey.Device {

  async onInit() {
    this.log('MammotionMowerDevice has been initialized');

    this.api = new MammotionAPI();
    this.mqtt = null;
    this._pollInterval = null;

    // Dynamically add new capabilities if not present (for devices paired before update)
    const requiredCaps = [
      'button_start', 'button_pause', 'button_stop', 'button_dock',
      'measure_blade_height', 'measure_wifi_signal', 'meter_mileage',
      'meter_work_time', 'measure_temperature', 'alarm_rtk',
      'meter_task_area', 'device_model', 'firmware_version', 'wifi_network',
    ];
    for (const cap of requiredCaps) {
      if (!this.hasCapability(cap)) {
        this.log(`Adding missing capability: ${cap}`);
        await this.addCapability(cap).catch(err => this.error(`Failed to add ${cap}:`, err));
      }
    }

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

      // Connect MQTT Direct for commands
      this._connectMQTTDirect();

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

  _connectMQTTDirect() {
    try {
      const creds = this.api.mqttCredentials;
      if (!creds) {
        this.log('No MQTT credentials available');
        return;
      }

      this.mqttDirect = new MammotionMQTTDirect({
        host: creds.host,
        jwt: creds.jwt,
        clientId: creds.clientId || creds.client_id,
        username: creds.username,
      });

      this.mqttDirect.on('connected', () => {
        this.log('MQTT Direct connected! Ready to send commands.');
        // Don't subscribe to topics - just use for publishing commands
      });

      this.mqttDirect.on('message', ({ topic, payload }) => {
        this.log('MQTT message:', topic);
      });

      this.mqttDirect.on('error', (err) => {
        this.error('MQTT Direct error:', err.message);
      });

      this.mqttDirect.connect();
    } catch (err) {
      this.error('MQTT Direct setup failed:', err.message);
    }
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
    // Delay first poll by 30s to leave room for commands right after auth
    this._pollTimeout = this.homey.setTimeout(async () => {
      await this.pollStatus().catch(err => this.error('Initial poll failed:', err.message));

      // Then poll every 5 minutes (Aliyun rate limit is very strict)
      this._pollInterval = this.homey.setInterval(async () => {
        try {
          await this.pollStatus();
        } catch (err) {
          this.error('Poll failed:', err.message);
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
      }, 300000); // 5 minutes
    }, 30000); // 30s initial delay
  }

  async pollStatus() {
    const iotId = this.getData().id;

    // Only poll properties (status/get is redundant, properties has deviceState)
    try {
      const props = await this.api.getDeviceProperties(iotId);
      this.log('Device properties received');
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

    // Blade height
    const knifeH = val(props.knifeHeight);
    if (knifeH !== undefined) {
      this.setCapabilityValue('measure_blade_height', Number(knifeH)).catch(this.error);
    }

    // Device model
    const model = val(props.extMod);
    if (model !== undefined) {
      this.setCapabilityValue('device_model', String(model)).catch(this.error);
    }

    // Firmware
    const fw = val(props.deviceVersion);
    if (fw !== undefined) {
      this.setCapabilityValue('firmware_version', String(fw)).catch(this.error);
    }

    // Network info (JSON string)
    const netInfoStr = val(props.networkInfo);
    if (netInfoStr) {
      try {
        const net = typeof netInfoStr === 'string' ? JSON.parse(netInfoStr) : netInfoStr;
        if (net.wifi_rssi !== undefined) {
          this.setCapabilityValue('measure_wifi_signal', Number(net.wifi_rssi)).catch(this.error);
        }
        if (net.ssid) {
          this.setCapabilityValue('wifi_network', String(net.ssid)).catch(this.error);
        }
        if (net.mileage !== undefined) {
          this.setCapabilityValue('meter_mileage', Number(net.mileage)).catch(this.error);
        }
        if (net.work_time) {
          this.setCapabilityValue('meter_work_time', String(net.work_time)).catch(this.error);
        }
      } catch (e) { /* ignore parse errors */ }
    }

    // Device other info (JSON string)
    const otherStr = val(props.deviceOtherInfo);
    if (otherStr) {
      try {
        const other = typeof otherStr === 'string' ? JSON.parse(otherStr) : otherStr;
        if (other.socTmp !== undefined) {
          this.setCapabilityValue('measure_temperature', Number(other.socTmp)).catch(this.error);
        }
        if (other.rtk_status !== undefined) {
          const rtkMap = { 0: 'No signal', 1: 'Single', 2: 'DGPS', 3: 'PPS', 4: 'RTK Fix', 5: 'RTK Float' };
          this.setCapabilityValue('alarm_rtk', rtkMap[other.rtk_status] || `Status ${other.rtk_status}`).catch(this.error);
        }
        if (other.task_area !== undefined) {
          this.setCapabilityValue('meter_task_area', Math.round(Number(other.task_area))).catch(this.error);
        }
      } catch (e) { /* ignore parse errors */ }
    }
  }

  // ── Commands ────────────────────────────────────────────

  async _sendCommand(commandBuilder) {
    const data = this.getData();
    const cmd = commandBuilder();

    // Try MQTT Direct publish
    if (this.mqttDirect && this.mqttDirect.isConnected && data.productKey && data.deviceName) {
      await this.mqttDirect.sendCommand(data.productKey, data.deviceName, cmd);
      await this.mqttDirect.sendRawCommand(data.productKey, data.deviceName, cmd);
      return;
    }

    throw new Error('MQTT not connected - cannot send command');
  }

  async startMowing() {
    this.log('Starting mowing');
    await this._sendCommand(() => this.api._protobuf.startJob());
  }

  async stopMowing() {
    this.log('Stopping mowing');
    await this._sendCommand(() => this.api._protobuf.cancelJob());
  }

  async pauseMowing() {
    this.log('Pausing mowing');
    await this._sendCommand(() => this.api._protobuf.pauseTask());
  }

  async returnToDock() {
    this.log('Returning to dock');
    await this._sendCommand(() => this.api._protobuf.returnToDock());
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

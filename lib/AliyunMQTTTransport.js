'use strict';

const EventEmitter = require('events');
const crypto = require('crypto');
const mqtt = require('mqtt');

/**
 * Aliyun IoT MQTT Transport - connects to Aliyun MQTT broker,
 * sends bind message, subscribes to device topics.
 * 
 * After binding, commands are sent via HTTP send_cloud_command
 * (the bind may help with rate limiting).
 */
class AliyunMQTTTransport extends EventEmitter {

  /**
   * @param {object} config
   * @param {string} config.productKey - From aepHandle response
   * @param {string} config.deviceName - From aepHandle response  
   * @param {string} config.deviceSecret - From aepHandle response
   * @param {string} config.regionId - e.g. 'eu'
   * @param {string} config.iotToken - From sessionByAuthCode
   * @param {string} config.clientIdBase - Unique client identifier
   */
  constructor(config) {
    super();
    this.config = config;
    this.client = null;
    this._connected = false;
  }

  _buildCredentials() {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const base = this.config.clientIdBase;
    
    const clientId = `${base}|securemode=2,signmethod=hmacsha1,ext=1,_ss=1,timestamp=${timestamp}|`;
    
    const signContent = 
      `clientId${base}` +
      `deviceName${this.config.deviceName}` +
      `productKey${this.config.productKey}` +
      `timestamp${timestamp}`;
    
    const password = crypto.createHmac('sha1', this.config.deviceSecret)
      .update(signContent)
      .digest('hex');

    return { clientId, password };
  }

  connect() {
    const { clientId, password } = this._buildCredentials();
    const host = `${this.config.productKey}.iot-as-mqtt.${this.config.regionId}.aliyuncs.com`;
    const url = `mqtts://${host}:8883`;

    console.log(`AliyunMQTT: connecting to ${host} as ${this.config.deviceName}`);

    this.client = mqtt.connect(url, {
      clientId,
      username: `${this.config.deviceName}&${this.config.productKey}`,
      password,
      clean: true,
      connectTimeout: 15000,
      reconnectPeriod: 30000,
      protocolVersion: 4,
      rejectUnauthorized: false,
    });

    this.client.on('connect', () => {
      console.log('AliyunMQTT: connected!');
      this._connected = true;
      this.emit('connected');
      this._subscribe();
      this._sendBind();
    });

    this.client.on('message', (topic, message) => {
      const topicStr = String(topic);
      if (topicStr.endsWith('/account/bind_reply')) {
        try {
          const data = JSON.parse(message.toString());
          console.log('AliyunMQTT bind reply:', JSON.stringify(data));
          if (data.code === 200) {
            console.log('AliyunMQTT: bind successful!');
            this.emit('bound');
          } else {
            console.log('AliyunMQTT: bind failed, code:', data.code);
          }
        } catch (e) {
          console.log('AliyunMQTT bind reply (raw):', message.toString().substring(0, 200));
        }
      } else if (topicStr.endsWith('/thing/status')) {
        this.emit('status', message);
      } else if (topicStr.endsWith('/thing/events') || topicStr.endsWith('/thing/properties')) {
        this.emit('properties', message);
      } else if (topicStr.includes('/thing/model/down_raw')) {
        // Protobuf response from device
        this.emit('device_response', message);
      } else {
        console.log(`AliyunMQTT message [${topicStr}]:`, message.toString().substring(0, 100));
      }
    });

    this.client.on('error', (err) => {
      console.log('AliyunMQTT error:', err.message, err.code || '');
      this.emit('error', err);
    });

    this.client.on('close', () => {
      console.log('AliyunMQTT: disconnected (was connected:', this._connected, ')');
      this._connected = false;
      this.emit('disconnected');
    });

    return this;
  }

  _subscribe() {
    const pk = this.config.productKey;
    const dn = this.config.deviceName;
    const base = `/sys/${pk}/${dn}`;

    const topics = [
      `${base}/app/down/account/bind_reply`,
      `${base}/app/down/thing/event/property/post_reply`,
      `${base}/app/down/thing/wifi/status/notify`,
      `${base}/app/down/thing/wifi/connect/event/notify`,
      `${base}/app/down/_thing/event/notify`,
      `${base}/app/down/thing/events`,
      `${base}/app/down/thing/status`,
      `${base}/app/down/thing/properties`,
      `${base}/app/down/thing/model/down_raw`,
    ];

    for (const topic of topics) {
      this.client.subscribe(topic, { qos: 1 }, (err) => {
        if (err) console.log(`AliyunMQTT subscribe error [${topic}]:`, err.message);
      });
    }
    console.log(`AliyunMQTT: subscribed to ${topics.length} topics`);
  }

  _sendBind() {
    const pk = this.config.productKey;
    const dn = this.config.deviceName;
    const bindTopic = `/sys/${pk}/${dn}/app/up/account/bind`;

    const bindMsg = JSON.stringify({
      id: 'msgid1',
      version: '1.0',
      request: { clientId: `${dn}&${pk}` },
      params: { iotToken: this.config.iotToken },
    });

    console.log(`AliyunMQTT: sending bind on ${bindTopic}`);
    this.client.publish(bindTopic, bindMsg, { qos: 1 }, (err) => {
      if (err) console.log('AliyunMQTT bind publish error:', err.message);
      else console.log('AliyunMQTT: bind message sent');
    });
  }

  disconnect() {
    if (this.client) {
      this.client.end(true);
      this.client = null;
      this._connected = false;
    }
  }

  get isConnected() {
    return this._connected;
  }

}

module.exports = AliyunMQTTTransport;

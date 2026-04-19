'use strict';

const EventEmitter = require('events');
const mqtt = require('mqtt');

/**
 * Direct MQTT connection to Mammotion broker for sending commands.
 * Uses the JWT credentials from /v1/mqtt/auth/jwt.
 */
class MammotionMQTTDirect extends EventEmitter {

  constructor({ host, jwt, clientId, username }) {
    super();
    // Parse host (mqtts://mqtt-eu.mammotion.com:3083)
    this.host = host;
    this.jwt = jwt;
    this.clientId = clientId;
    this.username = username;
    this.client = null;
    this._connected = false;
  }

  connect() {
    const url = this.host; // mqtts://mqtt-eu.mammotion.com:3083

    // Use exact clientId from JWT (broker validates it)
    console.log(`MQTT Direct: connecting to ${url} as ${this.clientId}`);

    this.client = mqtt.connect(url, {
      clientId: this.clientId,
      username: this.username,
      password: this.jwt,
      clean: true,
      connectTimeout: 15000,
      reconnectPeriod: 0, // Don't auto-reconnect (avoid loop)
      protocolVersion: 4, // MQTT 3.1.1
      rejectUnauthorized: false, // Accept self-signed certs
    });

    this.client.on('connect', () => {
      console.log('MQTT Direct: connected!');
      this._connected = true;
      this.emit('connected');
    });

    this.client.on('message', (topic, message) => {
      console.log(`MQTT Direct message on ${topic}:`, message.toString().substring(0, 200));
      this.emit('message', { topic, payload: message });
    });

    this.client.on('error', (err) => {
      console.log('MQTT Direct error:', err.message);
      this.emit('error', err);
    });

    this.client.on('close', () => {
      console.log('MQTT Direct: disconnected');
      this._connected = false;
      this.emit('disconnected');
    });

    return this;
  }

  /**
   * Subscribe to device status/event topics.
   */
  subscribeDevice(productKey, deviceName) {
    if (!this.client || !this._connected) return;

    const topics = [
      `/sys/${productKey}/${deviceName}/thing/event/+/post`,
      `/sys/proto/${productKey}/${deviceName}/thing/event/+/post`,
      `/sys/${productKey}/${deviceName}/app/down/thing/status`,
      `/sys/${productKey}/${deviceName}/app/down/#`,
    ];

    for (const topic of topics) {
      this.client.subscribe(topic, { qos: 1 }, (err) => {
        if (err) console.log(`MQTT subscribe error for ${topic}:`, err.message);
        else console.log(`MQTT subscribed to ${topic}`);
      });
    }
  }

  /**
   * Send a protobuf command via MQTT publish.
   * Try multiple topic patterns to find the one that works.
   */
  async sendCommand(productKey, deviceName, protobufBytes) {
    if (!this.client || !this._connected) {
      throw new Error('MQTT not connected');
    }

    // Wrap protobuf in JSON envelope (like Aliyun IoT expects)
    const content = protobufBytes.toString('base64');
    const payload = JSON.stringify({
      id: String(Date.now()),
      version: '1.0',
      params: {
        args: { content },
        identifier: 'device_protobuf_sync_service',
      },
    });

    // Try the app/up service topic (most likely for app→device commands)
    const topic = `/sys/${productKey}/${deviceName}/app/up/thing/service`;
    console.log(`MQTT publish to ${topic}`);

    return new Promise((resolve, reject) => {
      this.client.publish(topic, payload, { qos: 1 }, (err) => {
        if (err) {
          console.log('MQTT publish error:', err.message);
          reject(err);
        } else {
          console.log('MQTT publish OK');
          resolve(true);
        }
      });
    });
  }

  /**
   * Send raw protobuf bytes on the proto topic.
   */
  async sendRawCommand(productKey, deviceName, protobufBytes) {
    if (!this.client || !this._connected) {
      throw new Error('MQTT not connected');
    }

    const topic = `/sys/proto/${productKey}/${deviceName}/app/up/thing/service`;
    console.log(`MQTT raw publish to ${topic} (${protobufBytes.length} bytes)`);

    return new Promise((resolve, reject) => {
      this.client.publish(topic, protobufBytes, { qos: 1 }, (err) => {
        if (err) reject(err);
        else {
          console.log('MQTT raw publish OK');
          resolve(true);
        }
      });
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

module.exports = MammotionMQTTDirect;

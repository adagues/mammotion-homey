'use strict';

const EventEmitter = require('events');
const crypto = require('crypto');
const mqtt = require('mqtt');
const { APP_KEY, APP_SECRET } = require('./constants');

/**
 * MQTT client for Aliyun IoT platform.
 * V1: subscribes to device status topics and emits events.
 * V2 will add protobuf command sending.
 */
class MammotionMQTT extends EventEmitter {

  constructor({ mqttEndpoint, iotToken, identityId }) {
    super();
    this.mqttEndpoint = mqttEndpoint || 'public.itls.eu.aliyuncs.com';
    this.iotToken = iotToken;
    this.identityId = identityId;
    this.client = null;
    this._subscribedDevices = new Set();
  }

  connect() {
    const timestamp = String(Date.now());
    const clientId = `${this.identityId}|securemode=2,signmethod=hmacsha256,timestamp=${timestamp}|`;

    // Sign: hmacsha256(APP_SECRET, "clientId{identityId}timestamp{timestamp}")
    const signContent = `clientId${this.identityId}timestamp${timestamp}`;
    const sign = crypto.createHmac('sha256', APP_SECRET).update(signContent).digest('hex');

    const url = `mqtt://${this.mqttEndpoint}:1883`;

    this.client = mqtt.connect(url, {
      clientId,
      username: `${this.identityId}&${APP_KEY}`,
      password: sign,
      clean: true,
      connectTimeout: 10000,
      reconnectPeriod: 5000,
    });

    this.client.on('connect', () => {
      this.emit('connected');
      // Re-subscribe to all watched devices
      for (const iotId of this._subscribedDevices) {
        this._subscribeDevice(iotId);
      }
    });

    this.client.on('message', (topic, message) => {
      try {
        const payload = JSON.parse(message.toString());
        this.emit('device_message', { topic, payload });

        // Extract iotId from topic if possible
        const match = topic.match(/\/thing\/([^/]+)\//);
        if (match) {
          this.emit(`device:${match[1]}`, payload);
        }
      } catch (err) {
        this.emit('raw_message', { topic, message: message.toString() });
      }
    });

    this.client.on('error', (err) => {
      this.emit('error', err);
    });

    this.client.on('close', () => {
      this.emit('disconnected');
    });

    return this;
  }

  subscribeDevice(iotId) {
    this._subscribedDevices.add(iotId);
    if (this.client && this.client.connected) {
      this._subscribeDevice(iotId);
    }
  }

  _subscribeDevice(iotId) {
    const topics = [
      `/sys/${iotId}/thing/property/post`,
      `/sys/${iotId}/thing/event/post`,
      `/sys/${iotId}/thing/service/invoke`,
    ];
    for (const topic of topics) {
      this.client.subscribe(topic, { qos: 0 });
    }
  }

  disconnect() {
    if (this.client) {
      this.client.end(true);
      this.client = null;
    }
    this._subscribedDevices.clear();
  }

}

module.exports = MammotionMQTT;

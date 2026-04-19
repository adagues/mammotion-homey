'use strict';

const crypto = require('crypto');
const fetch = require('node-fetch');
const {
  APP_KEY,
  APP_SECRET,
  APP_VERSION,
  ALIYUN_DOMAIN,
  MAMMOTION_DOMAIN,
  MAMMOTION_CLIENT_ID,
  MAMMOTION_CLIENT_SECRET,
  MAMMOTION_OAUTH2_CLIENT_ID,
  MAMMOTION_OAUTH2_CLIENT_SECRET,
} = require('./constants');

class MammotionAPI {

  constructor() {
    this.accessToken = null;
    this.refreshTokenValue = null;
    this.iotToken = null;
    this.identityId = null;
    this.regionInfo = null;
    this.apiGatewayEndpoint = null;
    this.mqttEndpoint = null;
  }

  // ── Helpers ──────────────────────────────────────────────

  _md5(str) {
    return crypto.createHash('md5').update(str).digest('hex');
  }

  _hmacSha256(key, data) {
    return crypto.createHmac('sha256', key).update(data).digest('hex');
  }

  _generateSign(clientId, timestamp, path, body, clientSecret) {
    const content = `${clientId}${timestamp}${path}${JSON.stringify(body)}`;
    const key = this._md5(clientSecret);
    return this._hmacSha256(key, content);
  }

  _aliyunSign(params) {
    // Sign Aliyun IoT API gateway requests
    const sorted = Object.keys(params).sort();
    const signContent = sorted.map(k => `${k}${params[k]}`).join('');
    return this._hmacSha256(APP_SECRET, signContent).toUpperCase();
  }

  async _aliyunRequest(apiPath, params = {}, version = '1.0') {
    const endpoint = this.apiGatewayEndpoint || `https://${ALIYUN_DOMAIN}`;
    const url = `${endpoint}/app${apiPath}`;
    const timestamp = Date.now();

    const baseParams = {
      id: String(timestamp),
      version,
      request: JSON.stringify(params),
      params: JSON.stringify(params),
    };

    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'x-ca-key': APP_KEY,
      'x-ca-timestamp': String(timestamp),
      'x-ca-nonce': crypto.randomUUID(),
      'x-ca-signaturemethod': 'HmacSHA256',
    };

    if (this.iotToken) {
      headers['x-iot-token'] = this.iotToken;
    }

    // Build canonical string for Aliyun API gateway signing
    const bodyStr = new URLSearchParams(baseParams).toString();

    // Simple signing: sign the body params with APP_SECRET
    const signStr = `POST\napplication/json;charset=utf-8\n\n\n${url}\n`;
    const hmac = crypto.createHmac('sha256', APP_SECRET);
    hmac.update(bodyStr);
    headers['x-ca-signature'] = hmac.digest('base64');

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Accept: 'application/json',
      },
      body: bodyStr,
    });

    const data = await resp.json();
    if (data.code !== 200 && data.code !== undefined) {
      throw new Error(`Aliyun API ${apiPath} failed: ${data.message || JSON.stringify(data)}`);
    }
    return data;
  }

  // ── Step 1: OAuth2 Login ─────────────────────────────────

  async login(email, password) {
    const timestamp = Date.now();
    const path = '/oauth/token';
    const body = {
      grant_type: 'password',
      client_id: MAMMOTION_OAUTH2_CLIENT_ID,
      username: email,
      password,
      redirect_uri: 'https://localhost',
      client_secret: MAMMOTION_OAUTH2_CLIENT_SECRET,
    };

    const sign = this._generateSign(
      MAMMOTION_OAUTH2_CLIENT_ID,
      timestamp,
      path,
      body,
      MAMMOTION_OAUTH2_CLIENT_SECRET,
    );

    const resp = await fetch(`${MAMMOTION_DOMAIN}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'okhttp/4.9.3',
        'App-Version': `ALIYUN DEMO,${APP_VERSION}`,
        Authorization: `Sign ${sign}`,
        'x-timestamp': String(timestamp),
        'x-client-id': MAMMOTION_OAUTH2_CLIENT_ID,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Login failed (${resp.status}): ${text}`);
    }

    const data = await resp.json();
    if (!data.access_token) {
      throw new Error(`Login failed: ${JSON.stringify(data)}`);
    }

    this.accessToken = data.access_token;
    this.refreshTokenValue = data.refresh_token;
    this._email = email;
    this._password = password;

    // Continue the full auth chain
    await this._completeAuth();

    return data;
  }

  async _completeAuth() {
    const authCode = await this.getAuthorizationCode();
    await this.getRegion();
    await this.createSession(authCode);
  }

  // ── Step 2: Get Authorization Code ──────────────────────

  async getAuthorizationCode() {
    const resp = await fetch(`${MAMMOTION_DOMAIN}/authorization/code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
        'User-Agent': 'okhttp/4.9.3',
      },
      body: JSON.stringify({ clientId: MAMMOTION_CLIENT_ID }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Get auth code failed (${resp.status}): ${text}`);
    }

    const data = await resp.json();
    if (!data.data && !data.authorization_code) {
      throw new Error(`Auth code response unexpected: ${JSON.stringify(data)}`);
    }

    return data.data || data.authorization_code;
  }

  // ── Step 3: Get Region ──────────────────────────────────

  async getRegion(countryCode = 'EU') {
    const data = await this._aliyunRequest('/living/account/region/get', {
      countryCode,
    });

    if (data.data) {
      this.regionInfo = data.data;
      this.mqttEndpoint = data.data.mqttEndpoint || `public.itls.eu.aliyuncs.com`;
      if (data.data.apiGatewayEndpoint) {
        this.apiGatewayEndpoint = data.data.apiGatewayEndpoint;
      }
    }

    return this.regionInfo;
  }

  // ── Step 4: Create Session ──────────────────────────────

  async createSession(authCode) {
    const data = await this._aliyunRequest('/account/createSessionByAuthCode', {
      authCode,
      clientId: MAMMOTION_CLIENT_ID,
      clientSecret: MAMMOTION_CLIENT_SECRET,
    });

    if (data.data) {
      this.iotToken = data.data.iotToken;
      this.identityId = data.data.identityId;
    }

    return data.data;
  }

  // ── Step 5: List Devices ────────────────────────────────

  async listDevices() {
    const data = await this._aliyunRequest('/uc/listBindingByAccount', {
      pageNo: 1,
      pageSize: 100,
    });

    if (!data.data || !data.data.data) {
      return [];
    }

    return data.data.data.map(d => ({
      iotId: d.iotId,
      deviceName: d.deviceName,
      productKey: d.productKey,
      nickName: d.nickName || d.deviceName,
      status: d.status, // 1=online, 0=offline
    }));
  }

  // ── Device Status ───────────────────────────────────────

  async getDeviceProperties(iotId) {
    const data = await this._aliyunRequest('/cloud/thing/properties/get', {
      iotId,
      propertyKeys: JSON.stringify([
        'battery_level',
        'device_state',
        'work_mode',
        'blade_height',
        'error_code',
        'charging_state',
        'speed',
      ]),
    });

    return data.data || {};
  }

  // ── Device Commands ─────────────────────────────────────

  async invokeDeviceService(iotId, service, params = {}) {
    const data = await this._aliyunRequest('/cloud/thing/service/invoke', {
      iotId,
      identifier: service,
      args: JSON.stringify(params),
    });

    return data.data || {};
  }

  async setDeviceProperty(iotId, properties) {
    const data = await this._aliyunRequest('/cloud/thing/properties/set', {
      iotId,
      items: JSON.stringify(properties),
    });

    return data.data || {};
  }

  // ── Convenience Commands ────────────────────────────────

  async startMowing(iotId) {
    return this.invokeDeviceService(iotId, 'start_mowing', { main_ctrl: 1 });
  }

  async stopMowing(iotId) {
    return this.invokeDeviceService(iotId, 'stop_mowing', { main_ctrl: 0 });
  }

  async pauseMowing(iotId) {
    return this.invokeDeviceService(iotId, 'pause_mowing', {});
  }

  async returnToDock(iotId) {
    return this.invokeDeviceService(iotId, 'return_to_charge', {});
  }

  // ── Token Refresh ───────────────────────────────────────

  async refreshToken() {
    if (!this.refreshTokenValue) {
      if (this._email && this._password) {
        return this.login(this._email, this._password);
      }
      throw new Error('No refresh token available');
    }

    const resp = await fetch(`${MAMMOTION_DOMAIN}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'okhttp/4.9.3',
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: MAMMOTION_OAUTH2_CLIENT_ID,
        client_secret: MAMMOTION_OAUTH2_CLIENT_SECRET,
        refresh_token: this.refreshTokenValue,
      }),
    });

    if (!resp.ok) {
      // Fallback to full re-login
      if (this._email && this._password) {
        return this.login(this._email, this._password);
      }
      throw new Error(`Token refresh failed: ${resp.status}`);
    }

    const data = await resp.json();
    this.accessToken = data.access_token;
    if (data.refresh_token) {
      this.refreshTokenValue = data.refresh_token;
    }

    await this._completeAuth();
    return data;
  }

  // ── Serialization for device store ──────────────────────

  getCredentials() {
    return {
      email: this._email,
      password: this._password,
    };
  }

}

module.exports = MammotionAPI;

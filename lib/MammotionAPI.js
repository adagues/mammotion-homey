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
    this.login_info = null;
    this._headers = {
      'User-Agent': 'okhttp/4.9.3',
      'App-Version': `ALIYUN DEMO,${APP_VERSION}`,
    };
    // Generate a unique client_id like PyMammotion does
    const rand7 = Array.from({ length: 7 }, () => Math.floor(Math.random() * 10)).join('');
    this.clientId = `${Date.now()}_${rand7}_1`;
  }

  // ── Helpers ──────────────────────────────────────────────

  _md5(str) {
    return crypto.createHash('md5').update(str).digest('hex');
  }

  _hmacSha256(key, data) {
    return crypto.createHmac('sha256', key).update(data).digest('hex');
  }

  /**
   * Create OAuth signature matching PyMammotion's create_oauth_signature().
   * Signs: clientId + timestamp + tokenEndpoint + compactJSON(loginReq)
   * Key: MD5(clientSecret) as hex string
   */
  _createOAuthSignature(loginReq, clientId, clientSecret, tokenEndpoint) {
    // Compact JSON with no spaces (equivalent to Python separators=(',', ':'))
    const jsonData = JSON.stringify(loginReq);
    const timestamp = String(Date.now());
    const strToSign = `${clientId}${timestamp}${tokenEndpoint}${jsonData}`;
    const hashedSecret = this._md5(clientSecret);
    return this._hmacSha256(hashedSecret, strToSign);
  }

  // ── Step 1: OAuth2 Login (login_v2) ─────────────────────

  async login(email, password) {
    // Password must be base64 encoded
    const encodedPassword = Buffer.from(password).toString('base64');

    const loginRequest = {
      username: email,
      password: encodedPassword,
      client_id: MAMMOTION_OAUTH2_CLIENT_ID,
      grant_type: 'password',
      authType: '0',
    };

    const oauthSignature = this._createOAuthSignature(
      loginRequest,
      MAMMOTION_OAUTH2_CLIENT_ID,
      MAMMOTION_OAUTH2_CLIENT_SECRET,
      '/oauth2/token',
    );

    // Build query string from loginRequest params
    const params = new URLSearchParams(loginRequest).toString();

    const resp = await fetch(`${MAMMOTION_DOMAIN}/oauth2/token?${params}`, {
      method: 'POST',
      headers: {
        ...this._headers,
        'Ma-App-Key': MAMMOTION_OAUTH2_CLIENT_ID,
        'Ma-Signature': oauthSignature,
        'Ma-Timestamp': String(Math.floor(Date.now() / 1000)),
        'Client-Id': this.clientId,
        'Client-Type': '1',
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Login failed (${resp.status}): ${text}`);
    }

    const data = await resp.json();

    if (data.code !== 0) {
      throw new Error(`Login failed: ${data.msg || JSON.stringify(data)}`);
    }

    if (!data.data || !data.data.access_token) {
      throw new Error(`Login failed: unexpected response: ${JSON.stringify(data)}`);
    }

    this.login_info = data.data;
    this.accessToken = data.data.access_token;
    this.refreshTokenValue = data.data.refresh_token;
    this._headers['Authorization'] = `Bearer ${this.accessToken}`;
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
        ...this._headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ clientId: MAMMOTION_CLIENT_ID }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Get auth code failed (${resp.status}): ${text}`);
    }

    const data = await resp.json();

    // The response wraps in data.data.code or data.data.accessToken
    if (data.data && data.data.code) {
      // Also update accessToken if returned
      if (data.data.accessToken) {
        this.accessToken = data.data.accessToken;
        this._headers['Authorization'] = `Bearer ${this.accessToken}`;
      }
      return data.data.code;
    }

    throw new Error(`Auth code response unexpected: ${JSON.stringify(data)}`);
  }

  // ── Step 3: Get Region ──────────────────────────────────

  async getRegion(countryCode = 'EU') {
    try {
      const data = await this._aliyunRequest('/living/account/region/get', {
        authCode: this._lastAuthCode || '',
        type: 'THIRD_AUTHCODE',
        countryCode,
      }, '1.0.2');

      if (data.data) {
        this.regionInfo = data.data;
        this.mqttEndpoint = data.data.mqttEndpoint || 'public.itls.eu.aliyuncs.com';
        if (data.data.apiGatewayEndpoint) {
          this.apiGatewayEndpoint = `https://${data.data.apiGatewayEndpoint}`;
        }
      }
    } catch (err) {
      // Fallback to EU region defaults
      this.regionInfo = { shortRegionId: 'EU' };
      this.mqttEndpoint = 'public.itls.eu.aliyuncs.com';
      this.apiGatewayEndpoint = `https://eu.api-iot.aliyuncs.com`;
    }

    return this.regionInfo;
  }

  // ── Step 4: Create Session ──────────────────────────────

  async createSession(authCode) {
    this._lastAuthCode = authCode;

    const data = await this._aliyunRequest('/account/createSessionByAuthCode', {
      authCode,
    });

    if (data.data) {
      this.iotToken = data.data.iotToken;
      this.identityId = data.data.identityId;
    }

    return data.data;
  }

  // ── Aliyun IoT API Gateway ──────────────────────────────

  async _aliyunRequest(apiPath, params = {}, apiVer = '1.0') {
    const endpoint = this.apiGatewayEndpoint || `https://${ALIYUN_DOMAIN}`;
    const url = `${endpoint}${apiPath}`;
    const timestamp = Date.now();

    const body = {
      id: String(timestamp),
      version: '1.0',
      request: { apiVer },
      params,
    };

    const bodyStr = JSON.stringify(body);

    // Aliyun IoT API Gateway signing
    const headers = {
      'Content-Type': 'application/json;charset=UTF-8',
      Accept: 'application/json',
      'x-ca-key': APP_KEY,
      'x-ca-timestamp': String(timestamp),
      'x-ca-nonce': crypto.randomUUID(),
      'x-ca-signaturemethod': 'HmacSHA256',
    };

    if (this.iotToken) {
      headers['x-iot-token'] = this.iotToken;
    }

    // Build canonical string for signing
    const signHeaders = ['x-ca-key', 'x-ca-nonce', 'x-ca-signaturemethod', 'x-ca-timestamp'];
    if (this.iotToken) signHeaders.push('x-iot-token');
    signHeaders.sort();

    const signHeaderStr = signHeaders.map(h => `${h}:${headers[h]}`).join('\n');
    const contentMd5 = crypto.createHash('md5').update(bodyStr).digest('base64');

    const stringToSign = [
      'POST',
      'application/json',
      contentMd5,
      'application/json;charset=UTF-8',
      '',
      signHeaderStr,
      apiPath,
    ].join('\n');

    headers['x-ca-signature'] = crypto.createHmac('sha256', APP_SECRET).update(stringToSign).digest('base64');
    headers['x-ca-signature-headers'] = signHeaders.join(',');
    headers['Content-MD5'] = contentMd5;

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyStr,
    });

    const data = await resp.json();
    if (data.code !== undefined && data.code !== 200) {
      throw new Error(`Aliyun API ${apiPath} failed: code=${data.code}, msg=${data.message || JSON.stringify(data)}`);
    }
    return data;
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
      status: d.status,
    }));
  }

  // ── Device Status ───────────────────────────────────────

  async getDeviceProperties(iotId) {
    const data = await this._aliyunRequest('/cloud/thing/properties/get', {
      iotId,
      propertyKeys: [
        'battery_level',
        'device_state',
        'work_mode',
        'blade_height',
        'error_code',
        'charging_state',
        'speed',
      ],
    });

    return data.data || {};
  }

  // ── Device Commands ─────────────────────────────────────

  async invokeDeviceService(iotId, service, params = {}) {
    const data = await this._aliyunRequest('/cloud/thing/service/invoke', {
      iotId,
      identifier: service,
      args: params,
    });

    return data.data || {};
  }

  async setDeviceProperty(iotId, properties) {
    const data = await this._aliyunRequest('/cloud/thing/properties/set', {
      iotId,
      items: properties,
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
    if (this._email && this._password) {
      return this.login(this._email, this._password);
    }
    throw new Error('No credentials available for token refresh');
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

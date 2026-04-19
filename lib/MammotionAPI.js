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

const ProtobufBuilder = require('./ProtobufBuilder');

// Headers to exclude from Aliyun signing (matching PyMammotion MOVE_HEADERS)
const MOVE_HEADERS = [
  'x-ca-signature', 'x-ca-signature-headers', 'accept',
  'content-md5', 'content-type', 'date', 'host', 'token', 'user-agent',
];

class MammotionAPI {

  constructor() {
    this.accessToken = null;
    this.authorizationCode = null;
    this.iotToken = null;
    this.identityId = null;
    this.regionInfo = null;
    this.apiGatewayEndpoint = null;
    this.oaApiGatewayEndpoint = null;
    this.mqttEndpoint = null;
    this.login_info = null;
    this.connectResponse = null;
    this.loginByOAuthResponse = null;
    this._headers = {
      'User-Agent': 'okhttp/4.9.3',
      'App-Version': `ALIYUN DEMO,${APP_VERSION}`,
    };
    this._protobuf = new ProtobufBuilder();
    this._lastRequestTime = 0; // Rate limit tracking
    // Generate unique identifiers (matching PyMammotion)
    const rand7 = Array.from({ length: 7 }, () => Math.floor(Math.random() * 10)).join('');
    this.mammotionClientId = `${Date.now()}_${rand7}_1`;
    // Hardware-like identifiers
    this._clientId = this._generateHardwareString(8);
    this._deviceSn = this._generateHardwareString(32);
    this._utdid = this._generateHardwareString(32);
  }

  // ── Helpers ──────────────────────────────────────────────

  _generateHardwareString(length) {
    const hash = crypto.createHash('sha1').update(String(Date.now() + Math.random())).digest('hex');
    let result = '';
    while (result.length < length) result += hash;
    return result.substring(0, length);
  }

  _md5Hex(str) {
    return crypto.createHash('md5').update(str).digest('hex');
  }

  _md5Base64(str) {
    return crypto.createHash('md5').update(str).digest('base64');
  }

  _hmacSha256Hex(key, data) {
    return crypto.createHmac('sha256', key).update(data).digest('hex');
  }

  _hmacSha256Base64(key, data) {
    return crypto.createHmac('sha256', key).update(data).digest('base64');
  }

  _getDateUTCString() {
    return new Date().toUTCString();
  }

  _getNonce() {
    return crypto.randomUUID();
  }

  /**
   * Create OAuth signature for Mammotion login (matching PyMammotion create_oauth_signature)
   */
  _createOAuthSignature(loginReq, clientId, clientSecret, tokenEndpoint) {
    const jsonData = JSON.stringify(loginReq);
    const timestamp = String(Date.now());
    const strToSign = `${clientId}${timestamp}${tokenEndpoint}${jsonData}`;
    const hashedSecret = this._md5Hex(clientSecret);
    return this._hmacSha256Hex(hashedSecret, strToSign);
  }

  /**
   * Aliyun IoT API Gateway signature (matching APIGatewayUtilClient.get_signature)
   */
  _aliyunSign(method, headers, pathname, body) {
    const accept = headers['accept'] || '';
    const contentMd5 = headers['content-md5'] || '';
    const contentType = headers['content-type'] || '';
    const date = headers['date'] || '';

    // Get sign headers (exclude MOVE_HEADERS)
    const dic = { ...headers };
    for (const key of MOVE_HEADERS) {
      delete dic[key];
    }
    const keys = Object.keys(dic).sort();
    const signHeaders = keys.join(',');
    const header = keys.map(k => `${k}:${dic[k] || ''}`).join('\n');

    headers['x-ca-signature-headers'] = signHeaders;

    const stringToSign = `${method}\n${accept}\n${contentMd5}\n${contentType}\n${date}\n${header}\n${pathname}`;
    return this._hmacSha256Base64(APP_SECRET, stringToSign);
  }

  /**
   * Make a signed request to the Aliyun IoT API Gateway
   * (matching the alibabacloud_iot_api_gateway Client)
   */
  async _aliyunIoTRequest(domain, apiPath, params = {}, apiVer = '1.0', iotToken = null, _retryCount = 0) {
    // Enforce minimum 1.5s between requests to avoid 429
    const now = Date.now();
    const elapsed = now - this._lastRequestTime;
    if (elapsed < 500) {
      await new Promise(r => setTimeout(r, 500 - elapsed));
    }
    this._lastRequestTime = Date.now();
    const body = {
      id: this._getNonce(),
      version: '1.0',
      request: { apiVer, language: 'en-US' },
      params,
    };

    if (iotToken) {
      body.request.iotToken = iotToken;
    }

    const bodyStr = JSON.stringify(body);
    const contentMd5 = this._md5Base64(bodyStr);

    const headers = {
      'host': domain,
      'date': this._getDateUTCString(),
      'x-ca-nonce': this._getNonce(),
      'x-ca-key': APP_KEY,
      'x-ca-signaturemethod': 'HmacSHA256',
      'accept': 'application/json',
      'content-type': 'application/octet-stream',
      'content-md5': contentMd5,
      'user-agent': 'Chinese/Chinese homey-mammotion',
    };

    headers['x-ca-signature'] = this._aliyunSign('POST', headers, apiPath, bodyStr);

    const url = `https://${domain}${apiPath}`;

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyStr,
    });

    // Handle rate limiting - max 3 retries with aggressive backoff
    if (resp.status === 429) {
      if (_retryCount >= 3) {
        throw new Error(`Aliyun API ${apiPath}: rate limited after ${_retryCount + 1} attempts`);
      }
      const delays = [15000, 30000, 60000]; // 15s, 30s, 60s
      const delay = delays[_retryCount] || 60000;
      console.log(`Aliyun API ${apiPath}: rate limited (429), retry ${_retryCount + 1}/3 in ${delay/1000}s...`);
      await new Promise(r => setTimeout(r, delay));
      return this._aliyunIoTRequest(domain, apiPath, params, apiVer, iotToken, _retryCount + 1);
    }

    const text = await resp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // Log the raw response for debugging
      console.log(`Aliyun API ${apiPath} raw response (${resp.status}):`, text.substring(0, 500));
      throw new Error(`Aliyun API ${apiPath} returned non-JSON (${resp.status}): ${text.substring(0, 200)}`);
    }

    if (data.code !== undefined && data.code !== 200) {
      throw new Error(`Aliyun API ${apiPath} failed: code=${data.code}, msg=${data.message || data.msg || JSON.stringify(data)}`);
    }
    return data;
  }

  // ── Step 1: OAuth2 Login (login_v2) ─────────────────────

  async login(email, password) {
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

    const params = new URLSearchParams(loginRequest).toString();

    const resp = await fetch(`${MAMMOTION_DOMAIN}/oauth2/token?${params}`, {
      method: 'POST',
      headers: {
        ...this._headers,
        'Ma-App-Key': MAMMOTION_OAUTH2_CLIENT_ID,
        'Ma-Signature': oauthSignature,
        'Ma-Timestamp': String(Math.floor(Date.now() / 1000)),
        'Client-Id': this.mammotionClientId,
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
      throw new Error(`Login failed: no access_token in response`);
    }

    this.login_info = data.data;
    this.accessToken = data.data.access_token;
    this.authorizationCode = data.data.authorization_code;
    this._headers['Authorization'] = `Bearer ${this.accessToken}`;
    this._email = email;
    this._password = password;

    // Full auth chain
    await this._completeAuth();
    return data;
  }

  async _completeAuth() {
    // Step 2: Get authorization code (for Aliyun IoT)
    await this.getAuthorizationCode();
    // Step 3: Get region
    await this.getRegion();
    // Steps 4-7: Aliyun IoT session (needed for device properties)
    // Run in parallel where possible to reduce total time
    try {
      await this.connectOpenAccount();
      await this.loginByOAuth();
      await Promise.all([
        this.aepHandle(),
        this.sessionByAuthCode(),
      ]);
    } catch (err) {
      console.log('Aliyun IoT session setup partial failure:', err.message);
      // Properties won't work but commands via mqtt_invoke still can
    }
    // Get MQTT credentials for command sending
    await this._getMqttCredentials();
  }

  async _getMqttCredentials() {
    const iotEndpoint = this._getIotEndpoint();
    if (!iotEndpoint) return;
    try {
      const resp = await fetch(iotEndpoint + '/v1/mqtt/auth/jwt', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + this.accessToken,
          'Content-Type': 'application/json',
          'User-Agent': 'okhttp/4.9.3',
        },
      });
      const data = await resp.json();
      console.log('MQTT credentials:', JSON.stringify(data).substring(0, 300));
      if (data.code === 0 && data.data) {
        this.mqttCredentials = data.data;
      }
    } catch (err) {
      console.log('MQTT credentials failed:', err.message);
    }
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
      throw new Error(`Get auth code failed (${resp.status})`);
    }

    const data = await resp.json();
    if (data.data) {
      if (data.data.accessToken) {
        this.accessToken = data.data.accessToken;
        this._headers['Authorization'] = `Bearer ${this.accessToken}`;
      }
      if (data.data.code) {
        this.authorizationCode = data.data.code;
      }
    }
    return this.authorizationCode;
  }

  // ── Step 3: Get Region ──────────────────────────────────

  async getRegion(countryCode = 'EU') {
    try {
      const data = await this._aliyunIoTRequest(ALIYUN_DOMAIN, '/living/account/region/get', {
        authCode: this.authorizationCode,
        type: 'THIRD_AUTHCODE',
        countryCode,
      }, '1.0.2');

      if (data.data) {
        this.regionInfo = data.data;
        this.mqttEndpoint = data.data.mqttEndpoint || 'public.itls.eu.aliyuncs.com:1883';
        this.oaApiGatewayEndpoint = data.data.oaApiGatewayEndpoint || 'living-account.eu.aliyuncs.com';
        this.apiGatewayEndpoint = data.data.apiGatewayEndpoint || 'eu.api-iot.aliyuncs.com';
      }
    } catch (err) {
      // Fallback to EU defaults
      this.regionInfo = { shortRegionId: 'EU' };
      this.mqttEndpoint = 'public.itls.eu.aliyuncs.com:1883';
      this.oaApiGatewayEndpoint = 'living-account.eu.aliyuncs.com';
      this.apiGatewayEndpoint = 'eu.api-iot.aliyuncs.com';
    }
    return this.regionInfo;
  }

  // ── Step 4: Connect to Open Account ─────────────────────

  async connectOpenAccount() {
    const regionUrl = 'sdk.openaccount.aliyun.com';
    const bodyParam = {
      context: {
        sdkVersion: '3.4.2',
        platformName: 'android',
        netType: 'wifi',
        appKey: APP_KEY,
        yunOSId: '',
        appVersion: APP_VERSION,
        utDid: this._utdid,
        appAuthToken: this._utdid,
        securityToken: this._utdid,
      },
      config: { version: 0, lastModify: 0 },
      device: {
        model: 'sdk_gphone_x86_arm',
        brand: 'goldfish_x86',
        platformVersion: '30',
      },
    };

    const requestStr = JSON.stringify(bodyParam);
    const fullPath = `/api/prd/connect.json?request=${requestStr}`;

    const headers = {
      'host': regionUrl,
      'date': this._getDateUTCString(),
      'x-ca-nonce': this._getNonce(),
      'x-ca-key': APP_KEY,
      'x-ca-signaturemethod': 'HmacSHA256',
      'accept': 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': `Chinese/Chinese homey-mammotion`,
    };

    headers['x-ca-signature'] = this._aliyunSign('POST', headers, fullPath, '');

    const resp = await fetch(`https://${regionUrl}${fullPath}`, {
      method: 'POST',
      headers,
    });

    const data = await resp.json();
    if (resp.ok) {
      this.connectResponse = data;
    }
    return data;
  }

  // ── Step 5: Login by OAuth ──────────────────────────────

  async loginByOAuth(countryCode = 'FR') {
    const regionUrl = this.oaApiGatewayEndpoint;
    const authCode = this.authorizationCode;
    const deviceId = this.connectResponse?.data?.data?.device?.data?.deviceId || this._deviceSn;
    const vid = this.connectResponse?.data?.vid || '';

    const bodyParam = {
      country: countryCode,
      authCode,
      oauthPlateform: 23,
      oauthAppKey: APP_KEY,
      riskControlInfo: {
        appID: 'com.agilexrobotics',
        appAuthToken: '',
        signType: 'RSA',
        sdkVersion: '3.4.2',
        utdid: this._utdid,
        umidToken: this._utdid,
        deviceId,
        USE_OA_PWD_ENCRYPT: 'true',
        USE_H5_NC: 'true',
      },
    };

    const bodyDataStr = JSON.stringify(bodyParam);
    const fullPath = `/api/prd/loginbyoauth.json?loginByOauthRequest=${bodyDataStr}`;

    const headers = {
      'host': regionUrl,
      'date': this._getDateUTCString(),
      'x-ca-nonce': this._getNonce(),
      'x-ca-key': APP_KEY,
      'x-ca-signaturemethod': 'HmacSHA256',
      'accept': 'application/json',
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      'user-agent': `Chinese/Chinese homey-mammotion`,
      'vid': vid,
    };

    headers['x-ca-signature'] = this._aliyunSign('POST', headers, fullPath, '');

    const resp = await fetch(`https://${regionUrl}${fullPath}`, {
      method: 'POST',
      headers,
      body: `loginByOauthRequest=${bodyDataStr}`,
    });

    const data = await resp.json();
    if (resp.ok) {
      this.loginByOAuthResponse = data;
    }
    return data;
  }

  // ── Step 6: AEP Handle ─────────────────────────────────

  async aepHandle() {
    const domain = this.apiGatewayEndpoint;
    const timeNow = String(Date.now() / 1000);

    const dataToSign = {
      appKey: APP_KEY,
      clientId: this._clientId,
      deviceSn: this._deviceSn,
      timestamp: timeNow,
    };

    // Sign: hmacsha1(APP_SECRET, sorted key-value pairs)
    const signContent = ['appKey', 'clientId', 'deviceSn', 'timestamp']
      .map(k => `${k}${dataToSign[k]}`)
      .join('');
    const sign = crypto.createHmac('sha1', APP_SECRET).update(signContent).digest('hex');

    const data = await this._aliyunIoTRequest(domain, '/app/aepauth/handle', {
      authInfo: {
        clientId: this._clientId,
        sign,
        deviceSn: this._deviceSn,
        timestamp: timeNow,
      },
    }, '1.0.0');

    this.aepResponse = data;
    return data;
  }

  // ── Step 7: Session by Auth Code ────────────────────────

  async sessionByAuthCode() {
    const domain = this.apiGatewayEndpoint;

    // The auth code for this step is the SID from loginByOAuth
    const sid = this.loginByOAuthResponse?.data?.data?.loginSuccessResult?.sid || '';

    const data = await this._aliyunIoTRequest(domain, '/account/createSessionByAuthCode', {
      request: {
        authCode: sid,
        accountType: 'OA_SESSION',
        appKey: APP_KEY,
      },
    }, '1.0.4');

    if (data.data) {
      this.iotToken = data.data.iotToken;
      this.identityId = data.data.identityId;
    }
    return data;
  }

  // ── Step 8: List Devices ────────────────────────────────

  async listDevices() {
    // Try Mammotion direct API first (returns iotId compatible with mqtt_invoke)
    const iotEndpoint = this._getIotEndpoint();
    if (iotEndpoint) {
      try {
        const devices = await this._listDevicesMammotion(iotEndpoint);
        if (devices.length > 0) return devices;
      } catch (err) {
        console.log('Mammotion device list failed, trying Aliyun:', err.message);
      }
    }
    // Fallback to Aliyun IoT API
    return this._listDevicesAliyun();
  }

  async _listDevicesMammotion(iotEndpoint) {
    // Try owned devices first
    let devices = await this._fetchDevicePage(iotEndpoint + '/v1/user/device/page', 'owned');
    if (devices.length > 0) return devices;

    // Try shared devices (secondary account)
    devices = await this._fetchDevicePage(
      'https://domestic.mammotion.com/user-server/v1/share/device/page',
      'shared',
      { iotId: '', owned: 0, pageNumber: 1, pageSize: 200, statusList: [-1] }
    );
    if (devices.length > 0) return devices;

    // Try device-server list
    devices = await this._fetchDeviceList();
    return devices;
  }

  async _fetchDevicePage(url, label, body = null) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + this.accessToken,
        'Content-Type': 'application/json',
        'User-Agent': 'okhttp/4.9.3',
        'Client-Id': this.mammotionClientId,
        'Client-Type': '1',
      },
      body: JSON.stringify(body || { iotId: '', pageNumber: 1, pageSize: 100 }),
    });
    const data = await resp.json();
    console.log('Device list (' + label + '):', JSON.stringify(data).substring(0, 500));
    if (!data.data) return [];
    const records = data.data.records || data.data.data || (Array.isArray(data.data) ? data.data : []);
    if (!Array.isArray(records)) return [];
    return records.map(d => ({
      iotId: d.iotId || d.iot_id || '',
      deviceName: d.deviceName || d.device_name || d.name || '',
      productKey: d.productKey || d.product_key || '',
      nickName: d.nickName || d.nick_name || d.deviceName || d.name || 'Mammotion Mower',
      status: d.status,
      deviceId: d.deviceId || d.device_id || '',
    }));
  }

  async _fetchDeviceList() {
    const resp = await fetch('https://domestic.mammotion.com/device-server/v1/device/list', {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + this.accessToken,
        'Content-Type': 'application/json',
        'User-Agent': 'okhttp/4.9.3',
        'Client-Id': this.mammotionClientId,
        'Client-Type': '1',
      },
    });
    const data = await resp.json();
    console.log('Device list (device-server):', JSON.stringify(data).substring(0, 500));
    if (!data.data || !Array.isArray(data.data)) return [];
    return data.data.map(d => ({
      iotId: d.iotId || d.iot_id || '',
      deviceName: d.deviceName || d.device_name || d.name || '',
      productKey: d.productKey || d.product_key || '',
      nickName: d.nickName || d.nick_name || d.deviceName || d.name || 'Mammotion Mower',
      status: d.status,
      deviceId: d.deviceId || d.device_id || '',
    }));
  }

  async _listDevicesAliyun() {
    const domain = this.apiGatewayEndpoint;
    const data = await this._aliyunIoTRequest(domain, '/uc/listBindingByAccount', {
      pageSize: 100, pageNo: 1,
    }, '1.0.8', this.iotToken);
    if (!data.data || !data.data.data) return [];
    return data.data.data.map(d => ({
      iotId: d.iotId,
      deviceName: d.deviceName,
      productKey: d.productKey,
      nickName: d.nickName || d.deviceName,
      status: d.status,
    }));
  }

  // ── Device Status ───────────────────────────────────────

  async getDeviceStatus(iotId) {
    const domain = this.apiGatewayEndpoint;
    const data = await this._aliyunIoTRequest(domain, '/thing/status/get', {
      iotId,
    }, '1.0.5', this.iotToken);
    return data.data || {};
  }

  async getDeviceProperties(iotId) {
    const domain = this.apiGatewayEndpoint;
    const data = await this._aliyunIoTRequest(domain, '/thing/properties/get', {
      iotId,
    }, '1.0.0', this.iotToken);
    return data.data || {};
  }

  // ── Device Commands ─────────────────────────────────────

  async invokeDeviceService(iotId, service, params = {}) {
    const domain = this.apiGatewayEndpoint;
    const data = await this._aliyunIoTRequest(domain, '/cloud/thing/service/invoke', {
      iotId,
      identifier: service,
      args: params,
    }, '1.0', this.iotToken);
    return data.data || {};
  }

  // ── Send Command via Mammotion MQTT Invoke ──────────────
  // Bypasses Aliyun API Gateway rate limits!
  // Send command via Aliyun cloud API (matching PyMammotion send_cloud_command)

  async sendProtobufCommand(iotId, commandBytes) {
    const contentBase64 = commandBytes.toString('base64');
    console.log('Sending cloud command to iotId:', iotId);

    const domain = this.apiGatewayEndpoint;
    const data = await this._aliyunIoTRequest(domain, '/thing/service/invoke', {
      args: { content: contentBase64 },
      identifier: 'device_protobuf_sync_service',
      iotId,
    }, '1.0.5', this.iotToken);

    console.log('Command response:', JSON.stringify(data).substring(0, 300));
    return data;
  }

  /**
   * Decode JWT access token to extract the 'iot' endpoint URL.
   */
  _getIotEndpoint() {
    if (this._iotEndpointCache) return this._iotEndpointCache;
    try {
      const parts = this.accessToken.split('.');
      if (parts.length < 2) return null;
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      this._iotEndpointCache = payload.iot || null;
      console.log('JWT iot endpoint:', this._iotEndpointCache);
      return this._iotEndpointCache;
    } catch (err) {
      console.error('Failed to decode JWT:', err.message);
      return null;
    }
  }

  // ── Convenience Commands ────────────────────────────────

  async startMowing(iotId, deviceName, productKey) {
    const cmd = this._protobuf.startJob();
    return this.sendProtobufCommand(iotId, cmd, deviceName, productKey);
  }

  async stopMowing(iotId, deviceName, productKey) {
    const cmd = this._protobuf.cancelJob();
    return this.sendProtobufCommand(iotId, cmd, deviceName, productKey);
  }

  async pauseMowing(iotId, deviceName, productKey) {
    const cmd = this._protobuf.pauseTask();
    return this.sendProtobufCommand(iotId, cmd, deviceName, productKey);
  }

  async resumeMowing(iotId, deviceName, productKey) {
    const cmd = this._protobuf.resumeTask();
    return this.sendProtobufCommand(iotId, cmd, deviceName, productKey);
  }

  async returnToDock(iotId, deviceName, productKey) {
    const cmd = this._protobuf.returnToDock();
    return this.sendProtobufCommand(iotId, cmd, deviceName, productKey);
  }

  // ── Token Refresh ───────────────────────────────────────

  async refreshToken() {
    if (this._email && this._password) {
      return this.login(this._email, this._password);
    }
    throw new Error('No credentials available for token refresh');
  }

  getCredentials() {
    return { email: this._email, password: this._password };
  }

}

module.exports = MammotionAPI;

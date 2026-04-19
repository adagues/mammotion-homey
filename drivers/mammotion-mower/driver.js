'use strict';

const Homey = require('homey');
const MammotionAPI = require('../../lib/MammotionAPI');

class MammotionMowerDriver extends Homey.Driver {

  async onInit() {
    this.log('MammotionMowerDriver has been initialized');
  }

  async onPair(session) {
    let mammotionApi;
    let credentials;

    session.setHandler('login', async (data) => {
      mammotionApi = new MammotionAPI();
      credentials = { email: data.username, password: data.password };
      await mammotionApi.login(data.username, data.password);
      return true;
    });

    session.setHandler('list_devices', async () => {
      if (!mammotionApi) {
        throw new Error('Please login first');
      }

      const devices = await mammotionApi.listDevices();

      return devices.map(d => ({
        name: d.nickName || d.deviceName,
        data: {
          id: d.iotId,
          deviceName: d.deviceName,
          productKey: d.productKey,
        },
        store: {
          email: credentials.email,
          password: credentials.password,
        },
      }));
    });
  }

  async onRepair(session, device) {
    session.setHandler('login', async (data) => {
      const api = new MammotionAPI();
      await api.login(data.username, data.password);

      await device.setStoreValue('email', data.username);
      await device.setStoreValue('password', data.password);

      // Re-initialize device with new credentials
      await device.onInit();
      return true;
    });
  }

}

module.exports = MammotionMowerDriver;

'use strict';

const Homey = require('homey');

class MammotionApp extends Homey.App {

  async onInit() {
    this.log('Mammotion Mower app has been initialized');

    // Register flow action cards
    this._registerFlowActions();
  }

  _registerFlowActions() {
    // Start mowing
    this.homey.flow.getActionCard('start_mowing')
      .registerRunListener(async (args) => {
        await args.device.startMowing();
      });

    // Stop mowing
    this.homey.flow.getActionCard('stop_mowing')
      .registerRunListener(async (args) => {
        await args.device.stopMowing();
      });

    // Pause mowing
    this.homey.flow.getActionCard('pause_mowing')
      .registerRunListener(async (args) => {
        await args.device.pauseMowing();
      });

    // Return to dock
    this.homey.flow.getActionCard('return_to_dock')
      .registerRunListener(async (args) => {
        await args.device.returnToDock();
      });

    // Condition: is mowing
    this.homey.flow.getConditionCard('mower_is_mowing')
      .registerRunListener(async (args) => {
        return args.device.getCapabilityValue('mower_state') === 'mowing';
      });

    // Condition: is charging
    this.homey.flow.getConditionCard('mower_is_charging')
      .registerRunListener(async (args) => {
        return args.device.getCapabilityValue('mower_state') === 'charging';
      });
  }

}

module.exports = MammotionApp;

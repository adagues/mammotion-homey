'use strict';

/**
 * Minimal protobuf encoder for Mammotion LubaMsg commands.
 * Only encodes the specific message structures needed for mower control.
 * No external proto files needed.
 *
 * LubaMsg wire format:
 *   field 1  (msgtype):   varint  = 240 (NAV)
 *   field 2  (sender):    varint  = 7   (DEV_MOBILEAPP)
 *   field 3  (rcver):     varint  = 1   (DEV_MAINCTL)
 *   field 4  (msgattr):   varint  = 1   (REQ)
 *   field 5  (seqs):      varint  = N   (0-255, incrementing)
 *   field 6  (version):   varint  = 1
 *   field 11 (nav):       bytes   = MctlNav { todev_taskctrl: NavTaskCtrl }
 *   field 13 (subtype):   varint  = user_account
 *   field 15 (timestamp): varint  = current_time_ms
 */

class ProtobufBuilder {

  constructor() {
    this._seqs = 0;
  }

  // ── Protobuf wire format helpers ────────────────────────

  /** Encode a varint */
  _encodeVarint(value) {
    const bytes = [];
    let v = value >>> 0; // treat as unsigned 32-bit
    // Handle larger values (timestamps)
    if (value > 0xFFFFFFFF) {
      // For 64-bit values, encode in two parts
      let lo = value & 0xFFFFFFFF;
      let hi = Math.floor(value / 0x100000000) & 0xFFFFFFFF;
      while (hi > 0 || lo > 0x7F) {
        bytes.push((lo & 0x7F) | 0x80);
        lo = ((lo >>> 7) | (hi << 25)) >>> 0;
        hi = hi >>> 7;
      }
      bytes.push(lo & 0x7F);
      return Buffer.from(bytes);
    }
    while (v > 0x7F) {
      bytes.push((v & 0x7F) | 0x80);
      v >>>= 7;
    }
    bytes.push(v);
    return Buffer.from(bytes);
  }

  /** Encode a field tag (field number + wire type) */
  _encodeTag(fieldNumber, wireType) {
    return this._encodeVarint((fieldNumber << 3) | wireType);
  }

  /** Encode a varint field */
  _varintField(fieldNumber, value) {
    return Buffer.concat([
      this._encodeTag(fieldNumber, 0), // wire type 0 = varint
      this._encodeVarint(value),
    ]);
  }

  /** Encode a length-delimited field */
  _bytesField(fieldNumber, data) {
    return Buffer.concat([
      this._encodeTag(fieldNumber, 2), // wire type 2 = length-delimited
      this._encodeVarint(data.length),
      data,
    ]);
  }

  // ── NavTaskCtrl ─────────────────────────────────────────

  /**
   * Build NavTaskCtrl protobuf:
   *   field 1 (type):   varint = 1
   *   field 2 (action): varint = actionCode
   *   field 3 (result): varint = 0
   */
  _buildNavTaskCtrl(actionCode) {
    return Buffer.concat([
      this._varintField(1, 1),          // type = 1
      this._varintField(2, actionCode), // action
    ]);
  }

  /**
   * Build MctlNav protobuf:
   *   field 37 (todev_taskctrl): NavTaskCtrl
   */
  _buildMctlNav(actionCode) {
    const taskCtrl = this._buildNavTaskCtrl(actionCode);
    return this._bytesField(37, taskCtrl);
  }

  // ── LubaMsg ─────────────────────────────────────────────

  /**
   * Build a complete LubaMsg for a navigation task control command.
   * @param {number} actionCode - 1=start, 2=pause, 3=resume, 4=cancel, 5=return_to_dock
   * @param {number} userAccount - User account number (subtype field)
   * @returns {Buffer} Serialized protobuf bytes
   */
  buildTaskCommand(actionCode, userAccount = 0) {
    this._seqs = (this._seqs + 1) & 255;
    const timestamp = Date.now();
    const nav = this._buildMctlNav(actionCode);

    return Buffer.concat([
      this._varintField(1, 240),           // msgtype = NAV (0xF0 = 240)
      this._varintField(2, 7),             // sender = DEV_MOBILEAPP
      this._varintField(3, 1),             // rcver = DEV_MAINCTL
      this._varintField(4, 1),             // msgattr = REQ
      this._varintField(5, this._seqs),    // seqs
      this._varintField(6, 1),             // version = 1
      this._bytesField(11, nav),           // nav = MctlNav
      this._varintField(13, userAccount),  // subtype = user_account
      this._varintField(15, timestamp),    // timestamp
    ]);
  }

  // ── Convenience methods ─────────────────────────────────

  startJob(userAccount = 0) {
    return this.buildTaskCommand(1, userAccount);
  }

  pauseTask(userAccount = 0) {
    return this.buildTaskCommand(2, userAccount);
  }

  resumeTask(userAccount = 0) {
    return this.buildTaskCommand(3, userAccount);
  }

  cancelJob(userAccount = 0) {
    return this.buildTaskCommand(4, userAccount);
  }

  returnToDock(userAccount = 0) {
    return this.buildTaskCommand(5, userAccount);
  }

}

module.exports = ProtobufBuilder;

/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

goog.provide('shaka.util.WidevineLicense');

goog.require('shaka.log');
goog.require('shaka.util.BufferUtils');
goog.require('shaka.util.Uint8ArrayUtils');


/**
 * @summary
 * A minimal, tolerant parser for Widevine license responses.
 *
 * A Widevine license response is a protobuf SignedMessage whose "msg" field
 * carries a License message in the clear (only the key material inside each
 * KeyContainer is encrypted).  This lets us learn which key IDs a license
 * delivered without relying on the CDM's key statuses.
 */
shaka.util.WidevineLicense = class {
  /**
   * Returns the content key IDs (lowercase hex, 32 chars) carried by a
   * Widevine LICENSE response, or an empty array if the data is not one.
   *
   * @param {BufferSource} data
   * @return {!Array.<string>}
   */
  static getContentKeyIds(data) {
    const WidevineLicense = shaka.util.WidevineLicense;
    try {
      const signedMessage =
          WidevineLicense.parseMessage_(shaka.util.BufferUtils.toUint8(data));

      // SignedMessage.type (field 1).  If present, it must be LICENSE.
      const type = signedMessage.numbers.get(1);
      if (type != null && type != WidevineLicense.MessageType_.LICENSE) {
        return [];
      }

      // SignedMessage.msg (field 2) is the serialized License.
      const msgs = signedMessage.bytes.get(2);
      if (!msgs || !msgs.length) {
        return [];
      }
      const license = WidevineLicense.parseMessage_(msgs[0]);

      // License.key (field 3) is a repeated KeyContainer.
      const containers = license.bytes.get(3) || [];
      const keyIds = [];
      for (const container of containers) {
        const keyContainer = WidevineLicense.parseMessage_(container);
        // KeyContainer.id (field 1) is the key ID; KeyContainer.type (field 4)
        // tells content keys apart from signing/operator keys.
        const ids = keyContainer.bytes.get(1);
        const keyType = keyContainer.numbers.get(4);
        if (!ids || !ids.length || ids[0].byteLength != 16) {
          continue;
        }
        if (keyType != null && keyType != WidevineLicense.KeyType_.CONTENT) {
          continue;
        }
        const hex = shaka.util.Uint8ArrayUtils.toHex(ids[0]);
        if (!keyIds.includes(hex)) {
          keyIds.push(hex);
        }
      }
      return keyIds;
    } catch (error) {
      shaka.log.v2('Not a parseable Widevine license', error);
      return [];
    }
  }

  /**
   * Parses one level of a protobuf message into its fields.  Unknown fields
   * are skipped.  Throws on malformed input.
   *
   * @param {!Uint8Array} bytes
   * @return {shaka.util.WidevineLicense.ParsedMessage}
   * @private
   */
  static parseMessage_(bytes) {
    const WidevineLicense = shaka.util.WidevineLicense;
    /** @type {!Map.<number, number>} */
    const numbers = new Map();
    /** @type {!Map.<number, !Array.<!Uint8Array>>} */
    const byteFields = new Map();

    let offset = 0;
    while (offset < bytes.byteLength) {
      const tag = WidevineLicense.readBase128_(bytes, offset);
      offset = tag.next;
      const fieldNumber = Math.floor(tag.value / 8);
      const wireType = tag.value % 8;
      if (fieldNumber == 0) {
        throw new RangeError('Invalid protobuf field number');
      }

      switch (wireType) {
        case 0: {  // base-128 integer
          const value = WidevineLicense.readBase128_(bytes, offset);
          offset = value.next;
          numbers.set(fieldNumber, value.value);
          break;
        }
        case 1:  // 64-bit
          offset += 8;
          break;
        case 2: {  // length-delimited
          const length = WidevineLicense.readBase128_(bytes, offset);
          offset = length.next;
          const end = offset + length.value;
          if (end > bytes.byteLength) {
            throw new RangeError('Truncated protobuf field');
          }
          const list = byteFields.get(fieldNumber) || [];
          list.push(bytes.subarray(offset, end));
          byteFields.set(fieldNumber, list);
          offset = end;
          break;
        }
        case 5:  // 32-bit
          offset += 4;
          break;
        default:
          // Groups (3, 4) are deprecated and never used by Widevine.
          throw new RangeError('Unsupported protobuf wire type');
      }
      if (offset > bytes.byteLength) {
        throw new RangeError('Truncated protobuf message');
      }
    }

    return {numbers, bytes: byteFields};
  }

  /**
   * Reads a base-128 encoded integer.  Values above 2^53 lose precision,
   * which is fine for the field numbers, lengths and enums we care about.
   *
   * @param {!Uint8Array} bytes
   * @param {number} offset
   * @return {{value: number, next: number}}
   * @private
   */
  static readBase128_(bytes, offset) {
    let value = 0;
    let multiplier = 1;
    for (let i = 0; i < 10; i++) {
      if (offset >= bytes.byteLength) {
        throw new RangeError('Truncated base-128 integer');
      }
      const byte = bytes[offset++];
      value += (byte & 0x7f) * multiplier;
      if (!(byte & 0x80)) {
        return {value, next: offset};
      }
      multiplier *= 128;
    }
    throw new RangeError('Base-128 integer too long');
  }
};


/**
 * @typedef {{
 *   numbers: !Map.<number, number>,
 *   bytes: !Map.<number, !Array.<!Uint8Array>>
 * }}
 *
 * @property {!Map.<number, number>} numbers
 *   Integer (base-128) fields by field number (last value wins).
 * @property {!Map.<number, !Array.<!Uint8Array>>} bytes
 *   Length-delimited fields by field number, in order of appearance.
 */
shaka.util.WidevineLicense.ParsedMessage;


/**
 * SignedMessage.MessageType values we care about.
 * @enum {number}
 * @private
 */
shaka.util.WidevineLicense.MessageType_ = {
  LICENSE: 2,
};


/**
 * License.KeyContainer.KeyType values we care about.
 * @enum {number}
 * @private
 */
shaka.util.WidevineLicense.KeyType_ = {
  CONTENT: 2,
};

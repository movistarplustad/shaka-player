/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

describe('WidevineLicense', () => {
  const WidevineLicense = shaka.util.WidevineLicense;
  const Uint8ArrayUtils = shaka.util.Uint8ArrayUtils;

  const KEY_ID_1 = '0123456789abcdef0123456789abcdef';
  const KEY_ID_2 = 'fedcba9876543210fedcba9876543210';
  const KEY_ID_3 = '00112233445566778899aabbccddeeff';

  const LICENSE = 2;
  const ERROR_RESPONSE = 3;
  const KEY_TYPE_SIGNING = 1;
  const KEY_TYPE_CONTENT = 2;
  const KEY_TYPE_OPERATOR_SESSION = 4;

  /**
   * @param {number} value
   * @return {!Array.<number>}
   */
  function base128(value) {
    const bytes = [];
    do {
      let byte = value % 128;
      value = Math.floor(value / 128);
      if (value > 0) {
        byte |= 0x80;
      }
      bytes.push(byte);
    } while (value > 0);
    return bytes;
  }

  /**
   * @param {number} fieldNumber
   * @param {number} value
   * @return {!Array.<number>}
   */
  function numberField(fieldNumber, value) {
    return base128(fieldNumber * 8 + 0).concat(base128(value));
  }

  /**
   * @param {number} fieldNumber
   * @param {!Array.<number>} bytes
   * @return {!Array.<number>}
   */
  function bytesField(fieldNumber, bytes) {
    return base128(fieldNumber * 8 + 2).concat(base128(bytes.length), bytes);
  }

  /**
   * @param {number} fieldNumber
   * @return {!Array.<number>}
   */
  function fixed32Field(fieldNumber) {
    return base128(fieldNumber * 8 + 5).concat([1, 2, 3, 4]);
  }

  /**
   * @param {number} fieldNumber
   * @return {!Array.<number>}
   */
  function fixed64Field(fieldNumber) {
    return base128(fieldNumber * 8 + 1).concat([1, 2, 3, 4, 5, 6, 7, 8]);
  }

  /**
   * @param {string} hex
   * @return {!Array.<number>}
   */
  function hexBytes(hex) {
    return Array.from(Uint8ArrayUtils.fromHex(hex));
  }

  /**
   * @param {?string} keyIdHex
   * @param {number} keyType
   * @return {!Array.<number>}
   */
  function keyContainer(keyIdHex, keyType) {
    let bytes = [];
    if (keyIdHex) {
      bytes = bytes.concat(bytesField(1, hexBytes(keyIdHex)));
    }
    // iv (field 2) and the encrypted key (field 3).
    bytes = bytes.concat(bytesField(2, new Array(16).fill(0)));
    bytes = bytes.concat(bytesField(3, new Array(16).fill(0xde)));
    bytes = bytes.concat(numberField(4, keyType));
    return bytes;
  }

  /**
   * @param {!Array.<!Array.<number>>} containers
   * @return {!Array.<number>}
   */
  function license(containers) {
    let bytes = [];
    // id (field 1, a nested LicenseIdentification message we don't parse).
    bytes = bytes.concat(bytesField(1, bytesField(1, [9, 9, 9])));
    // policy (field 2) with some integer fields.
    bytes = bytes.concat(bytesField(2, numberField(1, 1).concat(
        numberField(2, 1))));
    for (const container of containers) {
      bytes = bytes.concat(bytesField(3, container));
    }
    // license_start_time (field 4), a large integer.
    bytes = bytes.concat(numberField(4, 1700000000));
    // Fields of the other wire types, which must be skipped.
    bytes = bytes.concat(fixed32Field(15));
    bytes = bytes.concat(fixed64Field(16));
    return bytes;
  }

  /**
   * @param {number} type
   * @param {?Array.<number>} msg
   * @return {!Uint8Array}
   */
  function signedMessage(type, msg) {
    let bytes = numberField(1, type);
    if (msg) {
      bytes = bytes.concat(bytesField(2, msg));
    }
    // signature (field 3) and session_key (field 4).
    bytes = bytes.concat(bytesField(3, new Array(32).fill(7)));
    bytes = bytes.concat(bytesField(4, new Array(256).fill(1)));
    return new Uint8Array(bytes);
  }

  it('extracts the content key IDs of a license', () => {
    const data = signedMessage(LICENSE, license([
      keyContainer(null, KEY_TYPE_SIGNING),
      keyContainer(KEY_ID_1, KEY_TYPE_CONTENT),
      keyContainer(KEY_ID_3, KEY_TYPE_OPERATOR_SESSION),
      keyContainer(KEY_ID_2, KEY_TYPE_CONTENT),
    ]));

    expect(WidevineLicense.getContentKeyIds(data))
        .toEqual([KEY_ID_1, KEY_ID_2]);
  });

  it('treats a key container without a type as a content key', () => {
    const container = bytesField(1, hexBytes(KEY_ID_1));
    const data = signedMessage(LICENSE, license([container]));

    expect(WidevineLicense.getContentKeyIds(data)).toEqual([KEY_ID_1]);
  });

  it('does not repeat key IDs', () => {
    const data = signedMessage(LICENSE, license([
      keyContainer(KEY_ID_1, KEY_TYPE_CONTENT),
      keyContainer(KEY_ID_1, KEY_TYPE_CONTENT),
    ]));

    expect(WidevineLicense.getContentKeyIds(data)).toEqual([KEY_ID_1]);
  });

  it('accepts an ArrayBuffer', () => {
    const data = signedMessage(LICENSE, license([
      keyContainer(KEY_ID_2, KEY_TYPE_CONTENT),
    ]));

    const buffer = shaka.util.BufferUtils.toArrayBuffer(data);
    expect(WidevineLicense.getContentKeyIds(buffer)).toEqual([KEY_ID_2]);
  });

  it('ignores messages that are not licenses', () => {
    const data = signedMessage(ERROR_RESPONSE, license([
      keyContainer(KEY_ID_1, KEY_TYPE_CONTENT),
    ]));

    expect(WidevineLicense.getContentKeyIds(data)).toEqual([]);
  });

  it('ignores a signed message without a license', () => {
    const data = signedMessage(LICENSE, null);

    expect(WidevineLicense.getContentKeyIds(data)).toEqual([]);
  });

  it('ignores key IDs that are not 16 bytes long', () => {
    const container = bytesField(1, [1, 2, 3]).concat(
        numberField(4, KEY_TYPE_CONTENT));
    const data = signedMessage(LICENSE, license([container]));

    expect(WidevineLicense.getContentKeyIds(data)).toEqual([]);
  });

  it('returns an empty list for data that is not protobuf', () => {
    const xml = shaka.util.StringUtils.toUTF8(
        '<?xml version="1.0"?><soap:Envelope>' +
        '<AcquireLicenseResponse/></soap:Envelope>');

    expect(WidevineLicense.getContentKeyIds(xml)).toEqual([]);
    expect(WidevineLicense.getContentKeyIds(new Uint8Array(0))).toEqual([]);
    expect(WidevineLicense.getContentKeyIds(new Uint8Array([0xff, 0xff])))
        .toEqual([]);
  });

  it('returns an empty list for a truncated license', () => {
    const data = signedMessage(LICENSE, license([
      keyContainer(KEY_ID_1, KEY_TYPE_CONTENT),
    ]));
    const truncated = data.subarray(0, data.byteLength - 200);

    expect(WidevineLicense.getContentKeyIds(truncated)).toEqual([]);
  });
});

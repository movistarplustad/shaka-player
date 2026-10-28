# On-demand keys for live channels with Key-Per-Track and key rotation (`drm.singleLicenseRequest`)

Design and change log of the `v4.7_kpt_movistarplus` fork (Shaka Player 4.7.15). Spanish version: [kpt-claves-bajo-demanda.md](kpt-claves-bajo-demanda.md).

## 1. Goal and context

Movistar+ live channels packaged by ATEME carry DRM signalled in the MPD with one key per track (Key-Per-Track: one KID for audio and SD video, another for HD video) and key rotation (each crypto period brings new KIDs and a new DASH Period). The license server is Nagra SSP (Widevine and PlayReady). The application cannot know in advance whether a channel is KPT, KR, both or neither.

With stock Shaka, the PeriodCombiner merges the KIDs of every Period in the DVR window into one stream and `Player.onKeyStatus_` demands a status for all of them, so startup made one license request per KID in the window (up to 10 on test02: 5 crypto periods times SD and HD), in parallel, and the player required keys of Periods a live viewer would never play.

Goal: request only the keys about to be used, one request in flight, never request keys of tracks the application restricts, and keep working unchanged when the server bundles keys (SD plus HD, or future keys).

### What the server actually returns (measured)

| Situation | Observed (19 to 21 Oct 2026, channel test02) |
| --- | --- |
| Request for the current KID, Chrome Widevine L3 | The requested key only |
| Request for a past KID in the first 15 min of the 30-min crypto period | The requested key plus the current one |
| Request for a past KID in the second 15 min | The requested key only |
| Keys of intermediate or future periods, L3 | Never |
| HD KID with Widevine L3 (Chrome on a Mac) | A license with the SD key of the same period |
| TitanOS TV with Widevine L1, same account | SD plus HD keys of the period, sometimes those of the next two periods as well |
| Policy of every license | 24 h playback, 48 h rental, no renewal, no persistence |

Nagra's written specification ("now + 24 h", "past up to now + 24 h") does not match the measurements; the details are in the test reports and in `licencias_test02_20261020/` (raw request and response of every call).

## 2. Configuration

| Flag | Default | Effect |
| --- | --- | --- |
| `drm.singleLicenseRequest` | `false` | Enables the on-demand key mode described here. With `false` the player behaves as before (one session per init data, in parallel) |
| `drm.singleLicenseRequestBlindMode` | `false` | Extends the mode to polyfilled EME platforms that report no per-key statuses (LG webOS 3.x = LG 2016/2017, legacy Safari). With `false` those platforms behave as if the first flag were `false`. It does not affect any other platform |

Always excluded from the mode: Tizen 2 and offline storage (`initForStorage`). If a native-EME platform turns out to report synthetic key statuses, the engine falls back to the classic behaviour for that playback (`fallbackToLegacy_`).

The fork's `player.setLicenceRequiredCallback()` API is kept for compatibility; the new mode makes it unnecessary.

## 3. Flow

1. **The DASH parser puts the KID on the init segment.** `parseRepresentation_` computes the `default_KID` before creating the stream info and stores it in `context.representation.keyId`; `SegmentTemplate.createInitSegment_` and `SegmentBase.createInitSegment` (SegmentList too) copy it to `InitSegmentReference.keyIds`. `InitSegmentReference.equal()` also compares the KIDs, so two Periods with the same init URL but different keys count as different init segments.
2. **The StreamingEngine notifies the Player.** `onInitSegmentAppended(position, initSegmentReference, stream)` fires when the download of an init segment different from the previous one starts: at startup, on every Period change and after the buffer is cleared (seek outside the buffer, track change with clearing). It now receives the stream as well.
3. **The Player asks for the key.** `Player.onInitSegmentAppended_` calls `drmEngine_.ensureKeysAvailable(initSegment.keyIds)` when the mode is active; for an init segment without KID it does so only for encrypted streams, and then every registered key still missing is requested, one at a time (manifests without `default_KID`, HLS).
4. **The DrmEngine registers instead of requesting.** In on-demand mode `newInitData(type, data, keyId)` with a known KID only stores the init data in `initDataByKeyId_` (first registration wins; the re-injections of every manifest refresh are O(1)). Init data without KID (`encrypted` events, in-band PSSH) follows the classic path. `createOrLoad()` no longer creates sessions from manifest init data.
5. **One request in flight.** `ensureKeysAvailable` skips keys we already hold (`isKeyAvailable_`: announced status, live status of any session, or key seen in a license, except `expired`/`released`), keys in flight or queued, and keys marked unavailable. If the init data is not registered yet, the KID goes to `wantedKeyIds_` and is requested as soon as it arrives. The first request takes the gate (`licenseGateSession_`); later ones wait in `pendingInitData_` and, once the gate settles, are re-checked on the next macrotask (`drainPendingInitData_`): if the previous license brought the key, it is not requested.
6. **Unavailable keys.** An HTTP 4xx rejection (`isDefinitiveRejection_`) or a successful license that does not include the requested key while it did bring others (`checkRequestedKeysDelivered_`) puts the KID in `unavailableKeyIds_`, never requested again in that playback; the Player gets a key status announcement even with an empty map (`announceIfReady_`). An `expired` or `released` key counts as missing and is requested again, bypassing the init data byte deduplication.
7. **Player restriction rule.** In `applyKeyStatusRestrictions_`, with the mode active (`drmEngine_.isOnDemandKeyMode()`), `allowedByOnDemandKeys_` decides per stream: a KID without status does not restrict; an `output-restricted` or `internal-error` status restricts; and when no KID of the stream is usable and one is unavailable, it restricts. `filterManifestWithRestrictions_` registers the init data of every variant, including those restricted by the application, and re-applies the known statuses after each variant rebuild, except while a license is in flight (`hasPendingLicenseRequests()`), to avoid a transient 4012 at rotation.
8. **Traces.** Every applied license logs `License response for session <id> (<type>) covers N key ID(s): <list>` (info level) and the `drmsessionupdate` event carries `sessionId` and `keyIds` (CDM statuses plus, for Widevine, the keys found in the license itself through `shaka.util.WidevineLicense`).

### Blind mode

On polyfilled EME the CDM only reports a global status ('00'). With `singleLicenseRequestBlindMode` the engine uses the Widevine license parser as the source of truth for the keys it holds (`deliveredKeyIds_`) and exposes them as `usable` next to the global status in `getKeyStatuses()`, so the Player rule remains per KID. With other key systems every key ends up with its own serialized request. Not yet tested on a real LG 2016/2017.

## 4. Changes file by file

| File | Change |
| --- | --- |
| `lib/media/segment_reference.js` | `InitSegmentReference.keyIds` and comparison in `equal()` |
| `lib/dash/dash_parser.js` | `keyId` in `InheritanceFrame`; the `default_KID` is computed before the stream info |
| `lib/dash/segment_template.js`, `lib/dash/segment_base.js` | `ref.keyIds` on init segments (SegmentBase also serves SegmentList) |
| `lib/media/streaming_engine.js` | `onInitSegmentAppended` receives the stream |
| `lib/player.js` | `onInitSegmentAppended_`, `allowedByOnDemandKeys_`, `applyKeyStatusRestrictions_` extracted from `onKeyStatus_`, registration of every variant and status re-application in `filterManifestWithRestrictions_`, `drmsessionupdate` event with `sessionId` and `keyIds`, no empty-map warning in on-demand mode |
| `lib/media/drm_engine.js` | Registry by KID, gate and queue, `ensureKeysAvailable`, `isOnDemandKeyMode`, `isKeyUnavailable`, `hasUnavailableKeys`, `hasPendingLicenseRequests`, unavailable and expired keys, synthetic status detection with fallback, blind mode, per-license key trace, shared `normalizeKeyStatusEntry_` |
| `lib/util/widevine_license.js` (new) | `WidevineLicense.getContentKeyIds(data)`: KIDs of the CONTENT keys in a Widevine license |
| `externs/shaka/player.js`, `lib/util/player_configuration.js`, `demo/config.js` | The two flags, their docs and the demo controls |
| `build/types/core` | Registration of the new file |
| `test/media/drm_engine_unit.js` | `describe('singleLicenseRequest')`: registration without sessions, on-demand request and serialization, keys already delivered, wanted KID, empty list, unavailable by license and by 4xx, announcement with empty map, transient failure, expiry, re-injections, individualization, renewals, `delayLicenseRequestUntilPlayed`, rotation, init data without KID, offline, polyfill without blind mode, fallback on synthetic statuses, blind mode |
| `test/util/widevine_license_unit.js` | License parser |
| `test/player_unit.js` | Registration of restricted variants, init segment hook, on-demand rule (no status, restricted, unavailable, old unavailable key, `RESTRICTIONS_CANNOT_BE_MET` only when everything is rejected, track switch with buffer clearing, re-application on refilter) |
| `test/media/segment_reference_unit.js`, `test/dash/dash_parser_segment_template_unit.js`, `..._segment_base_unit.js`, `..._segment_list_unit.js` | KIDs on init segments, two combined Periods, `equal()` |
| `test/media/streaming_engine_unit.js` | `onInitSegmentAppended` per Period before media is appended |
| `test/test/util/fake_drm_engine.js` | Spies for the new API |

## 5. Verification

- `python3 build/build.py --force`, `python3 build/check.py --force`, `python3 build/gendeps.py` without errors.
- Tests: `python3 build/test.py --no-build --uncompiled --quick --browsers ChromeHeadless --filter '^(DrmEngine|Player|DashParser|InitSegmentReference|StreamingEngine) '` (on macOS `CHROME_BIN` is needed). Full suite: 2325 green; the 18 remaining failures predate this change (AES-128 with WebCrypto on Chrome 155, "Cue layout" with native rendering, and `CastUtils includes every Player member` because of the fork's `setLicenceRequiredCallback`).
- Live (test02, Chrome 155 headless, Widevine L3, `restrictions.maxBandwidth` 2 Mbps): 19 Oct, 56 min, 5 requests (startup, two seeks into old periods, two rotations), 0 when returning to live, 174 to 212 ms, no errors. 20 Oct, 10 use cases with request and response saved in `licencias_test02_20261020/`. 21 Oct, Philips TitanOS TV (Widevine L1, Chrome 116) without restrictions: plays 1080p; 1 request at startup when the license brings SD and HD, 2 when it does not; 0 at rotation when the keys came in advance.
- Measured cadences: test02 Period 15 min and key 30 min; test01 Period 2 h 10 min and key 4 h 20 min. The player does not depend on the cadence.

## 6. Limitations and phase 2

- A transient failure of a rotation request is only retried at the next init segment that needs the key; a `waitingforkey` retry valve and a gate watchdog are missing.
- Licenses expire after 24 h; if every key we hold expires at once, `EXPIRED` is raised as always. Renewal before expiry is missing.
- On an L3 device without `restrictions` the ABR may pick HD: one extra request, the key does not come, the variant is marked unavailable and the player returns to SD clearing the buffer.
- Inherited 4.7 defect: when loading with `restrictions`, restricted variants get no `decodingInfos` and disappear from the manifest; raising the restriction at runtime does not bring them back.
- No cleanup of sessions whose KIDs left the DVR window; no `tenc` reader for manifests without `default_KID`.

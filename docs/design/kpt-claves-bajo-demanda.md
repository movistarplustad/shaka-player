# Claves bajo demanda para canales con Key-Per-Track y rotación de claves (`drm.singleLicenseRequest`)

Documento de diseño y registro de cambios del fork `v4.7_kpt_movistarplus` (Shaka Player 4.7.15). Versión en inglés: [kpt-on-demand-keys.md](kpt-on-demand-keys.md).

## 1. Objetivo y contexto

Los canales en directo de Movistar+ empaquetados por ATEME llevan DRM señalizada en el MPD con una clave por track (Key-Per-Track: un KID para audio y vídeo SD y otro para vídeo HD) y rotación de claves (Key-Rotation: cada periodo de cifrado estrena KIDs y un Period DASH nuevo). El servidor de licencias es Nagra SSP (Widevine y PlayReady). La aplicación no sabe de antemano si un canal es KPT, KR, los dos o ninguno.

Con el player de serie, el PeriodCombiner une los KIDs de todos los Periods de la ventana DVR en un solo stream y `Player.onKeyStatus_` exige estado para todos ellos, así que al arrancar se hacía una petición de licencia por cada KID de la ventana (hasta 10 en test02: 5 periodos de cifrado por SD y HD) en paralelo, y además el player exigía claves de periodos que el espectador del directo nunca iba a usar.

Objetivo: pedir solo las claves que se van a usar, una petición en vuelo, sin pedir nunca claves de tracks restringidos por la aplicación, y seguir funcionando igual cuando el servidor agrupe claves (SD más HD, o claves futuras).

### Qué devuelve realmente el servidor (medido)

| Situación | Observado (19 a 21/10/2026, canal test02) |
| --- | --- |
| Petición del KID en curso, Chrome Widevine L3 | Solo la clave pedida |
| Petición de un KID pasado en los primeros 15 min del periodo de cifrado de 30 min | La pedida más la en curso |
| Petición de un KID pasado en los segundos 15 min | Solo la pedida |
| Claves de periodos intermedios o futuros, L3 | Nunca |
| KID HD con Widevine L3 (Chrome en Mac) | Licencia con la clave SD del mismo periodo |
| TV TitanOS con Widevine L1, misma cuenta | Clave SD más HD del periodo, y a veces las de los dos periodos siguientes |
| Policy de toda licencia | reproducción 24 h, alquiler 48 h, sin renovación ni persistencia |

La especificación escrita de Nagra ("now + 24 h", "pasado hasta now + 24 h") no coincide con lo medido; el detalle está en los informes de las pruebas y en `licencias_test02_20261020/` (request y response en bruto de cada petición).

## 2. Configuración

| Flag | Por defecto | Efecto |
| --- | --- | --- |
| `drm.singleLicenseRequest` | `false` | Activa el modo de claves bajo demanda descrito aquí. Con `false` el player se comporta como siempre (una sesión por initData, en paralelo) |
| `drm.singleLicenseRequestBlindMode` | `false` | Extiende el modo a plataformas con EME polyfilled que no dan estados por clave (LG webOS 3.x = LG 2016/2017, Safari antiguo). Con `false` esas plataformas se comportan como si el primer flag estuviera a `false`. No afecta a ninguna otra plataforma |

Siempre excluidos del modo: Tizen 2 y el almacenamiento offline (`initForStorage`). Si en una plataforma con EME nativo el CDM resulta dar estados sintéticos, el motor vuelve al comportamiento clásico para esa reproducción (`fallbackToLegacy_`).

La API del fork `player.setLicenceRequiredCallback(cb)` queda **obsoleta** (`@deprecated`, con aviso de deprecación en consola al registrarla) pero sigue funcionando igual que antes, para no romper las aplicaciones que aún la llaman: por cada initData que va a pedirse, `cb(pssh, keyStatuses)` devuelve `[force, request]`; con `force` a `false` el player decide como siempre, con `[true, false]` descarta el initData y con `[true, true]` lo pide saltándose la deduplicación. Con `drm.singleLicenseRequest` a `true` el callback **se ignora** (el DrmEngine avisa por consola al registrarlo): el modo bajo demanda ya decide por KID qué pedir, y un callback que descartara la clave del periodo en curso dejaría el vídeo esperando clave. Con el flag a `false` sigue funcionando como siempre. Las aplicaciones nuevas deben usar solo `drm.singleLicenseRequest`.

## 3. Flujo

1. **El parser DASH pone el KID en el init segment.** `parseRepresentation_` calcula el `default_KID` antes de crear el stream info y lo guarda en `context.representation.keyId`; `SegmentTemplate.createInitSegment_` y `SegmentBase.createInitSegment` (también SegmentList) lo copian a `InitSegmentReference.keyIds`. `InitSegmentReference.equal()` compara también los KIDs, así que dos Periods con la misma URL de init pero distinta clave se tratan como init segments distintos.
2. **El StreamingEngine avisa al Player.** `onInitSegmentAppended(position, initSegmentReference, stream)` se dispara al iniciar la descarga de un init segment distinto del anterior: en el arranque, en cada cambio de Period y tras vaciar el buffer (seek fuera de lo buferizado, cambio de pista con limpieza). Ahora recibe también el stream.
3. **El Player pide la clave.** `Player.onInitSegmentAppended_` llama a `drmEngine_.ensureKeysAvailable(initSegment.keyIds)` si el modo está activo; con un init segment sin KID solo lo hace para streams cifrados, y entonces pide en serie todas las claves registradas que falten (manifests sin `default_KID`, HLS).
4. **El DrmEngine registra en vez de pedir.** En modo bajo demanda, `newInitData(type, data, keyId)` con KID conocido solo guarda el initData en `initDataByKeyId_` (primera inscripción gana; las reinyecciones de cada refresco del manifest son O(1)). El initData sin KID (`encrypted`, PSSH in-band) sigue el camino clásico. `createOrLoad()` ya no crea sesiones con el initData del manifest.
5. **Una petición en vuelo.** `ensureKeysAvailable` ignora las claves que ya tenemos (`isKeyAvailable_`: estado anunciado, estado vivo de alguna sesión o clave vista en la licencia, salvo `expired`/`released`), las que ya están en vuelo o en cola y las marcadas como no disponibles. Si el initData aún no está registrado, el KID queda en `wantedKeyIds_` y se pide en cuanto llega. La primera petición toma la puerta (`licenseGateSession_`); las siguientes esperan en `pendingInitData_` y, al resolverse la puerta, se vuelven a comprobar en el siguiente macrotask (`drainPendingInitData_`): si la licencia anterior trajo la clave, no se pide.
6. **Claves no disponibles.** Un rechazo HTTP 4xx (`isDefinitiveRejection_`) o una licencia correcta que no incluye la clave pedida aunque sí trajo otras (`checkRequestedKeysDelivered_`) marcan el KID en `unavailableKeyIds_` y no se vuelve a pedir en esa reproducción; el Player recibe un anuncio de estados aunque el mapa esté vacío (`announceIfReady_`). Una clave `expired` o `released` cuenta como ausente y se vuelve a pedir, saltando la deduplicación por bytes del initData.
7. **Regla de restricción del Player.** En `applyKeyStatusRestrictions_`, con el modo activo (`drmEngine_.isOnDemandKeyMode()`), `allowedByOnDemandKeys_` decide por stream: un KID sin estado no restringe; un estado `output-restricted` o `internal-error` restringe; y si ningún KID del stream es usable y alguno es no disponible, restringe. `filterManifestWithRestrictions_` registra el initData de todas las variantes, incluidas las restringidas por la aplicación, y vuelve a aplicar los estados conocidos tras cada reconstrucción de variantes, salvo mientras haya una licencia en vuelo (`hasPendingLicenseRequests()`), para no provocar un 4012 transitorio en la rotación.
8. **Trazas.** Cada licencia aplicada escribe `License response for session <id> (<tipo>) covers N key ID(s): <lista>` (nivel info) y el evento `drmsessionupdate` lleva `sessionId` y `keyIds` (estados del CDM más, en Widevine, las claves que lleva la propia licencia según `shaka.util.WidevineLicense`).

### Modo ciego

En EME polyfilled el CDM solo reporta un estado global ('00'). Con `singleLicenseRequestBlindMode` el motor usa el parser de licencias Widevine como fuente de verdad de qué claves tiene (`deliveredKeyIds_`) y las expone como `usable` junto al estado global en `getKeyStatuses()`, de modo que la regla del Player sigue siendo por KID. Con otros sistemas de claves cada clave acaba con su propia petición en serie. No se ha probado en un LG 2016/2017 real.

## 4. Cambios fichero a fichero

| Fichero | Cambio |
| --- | --- |
| `lib/media/segment_reference.js` | `InitSegmentReference.keyIds` y comparación en `equal()` |
| `lib/dash/dash_parser.js` | `keyId` en `InheritanceFrame`; el `default_KID` se calcula antes del stream info |
| `lib/dash/segment_template.js`, `lib/dash/segment_base.js` | `ref.keyIds` en los init segments (SegmentBase sirve también a SegmentList) |
| `lib/media/streaming_engine.js` | `onInitSegmentAppended` recibe el stream |
| `lib/player.js` | `onInitSegmentAppended_`, `allowedByOnDemandKeys_`, `applyKeyStatusRestrictions_` extraída de `onKeyStatus_`, registro de todas las variantes y reaplicación de estados en `filterManifestWithRestrictions_`, evento `drmsessionupdate` con `sessionId` y `keyIds`, sin aviso por mapa vacío en modo bajo demanda |
| `lib/media/drm_engine.js` | Registro por KID, puerta y cola, `ensureKeysAvailable`, `isOnDemandKeyMode`, `isKeyUnavailable`, `hasUnavailableKeys`, `hasPendingLicenseRequests`, claves no disponibles, expiradas, detección de estados sintéticos con fallback, modo ciego, traza de claves por licencia, `normalizeKeyStatusEntry_` compartido |
| `lib/util/widevine_license.js` (nuevo) | `WidevineLicense.getContentKeyIds(data)`: KIDs de las claves CONTENT de una licencia Widevine |
| `externs/shaka/player.js`, `lib/util/player_configuration.js`, `demo/config.js` | Los dos flags, su documentación y controles en la demo |
| `build/types/core` | Registro del fichero nuevo |
| `test/media/drm_engine_unit.js` | `describe('singleLicenseRequest')`: registro sin sesiones, petición bajo demanda y serialización, claves ya entregadas, KID wanted, lista vacía, no disponibles por licencia y por 4xx, anuncio con mapa vacío, fallo transitorio, expiración, reinyecciones, individualization, renovaciones, `delayLicenseRequestUntilPlayed`, rotación, initData sin KID, offline, polyfill sin modo ciego, fallback por estados sintéticos, modo ciego |
| `test/util/widevine_license_unit.js` | Parser de licencias |
| `test/player_unit.js` | Registro de variantes restringidas, gancho del init segment, regla bajo demanda (sin estado, restringido, no disponible, clave antigua no disponible, `RESTRICTIONS_CANNOT_BE_MET` solo con todo rechazado, cambio de pista con limpieza de buffer, reaplicación al refiltrar) |
| `test/media/segment_reference_unit.js`, `test/dash/dash_parser_segment_template_unit.js`, `..._segment_base_unit.js`, `..._segment_list_unit.js` | KIDs en los init segments, dos Periods combinados, `equal()` |
| `test/media/streaming_engine_unit.js` | `onInitSegmentAppended` por Period antes de añadir media |
| `test/test/util/fake_drm_engine.js` | Spies de la API nueva |

## 5. Verificación

- `python3 build/build.py --force`, `python3 build/check.py --force`, `python3 build/gendeps.py` sin errores.
- Tests: `python3 build/test.py --no-build --uncompiled --quick --browsers ChromeHeadless --filter '^(DrmEngine|Player|DashParser|InitSegmentReference|StreamingEngine) '` (en macOS hace falta `CHROME_BIN`). Suite completa: 2325 en verde; los 18 fallos restantes son previos a este cambio (AES-128 con WebCrypto en Chrome 155, "Cue layout" con render nativo y `CastUtils includes every Player member` por `setLicenceRequiredCallback` del fork).
- En directo (test02, Chrome 155 headless, Widevine L3, `restrictions.maxBandwidth` 2 Mbps): 19/10, 56 min, 5 peticiones (arranque, dos seeks a periodos antiguos, dos rotaciones), 0 al volver al directo, 174 a 212 ms, sin errores. 20/10, 10 casos de uso con request y response guardados en `licencias_test02_20261020/`. 21/10, TV Philips TitanOS (Widevine L1, Chrome 116) sin restricciones: reproduce 1080p; 1 petición al arrancar cuando la licencia trae SD y HD, 2 cuando no; 0 en la rotación cuando las claves vinieron por adelantado.
- Cadencias medidas: test02 Period 15 min y clave 30 min; test01 Period 2 h 10 min y clave 4 h 20 min. El player no depende de la cadencia.

## 6. Limitaciones y fase 2

- Un fallo transitorio de la petición de una rotación solo se reintenta en el siguiente init segment que necesite la clave; falta la válvula de reintento en `waitingforkey` y un watchdog de la puerta.
- Las licencias caducan a las 24 h; si todas las claves que tenemos caducan a la vez salta `EXPIRED` como siempre. Falta renovar antes de la caducidad.
- En un dispositivo L3 sin `restrictions` el ABR puede elegir HD: una petición extra, la clave no llega, la variante se marca no disponible y el player vuelve a SD vaciando el buffer.
- Defecto heredado de la 4.7: al cargar con `restrictions`, las variantes restringidas se quedan sin `decodingInfos` y desaparecen del manifest; subir la restricción en caliente no las recupera.
- Sin limpieza de sesiones cuyos KIDs han salido de la ventana DVR; sin lector de `tenc` para manifests sin `default_KID`.

Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * NOTICE from the Sentry authors:
 * - Vendored from: https://github.com/open-telemetry/opentelemetry-js-contrib/tree/instrumentation-redis-v0.62.0/packages/instrumentation-redis
 * - Upstream version: @opentelemetry/instrumentation-redis@0.62.0
 * - Minor TypeScript adjustments for this repository's compiler settings
 */
/* eslint-disable -- vendored @opentelemetry/instrumentation-redis */

/*
 * This file contains a copy of unstable semantic convention definitions
 * used by the vendored redis/ioredis instrumentations.
 * @see https://github.com/open-telemetry/opentelemetry-js/tree/main/semantic-conventions#unstable-semconv
 */

// Deprecated constants kept for backwards compatibility with older semconv
const ATTR_DB_CONNECTION_STRING = 'db.connection_string';
const ATTR_DB_STATEMENT = 'db.statement';
const ATTR_DB_SYSTEM = 'db.system';
const ATTR_NET_PEER_NAME = 'net.peer.name';
const ATTR_NET_PEER_PORT = 'net.peer.port';
const DB_SYSTEM_NAME_VALUE_REDIS = 'redis';
const DB_SYSTEM_VALUE_REDIS = 'redis';

exports.ATTR_DB_CONNECTION_STRING = ATTR_DB_CONNECTION_STRING;
exports.ATTR_DB_STATEMENT = ATTR_DB_STATEMENT;
exports.ATTR_DB_SYSTEM = ATTR_DB_SYSTEM;
exports.ATTR_NET_PEER_NAME = ATTR_NET_PEER_NAME;
exports.ATTR_NET_PEER_PORT = ATTR_NET_PEER_PORT;
exports.DB_SYSTEM_NAME_VALUE_REDIS = DB_SYSTEM_NAME_VALUE_REDIS;
exports.DB_SYSTEM_VALUE_REDIS = DB_SYSTEM_VALUE_REDIS;
//# sourceMappingURL=semconv.js.map

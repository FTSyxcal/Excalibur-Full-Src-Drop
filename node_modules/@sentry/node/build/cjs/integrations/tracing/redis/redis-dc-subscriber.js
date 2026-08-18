Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

const core = require('@sentry/core');
const tracingChannel = require('@sentry/opentelemetry/tracing-channel');
const redisCommon = require('./vendored/redis-common.js');
const semconv = require('./vendored/semconv.js');

// Channel names as published by node-redis >= 5.12.0.
// Hardcoded so we don't import `redis` at module-load time.
const CHANNEL_COMMAND = 'node-redis:command';
const CHANNEL_BATCH = 'node-redis:batch';
const CHANNEL_CONNECT = 'node-redis:connect';

const ORIGIN = 'auto.db.redis.diagnostic_channel';

const NOOP = () => {};

let subscribed = false;
let currentResponseHook;

/**
 * Subscribe Sentry handlers to node-redis diagnostics_channel events (>= 5.12.0).
 *
 * Uses `@sentry/opentelemetry/tracing-channel` so OTel AsyncLocalStorage context propagates
 * automatically via `bindStore` — without it, spans created in `start` would not become
 * the active context for subsequent operations.
 *
 * Safe on every runtime that exposes `node:diagnostics_channel` (Node, Bun, Deno, Workers).
 * In node-redis < 5.12.0 the channels are never published to, so subscribers are inert and
 * there is no double-instrumentation against the IITM-based patcher (gated to < 5.12.0).
 */
function subscribeRedisDiagnosticChannels(responseHook) {
  currentResponseHook = responseHook;
  if (subscribed) return;

  try {
    setupCommandChannel();
    setupBatchChannel();
    setupConnectChannel();
    subscribed = true;
  } catch {
    // tracingChannel from @sentry/opentelemetry requires `node:diagnostics_channel`.
    // On runtimes where it isn't available, fail closed.
  }
}

function setupCommandChannel() {
  const channel = tracingChannel.tracingChannel(CHANNEL_COMMAND, data => {
    // node-redis >= 5.12.0 includes the command name as args[0] in the DC payload.
    // Strip it so serialization and cache key extraction see only the actual arguments.
    const actualArgs = data.args.slice(1);
    const statement = safeSerialize(data.command, actualArgs);
    return core.startSpanManual(
      {
        name: `redis-${data.command}`,
        attributes: {
          [core.SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: ORIGIN,
          [core.SEMANTIC_ATTRIBUTE_SENTRY_OP]: 'db.redis',
          [semconv.ATTR_DB_SYSTEM]: semconv.DB_SYSTEM_VALUE_REDIS,
          ...(statement != null ? { [semconv.ATTR_DB_STATEMENT]: statement } : {}),
          ...(data.serverAddress != null ? { [semconv.ATTR_NET_PEER_NAME]: data.serverAddress } : {}),
          ...(data.serverPort != null ? { [semconv.ATTR_NET_PEER_PORT]: data.serverPort } : {}),
        },
      },
      span => span,
    ) ;
  });

  channel.subscribe({
    start: NOOP,
    asyncStart: NOOP,
    end: NOOP,
    asyncEnd: data => {
      const span = data._sentrySpan;
      // only end if error handler isn't going to
      if (!span || data.error) return;
      // Same slice: strip command name from args before passing to the response hook.
      runResponseHook(span, data.command, data.args.slice(1), data.result);
      span.end();
    },
    error: data => {
      const span = data._sentrySpan;
      if (!span) return;
      if (data.error) {
        span.setStatus({ code: core.SPAN_STATUS_ERROR, message: data.error.message });
      }
      span.end();
    },
  });
}

function setupBatchChannel() {
  const channel = tracingChannel.tracingChannel(CHANNEL_BATCH, data => {
    const operationName = data.batchMode === 'PIPELINE' ? 'PIPELINE' : 'MULTI';

    return core.startSpanManual(
      {
        name: operationName,
        attributes: {
          [core.SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: ORIGIN,
          [core.SEMANTIC_ATTRIBUTE_SENTRY_OP]: 'db.redis',
          [semconv.ATTR_DB_SYSTEM]: semconv.DB_SYSTEM_VALUE_REDIS,
          ...(data.batchSize != null ? { 'db.redis.batch_size': data.batchSize } : {}),
          ...(data.serverAddress != null ? { [semconv.ATTR_NET_PEER_NAME]: data.serverAddress } : {}),
          ...(data.serverPort != null ? { [semconv.ATTR_NET_PEER_PORT]: data.serverPort } : {}),
        },
      },
      span => span,
    ) ;
  });

  channel.subscribe({
    start: NOOP,
    asyncStart: NOOP,
    end: NOOP,
    asyncEnd: data => {
      // only end if the error handler isn't going to
      if (!data.error) data._sentrySpan?.end();
    },
    error: data => {
      const span = data._sentrySpan;
      if (!span) return;
      if (data.error) {
        span.setStatus({ code: core.SPAN_STATUS_ERROR, message: data.error.message });
      }
      span.end();
    },
  });
}

function setupConnectChannel() {
  const channel = tracingChannel.tracingChannel(CHANNEL_CONNECT, data => {
    return core.startSpanManual(
      {
        name: 'redis-connect',
        attributes: {
          [core.SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: ORIGIN,
          [core.SEMANTIC_ATTRIBUTE_SENTRY_OP]: 'db.redis.connect',
          [semconv.ATTR_DB_SYSTEM]: semconv.DB_SYSTEM_VALUE_REDIS,
          ...(data.serverAddress != null ? { [semconv.ATTR_NET_PEER_NAME]: data.serverAddress } : {}),
          ...(data.serverPort != null ? { [semconv.ATTR_NET_PEER_PORT]: data.serverPort } : {}),
        },
      },
      span => span,
    ) ;
  });

  channel.subscribe({
    start: NOOP,
    asyncStart: NOOP,
    end: NOOP,
    asyncEnd: data => {
      // only end if the error handler isn't going to
      if (!data.error) data._sentrySpan?.end();
    },
    error: data => {
      const span = data._sentrySpan;
      if (!span) return;
      if (data.error) {
        span.setStatus({ code: core.SPAN_STATUS_ERROR, message: data.error.message });
      }
      span.end();
    },
  });
}

function runResponseHook(span, command, args, result) {
  const hook = currentResponseHook;
  if (!hook) return;
  try {
    hook(span, command, args , result);
  } catch {
    // never let user hooks break instrumentation
  }
}

function safeSerialize(command, args) {
  try {
    return redisCommon.defaultDbStatementSerializer(command, args);
  } catch {
    return undefined;
  }
}

exports.subscribeRedisDiagnosticChannels = subscribeRedisDiagnosticChannels;
//# sourceMappingURL=redis-dc-subscriber.js.map

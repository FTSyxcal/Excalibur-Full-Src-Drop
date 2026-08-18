Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

const diagnosticsChannel = require('node:diagnostics_channel');
const api = require('@opentelemetry/api');
const core$1 = require('@opentelemetry/core');
const instrumentation = require('@opentelemetry/instrumentation');
const core = require('@sentry/core');
const constants = require('./constants.js');
const nodeVersion = require('../../nodeVersion.js');
const node_events = require('node:events');
const http = require('node:http');
const https = require('node:https');

const FULLY_SUPPORTS_HTTP_DIAGNOSTICS_CHANNEL =
  (nodeVersion.NODE_VERSION.major === 22 && nodeVersion.NODE_VERSION.minor >= 12) ||
  (nodeVersion.NODE_VERSION.major === 23 && nodeVersion.NODE_VERSION.minor >= 2) ||
  nodeVersion.NODE_VERSION.major >= 24;

/**
 * This custom HTTP instrumentation handles outgoing HTTP requests.
 *
 * It provides:
 * - Breadcrumbs for all outgoing requests
 * - Trace propagation headers (when enabled)
 * - Span creation for outgoing requests (when createSpansForOutgoingRequests is enabled)
 *
 * Span creation requires Node 22+ and uses diagnostic channels to avoid monkey-patching.
 * By default, this is only enabled in the node SDK, not in node-core or other runtime SDKs.
 *
 * Important note: Contrary to other OTEL instrumentation, this one cannot be unwrapped.
 *
 * This is heavily inspired & adapted from:
 * https://github.com/open-telemetry/opentelemetry-js/blob/f8ab5592ddea5cba0a3b33bf8d74f27872c0367f/experimental/packages/opentelemetry-instrumentation-http/src/http.ts
 */
class SentryHttpInstrumentation extends instrumentation.InstrumentationBase {
   constructor(config = {}) {
    super(constants.INSTRUMENTATION_NAME, core.SDK_VERSION, config);
  }

  /** @inheritdoc */
   init() {
    const { outgoingRequestApplyCustomAttributes: applyCustomAttributesOnSpan, ...options } = this.getConfig();
    const patchOptions = {
      propagateTrace: options.propagateTraceInOutgoingRequests,
      applyCustomAttributesOnSpan,
      ...options,
      spans: options.createSpansForOutgoingRequests && (options.spans ?? true),
      ignoreOutgoingRequests(url, request) {
        return (
          core$1.isTracingSuppressed(api.context.active()) ||
          !!options.ignoreOutgoingRequests?.(url, core.getRequestOptions(request ))
        );
      },
      outgoingRequestHook(span, request) {
        options.outgoingRequestHook?.(span, request);
        // We monkey-patch `req.once('response'), which is used to trigger
        // the callback of the request, so that it runs in the active context
        // eslint-disable-next-line @typescript-eslint/unbound-method, deprecation/deprecation
        const originalOnce = request.once;

        const newOnce = new Proxy(originalOnce, {
          apply(target, thisArg, args) {
            const [event] = args;
            if (event !== 'response') {
              return target.apply(thisArg, args);
            }

            const parentContext = api.context.active();
            const requestContext = api.trace.setSpan(parentContext, span);

            return api.context.with(requestContext, () => {
              return target.apply(thisArg, args);
            });
          },
        });

        // eslint-disable-next-line deprecation/deprecation
        request.once = newOnce;
      },
      outgoingResponseHook(span, response) {
        options.outgoingResponseHook?.(span, response);
        api.context.bind(api.context.active(), response);
      },
      errorMonitor: node_events.errorMonitor,
      // Pass these in to detect OTel double-wrapping if we're enabling spans
      http,
      https,
    };

    // only generate the subscriber function if we'll actually use it
    const { [core.HTTP_ON_CLIENT_REQUEST]: onHttpClientRequestCreated } = FULLY_SUPPORTS_HTTP_DIAGNOSTICS_CHANNEL
      ? core.getHttpClientSubscriptions(patchOptions)
      : {};

    // guard because we cover both http and https with the same subscribers
    let hasRegisteredHandlers = false;
    const sub = onHttpClientRequestCreated
      ? (moduleExports) => {
          if (!hasRegisteredHandlers && onHttpClientRequestCreated) {
            hasRegisteredHandlers = true;
            diagnosticsChannel.subscribe(core.HTTP_ON_CLIENT_REQUEST, onHttpClientRequestCreated);
          }
          return moduleExports;
        }
      : undefined;

    const wrapHttp = sub ?? ((moduleExports) => core.patchHttpModuleClient(moduleExports, patchOptions));

    const wrapHttps = sub ?? ((moduleExports) => core.patchHttpModuleClient(moduleExports, patchOptions));

    /**
     * You may be wondering why we register these diagnostics-channel listeners
     * in such a convoluted way (as InstrumentationNodeModuleDefinition...)˝,
     * instead of simply subscribing to the events once in here.
     * The reason for this is timing semantics: These functions are called once the http or https module is loaded.
     * If we'd subscribe before that, there seem to be conflicts with the OTEL native instrumentation in some scenarios,
     * especially the "import-on-top" pattern of setting up ESM applications.
     */
    return [
      new instrumentation.InstrumentationNodeModuleDefinition('http', ['*'], wrapHttp),
      new instrumentation.InstrumentationNodeModuleDefinition('https', ['*'], wrapHttps),
    ];
  }
}

exports.SentryHttpInstrumentation = SentryHttpInstrumentation;
//# sourceMappingURL=SentryHttpInstrumentation.js.map

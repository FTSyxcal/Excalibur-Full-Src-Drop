import { subscribe } from 'node:diagnostics_channel';
import { getHttpClientSubscriptions, getRequestOptions, HTTP_ON_CLIENT_REQUEST, getCurrentScope, SUPPRESS_TRACING_KEY, getRequestUrlFromClientRequest, addOutgoingRequestBreadcrumb, debug, getIsolationScope, httpRequestToRequestData, stripUrlQueryAndFragment, withIsolationScope, continueTrace, generateSpanId } from '@sentry/core';
import { DEBUG_BUILD } from '../../debug-build.js';
import { patchRequestToCaptureBody } from '../../utils/captureRequestBody.js';
import { errorMonitor } from 'node:events';
import { NODE_VERSION } from '../../nodeVersion.js';

const INTEGRATION_NAME = 'Http';

const FULLY_SUPPORTS_HTTP_DIAGNOSTICS_CHANNEL =
  (NODE_VERSION.major === 22 && NODE_VERSION.minor >= 12) ||
  (NODE_VERSION.major === 23 && NODE_VERSION.minor >= 2) ||
  NODE_VERSION.major >= 24;

// We keep track of emit functions we wrapped, to avoid double wrapping
const wrappedEmitFns = new WeakSet();

const _httpIntegration = ((options = {}) => {
  const _options = {
    ...options,
    maxRequestBodySize: options.maxRequestBodySize ?? 'medium',
    ignoreRequestBody: options.ignoreRequestBody,
    breadcrumbs: options.breadcrumbs ?? true,
    tracePropagation: options.tracePropagation ?? true,
    ignoreOutgoingRequests: options.ignoreOutgoingRequests,
  };

  return {
    name: INTEGRATION_NAME,
    setupOnce() {
      const onHttpServerRequestStart = (_data) => {
        const data = _data ;
        instrumentServer(data.server, _options);
      };

      const { ignoreOutgoingRequests } = _options;

      const { [HTTP_ON_CLIENT_REQUEST]: onHttpClientRequestCreated } = getHttpClientSubscriptions({
        breadcrumbs: _options.breadcrumbs,
        propagateTrace: _options.tracePropagation,
        ignoreOutgoingRequests: ignoreOutgoingRequests
          ? (url, request) => ignoreOutgoingRequests(url, getRequestOptions(request ))
          : undefined,
        // No spans in light mode
        // means we don't have pass modules to detect OTel double-wrap
        spans: false,
        errorMonitor,
      });

      subscribe('http.server.request.start', onHttpServerRequestStart);

      // Subscribe on the request creation in node versions that support it
      subscribe(HTTP_ON_CLIENT_REQUEST, onHttpClientRequestCreated);

      // fall back to just doing breadcrumbs on the request.end() channel
      // if we do not have earlier access to the request object at creation
      // time. The http.client.request.error channel is only available on
      // the same node versions as client.request.created, so no help.
      if (_options.breadcrumbs && !FULLY_SUPPORTS_HTTP_DIAGNOSTICS_CHANNEL) {
        subscribe('http.client.request.start', (data) => {
          const { request } = data ;
          request.on(errorMonitor, () => onOutgoingResponseFinish(request, undefined, _options));
          request.prependListener('response', response => {
            if (request.listenerCount('response') <= 1) {
              response.resume();
            }
            onOutgoingResponseFinish(request, response, _options);
          });
        });
      }
    },
  };
}) ;

function onOutgoingResponseFinish(
  request,
  response,
  options

,
) {
  if (!options.breadcrumbs) {
    return;
  }
  // Check if tracing is suppressed (e.g. for Sentry's own transport requests)
  if (getCurrentScope().getScopeData().sdkProcessingMetadata[SUPPRESS_TRACING_KEY]) {
    return;
  }
  const { ignoreOutgoingRequests } = options;
  if (ignoreOutgoingRequests) {
    const url = getRequestUrlFromClientRequest(request );
    if (ignoreOutgoingRequests(url, getRequestOptions(request ))) {
      return;
    }
  }
  addOutgoingRequestBreadcrumb(request, response);
}

/**
 * This integration handles incoming and outgoing HTTP requests in light mode (without OpenTelemetry).
 *
 * It uses Node's native diagnostics channels (Node.js 22+) for request isolation,
 * trace propagation, and breadcrumb creation.
 */
const httpIntegration = _httpIntegration

;

/**
 * Instrument a server to capture incoming requests.
 */
function instrumentServer(
  server,
  {
    ignoreRequestBody,
    maxRequestBodySize,
  }

,
) {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalEmit = server.emit;

  if (wrappedEmitFns.has(originalEmit)) {
    return;
  }

  const newEmit = new Proxy(originalEmit, {
    apply(target, thisArg, args) {
      // Only handle request events
      if (args[0] !== 'request') {
        return target.apply(thisArg, args);
      }

      const client = getCurrentScope().getClient();

      if (!client) {
        return target.apply(thisArg, args);
      }

      DEBUG_BUILD && debug.log(INTEGRATION_NAME, 'Handling incoming request');

      const isolationScope = getIsolationScope().clone();
      const request = args[1] ;

      const normalizedRequest = httpRequestToRequestData(request);

      // request.ip is non-standard but some frameworks set this
      const ipAddress = (request ).ip || request.socket?.remoteAddress;

      const url = request.url || '/';
      if (maxRequestBodySize !== 'none' && !ignoreRequestBody?.(url, request)) {
        patchRequestToCaptureBody(request, isolationScope, maxRequestBodySize, INTEGRATION_NAME);
      }

      // Update the isolation scope, isolate this request
      isolationScope.setSDKProcessingMetadata({ normalizedRequest, ipAddress });

      // attempt to update the scope's `transactionName` based on the request URL
      // Ideally, framework instrumentations coming after the HttpInstrumentation
      // update the transactionName once we get a parameterized route.
      const httpMethod = (request.method || 'GET').toUpperCase();
      const httpTargetWithoutQueryFragment = stripUrlQueryAndFragment(url);

      const bestEffortTransactionName = `${httpMethod} ${httpTargetWithoutQueryFragment}`;

      isolationScope.setTransactionName(bestEffortTransactionName);

      return withIsolationScope(isolationScope, () => {
        // Handle trace propagation using Sentry's continueTrace
        // This replaces OpenTelemetry's propagation.extract() + context.with()
        const sentryTrace = normalizedRequest.headers?.['sentry-trace'];
        const baggage = normalizedRequest.headers?.['baggage'];

        return continueTrace(
          {
            sentryTrace: Array.isArray(sentryTrace) ? sentryTrace[0] : sentryTrace,
            baggage: Array.isArray(baggage) ? baggage[0] : baggage,
          },
          () => {
            // Set propagationSpanId after continueTrace because it calls withScope +
            // setPropagationContext internally, which would overwrite any previously set value.
            getCurrentScope().getPropagationContext().propagationSpanId = generateSpanId();
            return target.apply(thisArg, args);
          },
        );
      });
    },
  });

  wrappedEmitFns.add(newEmit);
  server.emit = newEmit;
}

export { httpIntegration };
//# sourceMappingURL=httpIntegration.js.map

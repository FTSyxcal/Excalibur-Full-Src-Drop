import { defineIntegration, hasSpansEnabled, getRequestUrlFromClientRequest, stripDataUrlContent, SEMANTIC_ATTRIBUTE_URL_FULL } from '@sentry/core';
import { generateInstrumentOnce, SentryHttpInstrumentation, httpServerIntegration, httpServerSpansIntegration } from '@sentry/node-core';

const INTEGRATION_NAME = 'Http';

// TODO(v11): Consolidate all the various HTTP integration options into one,
// and deprecate the duplicated and aliased options.

const instrumentSentryHttp = generateInstrumentOnce(
  `${INTEGRATION_NAME}.sentry`,
  options => {
    return new SentryHttpInstrumentation(options);
  },
);

/**
 * The http integration instruments Node's internal http and https modules.
 * It creates breadcrumbs and spans for outgoing HTTP requests which will be attached to the currently active span.
 */
const httpIntegration = defineIntegration((options = {}) => {
  const spans = options.spans ?? true;
  const disableIncomingRequestSpans = options.disableIncomingRequestSpans;
  const enableServerSpans = spans && !disableIncomingRequestSpans;

  const serverOptions = {
    sessions: options.trackIncomingRequestsAsSessions,
    sessionFlushingDelayMS: options.sessionFlushingDelayMS,
    ignoreRequestBody: options.ignoreIncomingRequestBody,
    maxRequestBodySize: options.maxIncomingRequestBodySize,
  } ;

  const serverSpansOptions = {
    ignoreIncomingRequests: options.ignoreIncomingRequests,
    ignoreStaticAssets: options.ignoreStaticAssets,
    ignoreStatusCodes: options.dropSpansForIncomingRequestStatusCodes,
    instrumentation: options.instrumentation,
    onSpanCreated: options.incomingRequestSpanHook,
  };

  const server = httpServerIntegration(serverOptions);
  const serverSpans = httpServerSpansIntegration(serverSpansOptions);

  return {
    name: INTEGRATION_NAME,
    setup(client) {
      const clientOptions = client.getOptions();

      if (enableServerSpans && hasSpansEnabled(clientOptions)) {
        serverSpans.setup(client);
      }
    },
    setupOnce() {
      server.setupOnce();

      const sentryHttpInstrumentationOptions = {
        breadcrumbs: options.breadcrumbs,
        spans,
        propagateTraceInOutgoingRequests: options.tracePropagation ?? true,
        createSpansForOutgoingRequests: spans,
        ignoreOutgoingRequests: options.ignoreOutgoingRequests,
        outgoingRequestHook: (span, request) => {
          // Sanitize data URLs to prevent long base64 strings in span attributes
          const url = getRequestUrlFromClientRequest(request);
          if (url.startsWith('data:')) {
            const sanitizedUrl = stripDataUrlContent(url);
            // TODO(v11): Update these to the Sentry semantic attributes.
            // https://getsentry.github.io/sentry-conventions/attributes/
            span.setAttribute('http.url', sanitizedUrl);
            span.setAttribute(SEMANTIC_ATTRIBUTE_URL_FULL, sanitizedUrl);
            span.updateName(`${request.method || 'GET'} ${sanitizedUrl}`);
          }
          options.instrumentation?.requestHook?.(span, request);
        },
        outgoingResponseHook: options.instrumentation?.responseHook,
        outgoingRequestApplyCustomAttributes: options.instrumentation?.applyCustomAttributesOnSpan,
      };

      // This is Sentry-specific instrumentation for outgoing request
      // breadcrumbs & trace propagation. It uses the diagnostic channels on
      // node versions that support it, falling back to monkey-patching when
      // needed.
      instrumentSentryHttp(sentryHttpInstrumentationOptions);
    },
    processEvent(event) {
      // Always run this, even if spans are disabled
      // The reason being that e.g. the remix integration disables span
      // creation here but still wants to use the ignore status codes option
      return serverSpans.processEvent(event);
    },
  };
});

export { httpIntegration, instrumentSentryHttp };
//# sourceMappingURL=http.js.map

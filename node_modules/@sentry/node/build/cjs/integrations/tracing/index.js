Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

const http = require('../http.js');
const amqplib = require('./amqplib.js');
const index$7 = require('./anthropic-ai/index.js');
const connect = require('./connect.js');
const express = require('./express.js');
const index = require('./fastify/index.js');
const firebase = require('./firebase/firebase.js');
const genericPool = require('./genericPool.js');
const index$8 = require('./google-genai/index.js');
const graphql = require('./graphql.js');
const index$1 = require('./hapi/index.js');
const index$2 = require('./hono/index.js');
const kafka = require('./kafka.js');
const koa = require('./koa.js');
const index$4 = require('./langchain/index.js');
const index$9 = require('./langgraph/index.js');
const lrumemoizer = require('./lrumemoizer.js');
const mongo = require('./mongo.js');
const mongoose = require('./mongoose.js');
const mysql = require('./mysql.js');
const mysql2 = require('./mysql2.js');
const index$6 = require('./openai/index.js');
const postgres = require('./postgres.js');
const postgresjs = require('./postgresjs.js');
const prisma = require('./prisma.js');
const index$3 = require('./redis/index.js');
const tedious = require('./tedious.js');
const index$5 = require('./vercelai/index.js');

/**
 * With OTEL, all performance integrations will be added, as OTEL only initializes them when the patched package is actually required.
 */
function getAutoPerformanceIntegrations() {
  return [
    express.expressIntegration(),
    index.fastifyIntegration(),
    graphql.graphqlIntegration(),
    index$2.honoIntegration(),
    mongo.mongoIntegration(),
    mongoose.mongooseIntegration(),
    mysql.mysqlIntegration(),
    mysql2.mysql2Integration(),
    index$3.redisIntegration(),
    postgres.postgresIntegration(),
    prisma.prismaIntegration(),
    index$1.hapiIntegration(),
    koa.koaIntegration(),
    connect.connectIntegration(),
    tedious.tediousIntegration(),
    genericPool.genericPoolIntegration(),
    kafka.kafkaIntegration(),
    amqplib.amqplibIntegration(),
    lrumemoizer.lruMemoizerIntegration(),
    // AI providers
    // LangChain must come first to disable AI provider integrations before they instrument
    index$4.langChainIntegration(),
    index$9.langGraphIntegration(),
    index$5.vercelAIIntegration(),
    index$6.openAIIntegration(),
    index$7.anthropicAIIntegration(),
    index$8.googleGenAIIntegration(),
    postgresjs.postgresJsIntegration(),
    firebase.firebaseIntegration(),
  ];
}

/**
 * Get a list of methods to instrument OTEL, when preload instrumentation.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getOpenTelemetryInstrumentationToPreload() {
  return [
    http.instrumentSentryHttp,
    express.instrumentExpress,
    connect.instrumentConnect,
    index.instrumentFastify,
    index.instrumentFastifyV3,
    index$1.instrumentHapi,
    index$2.instrumentHono,
    kafka.instrumentKafka,
    koa.instrumentKoa,
    lrumemoizer.instrumentLruMemoizer,
    mongo.instrumentMongo,
    mongoose.instrumentMongoose,
    mysql.instrumentMysql,
    mysql2.instrumentMysql2,
    postgres.instrumentPostgres,
    index$1.instrumentHapi,
    graphql.instrumentGraphql,
    index$3.instrumentRedis,
    tedious.instrumentTedious,
    genericPool.instrumentGenericPool,
    amqplib.instrumentAmqplib,
    index$4.instrumentLangChain,
    index$5.instrumentVercelAi,
    index$6.instrumentOpenAi,
    postgresjs.instrumentPostgresJs,
    firebase.instrumentFirebase,
    index$7.instrumentAnthropicAi,
    index$8.instrumentGoogleGenAI,
    index$9.instrumentLangGraph,
  ];
}

exports.getAutoPerformanceIntegrations = getAutoPerformanceIntegrations;
exports.getOpenTelemetryInstrumentationToPreload = getOpenTelemetryInstrumentationToPreload;
//# sourceMappingURL=index.js.map

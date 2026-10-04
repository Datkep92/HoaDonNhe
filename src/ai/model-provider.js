'use strict';
const { callAI } = require('./openrouter-client');
const { minimizeMessages } = require('./data-minimizer');
function createModelProvider({ config, fetchImpl }) {
  const request = input => callAI({ ...input, messages: minimizeMessages(input.messages, config), config, fetchImpl });
  return Object.freeze({
    capabilities: () => ({ protocol: 'openai-compatible', streaming: true, nativeTools: true, structuredOutput: true, model: config.model }),
    chat: request,
    stream: request,
    toolCall: request,
    structuredOutput: input => request({ ...input, structured: true }),
  });
}
module.exports = { createModelProvider };

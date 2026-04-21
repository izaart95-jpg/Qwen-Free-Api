"use strict";

module.exports = {
  parentIdControl: true,  // true=threading, false=always null
  
  server: {
    port: parseInt(process.env.PORT || "3456"),
    host: "0.0.0.0",
  },

  // Your Qwen token (from localStorage.getItem('token') or the cookie)
  qwen: {
    token: process.env.QWEN_TOKEN || "YOUR_QWEN_TOKEN_HERE",
    baseUrl: "https://chat.qwen.ai",
    defaultModel: "qwen3.6-plus",
  },

  // Auth for THIS proxy — clients must send this to talk to us
  auth: {
    enabled: process.env.AUTH_ENABLED !== "false",
    token: process.env.AUTH_TOKEN || "Waguri",
  },

  // Parse XML/JSON tool calls from model output and re-emit as proper tool_use blocks
  parseTool: process.env.PARSE_TOOL !== "false",

  logging: {
    level: process.env.LOG_LEVEL || "info", // "debug" | "info"
  },
};

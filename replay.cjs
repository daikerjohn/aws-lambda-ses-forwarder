const fs = require("node:fs");
const path = require("node:path");

function loadJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function extractRecipientFromEmailContent(emailContent) {
  const toMatch = emailContent.match(/^To:\s*(.+)$/im);
  const recipient = toMatch && toMatch[1] ? toMatch[1].trim() : "unknown@example.com";
  return recipient.replace(/^<|>$/g, "").replace(/.*<([^>]+)>.*$/, "$1");
}

function buildEventFromEmailContent(emailContent, messageId = "replay-message") {
  const recipient = extractRecipientFromEmailContent(emailContent);
  return {
    Records: [{
      eventSource: "aws:ses",
      eventVersion: "1.0",
      ses: {
        mail: {
          messageId
        },
        receipt: {
          recipients: [recipient],
          spamVerdict: { status: "PASS" },
          virusVerdict: { status: "PASS" }
        }
      }
    }]
  };
}

function createLocalOverrides(emailContent) {
  return {
    s3: {
      send: (command, callback) => {
        if (typeof callback === "function") {
          callback(null, {
            Body: {
              transformToString: async () => emailContent
            }
          });
        }
      }
    },
    ses: {
      send: (command, callback) => {
        if (typeof callback === "function") {
          callback(null, { MessageId: "local-replay-message" });
        }
      }
    },
    log: (entry) => {
      if (entry && typeof entry === "object") {
        console.log(entry.message || JSON.stringify(entry));
      } else {
        console.log(entry);
      }
    }
  };
}

async function replayFromEventFile(eventFilePath, options = {}) {
  const resolvedEventFilePath = path.resolve(eventFilePath);
  let event;
  let messageId = options.messageId || "replay-message";

  try {
    event = loadJsonFile(resolvedEventFilePath);
  } catch (err) {
    const emailContent = fs.readFileSync(resolvedEventFilePath, "utf8");
    event = buildEventFromEmailContent(emailContent, messageId);
    event.emailContent = emailContent;
  }
  const context = options.context || {};
  const config = options.config || {};

  const callback = options.callback || function(err) {
    if (err) {
      throw err;
    }
  };

  const importedIndex = await import("./index.mjs");
  const configPath = options.configPath ? path.resolve(options.configPath) : null;
  const defaultConfig = importedIndex.defaultConfig || {};
  let finalConfig = {
    ...defaultConfig,
    ...config,
    forwardMapping: {
      ...(defaultConfig.forwardMapping || {}),
      ...(config.forwardMapping || {})
    }
  };

  if (configPath) {
    const fileConfig = loadJsonFile(configPath);
    finalConfig = {
      ...defaultConfig,
      ...config,
      ...fileConfig,
      forwardMapping: {
        ...(defaultConfig.forwardMapping || {}),
        ...(config.forwardMapping || {}),
        ...(fileConfig.forwardMapping || {})
      }
    };
  }
  const handler = options.handler || importedIndex.handler;
  const useLocalOverrides = Boolean(event.emailContent) || options.replayMode === "s3";
  const overrides = {
    config: finalConfig,
    log: options.log || console.log
  };

  if (useLocalOverrides) {
    const localOverrides = createLocalOverrides(event.emailContent || "");
    overrides.s3 = localOverrides.s3;
    overrides.ses = localOverrides.ses;
    overrides.log = localOverrides.log;
  }

  return new Promise((resolve, reject) => {
    const wrappedCallback = function(err) {
      if (err) {
        reject(err);
        return;
      }
      resolve({ event, context, config: finalConfig, emailContent: event.emailContent });
    };

    try {
      handler(event, context, wrappedCallback, overrides);
    } catch (err) {
      reject(err);
    }
  });
}

async function replayFromEventFileCli(argv = process.argv.slice(2)) {
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    throw new Error("Usage: node replay.cjs <event-file> [config-file]");
  }

  const [eventFilePath, configFilePath] = argv;
  const result = await replayFromEventFile(eventFilePath, { configPath: configFilePath });
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  replayFromEventFileCli().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  replayFromEventFile,
  replayFromEventFileCli,
  loadJsonFile
};

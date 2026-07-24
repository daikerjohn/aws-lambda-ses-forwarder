const fs = require("node:fs");
const path = require("node:path");
const { S3Client, CopyObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { SESv2Client } = require("@aws-sdk/client-sesv2");

function loadJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadReplayConfig(configPath) {
  if (!configPath) {
    return null;
  }

  const resolvedPath = path.resolve(configPath);
  return loadJsonFile(resolvedPath);
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

function createAwsOverrides(emailContent, options = {}) {
  const region = options.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
  const sesClient = options.sesClientFactory
    ? options.sesClientFactory({ region })
    : new SESv2Client({ region });
  const s3Client = options.s3ClientFactory
    ? options.s3ClientFactory({ region })
    : new S3Client({ region, signatureVersion: "v4" });

  return {
    s3: {
      send: (command, callback) => {
        if (typeof callback !== "function") {
          return;
        }

        if (command instanceof CopyObjectCommand) {
          callback(null, {});
          return;
        }

        if (command instanceof GetObjectCommand) {
          callback(null, {
            Body: {
              transformToString: async () => emailContent
            }
          });
          return;
        }

        callback(null, {});
      },
      client: s3Client
    },
    ses: {
      send: (command, callback) => {
        if (typeof callback !== "function") {
          return;
        }

        const promise = Promise.resolve().then(() => sesClient.send(command));
        promise.then((result) => callback(null, result)).catch((err) => callback(err));
      },
      client: sesClient
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

  const importedIndex = await import("./index.js");
  const configPath = options.configPath ? path.resolve(options.configPath) : null;
  const replayConfig = loadReplayConfig(options.replayConfigPath || options.configPath);
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

  const awsOptions = replayConfig && replayConfig.aws ? replayConfig.aws : {};
  const mergedOptions = {
    ...options,
    ...awsOptions,
    region: options.region || awsOptions.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1"
  };
  const handler = options.handler || importedIndex.handler;
  const useLocalOverrides = Boolean(event.emailContent) || options.replayMode === "s3";
  const useAwsOverrides = Boolean(mergedOptions.send) || options.replayMode === "aws";
  const overrides = {
    config: finalConfig,
    log: options.log || console.log
  };

  if (useAwsOverrides) {
    const awsOverrides = createAwsOverrides(event.emailContent || "", mergedOptions);
    overrides.s3 = awsOverrides.s3;
    overrides.ses = awsOverrides.ses;
    overrides.log = awsOverrides.log;
  } else if (useLocalOverrides) {
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
    throw new Error("Usage: node replay.cjs <event-file> [config-file] [--send] [--region <region>]");
  }

  let eventFilePath;
  let configFilePath;
  let replayConfigPath;
  let send = false;
  let region;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--send" || arg === "--live" || arg === "--real") {
      send = true;
    } else if (arg === "--region") {
      region = argv[index + 1];
      index += 1;
    } else if (arg === "--replay-config") {
      replayConfigPath = argv[index + 1];
      index += 1;
    } else if (!eventFilePath) {
      eventFilePath = arg;
    } else if (!configFilePath) {
      configFilePath = arg;
    } else {
      throw new Error("Unexpected argument: " + arg);
    }
  }

  if (!eventFilePath) {
    throw new Error("Usage: node replay.cjs <event-file> [config-file] [--send] [--region <region>]");
  }

  const result = await replayFromEventFile(eventFilePath, {
    configPath: configFilePath,
    replayConfigPath,
    send,
    region
  });
  //console.log(JSON.stringify(result, null, 2));
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

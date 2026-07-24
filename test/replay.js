/* global describe, it */

var assert = require("assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

describe("replay entrypoint", function() {
  it("should replay an event payload from a JSON file", async function() {
    var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ses-forwarder-"));
    var eventPath = path.join(tmpDir, "event.json");
    var configPath = path.join(tmpDir, "config.json");
    var event = {
      Records: [{
        eventSource: "aws:ses",
        eventVersion: "1.0",
        ses: {
          mail: { messageId: "msg-123" },
          receipt: {
            recipients: ["info@example.com"],
            spamVerdict: { status: "PASS" },
            virusVerdict: { status: "PASS" }
          }
        }
      }]
    };

    fs.writeFileSync(eventPath, JSON.stringify(event));
    fs.writeFileSync(configPath, JSON.stringify({
      fromEmail: "replay@example.com",
      forwardMapping: {
        "info@example.com": ["target@example.com"]
      }
    }));

    var replay = await import("../replay.mjs");
    var seen = {};

    await replay.replayFromEventFile(eventPath, {
      configPath: configPath,
      handler: function(eventArg, contextArg, callback, overrides) {
        seen.eventArg = eventArg;
        seen.contextArg = contextArg;
        seen.overrides = overrides;
        callback(null);
      }
    });

    assert.deepStrictEqual(seen.eventArg, event);
    assert.deepStrictEqual(seen.contextArg, {});
    assert.strictEqual(seen.overrides.config.fromEmail, "replay@example.com");
    assert.strictEqual(seen.overrides.config.forwardMapping["info@example.com"][0], "target@example.com");
  });

  it("should use the handler default config for raw email replay", async function() {
    var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ses-forwarder-"));
    var emailPath = path.join(tmpDir, "message.eml");
    var emailContent = [
      "From: sender@example.com",
      "To: timbers@daikerjohn.cc",
      "Subject: Hello",
      "",
      "This is the body"
    ].join("\r\n");

    fs.writeFileSync(emailPath, emailContent);

    var replay = await import("../replay.mjs");
    var seen = {};

    await replay.replayFromEventFile(emailPath, {
      handler: function(eventArg, contextArg, callback, overrides) {
        seen.overrides = overrides;
        callback(null);
      }
    });

    assert.ok(seen.overrides && seen.overrides.config.forwardMapping["@daikerjohn.cc"]);
  });

  it("should use a real SES client when send mode is enabled", async function() {
    var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ses-forwarder-"));
    var emailPath = path.join(tmpDir, "message.eml");
    var emailContent = [
      "From: sender@example.com",
      "To: info@example.com",
      "Subject: Hello",
      "",
      "This is the body"
    ].join("\r\n");

    fs.writeFileSync(emailPath, emailContent);

    var replay = await import("../replay.mjs");
    var seen = {};
    var commands = [];

    await replay.replayFromEventFile(emailPath, {
      send: true,
      region: "us-east-1",
      sesClientFactory: function(config) {
        seen.region = config.region;
        return {
          send: function(command) {
            commands.push(command);
            return Promise.resolve({ MessageId: "live-send" });
          }
        };
      },
      handler: function(eventArg, contextArg, callback, overrides) {
        seen.overrides = overrides;
        overrides.ses.send({ command: "send" }, function(err, result) {
          seen.result = result;
          callback(null);
        });
      }
    });

    assert.strictEqual(seen.region, "us-east-1");
    assert.strictEqual(commands.length, 1);
    assert.strictEqual(seen.result.MessageId, "live-send");
  });

  it("should set up local s3 and ses overrides for raw email replay", async function() {
    var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ses-forwarder-"));
    var emailPath = path.join(tmpDir, "message.eml");
    var configPath = path.join(tmpDir, "config.json");
    var emailContent = [
      "From: sender@example.com",
      "To: info@example.com",
      "Subject: Hello",
      "",
      "This is the body"
    ].join("\r\n");

    fs.writeFileSync(emailPath, emailContent);
    fs.writeFileSync(configPath, JSON.stringify({
      fromEmail: "replay@example.com",
      forwardMapping: {
        "info@example.com": ["target@example.com"]
      }
    }));

    var replay = await import("../replay.mjs");
    var seen = {};

    await replay.replayFromEventFile(emailPath, {
      configPath: configPath,
      handler: function(eventArg, contextArg, callback, overrides) {
        seen.eventArg = eventArg;
        seen.contextArg = contextArg;
        seen.overrides = overrides;
        callback(null);
      }
    });

    assert.ok(seen.overrides && seen.overrides.s3 && typeof seen.overrides.s3.send === "function");
    assert.ok(seen.overrides && seen.overrides.ses && typeof seen.overrides.ses.send === "function");
    assert.strictEqual(seen.overrides.config.forwardMapping["info@example.com"][0], "target@example.com");
  });
});

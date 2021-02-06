"use strict";

const { parentPort, workerData } = require('worker_threads');
const { promises: fs } = require("fs");

const chalk = require("chalk");

const { getOptionsForFile } = require("./option");
const isTTY = require("./is-tty");
const { format, handleError, writeOutput } = require('./format');


/** @typedef {import('./context').Context} Context */

class ProxiedContext {
  constructor(properties) {
    Object.assign(this, properties);

    /** @type any */
    this.logger = new Proxy({}, {
      get(_target, method) {
        return (...args) => parentPort.postMessage(['log', method, args]);
      }
    });
  }
}

/** @type Context */
// @ts-ignore
const context = new ProxiedContext(workerData);

/**
 * @param {string} filename
 * @param {boolean} fileIgnored
 */
async function processFile(filename, fileIgnored) {
  const options = {
    ...getOptionsForFile(context, filename),
    filepath: filename,
  };

  if (isTTY()) {
    context.logger.log(filename, { newline: false });
  }

  let input;
  try {
    input = await fs.readFile(filename, "utf8");
  } catch (error) {
    // Add newline to split errors from filename line.
    /* istanbul ignore next */
    context.logger.log("");

    /* istanbul ignore next */
    context.logger.error(
      `Unable to read file: ${filename}\n${error.message}`
    );

    // Don't exit the process if one file failed
    /* istanbul ignore next */
    parentPort.postMessage(['setExitCode', 2]);

    /* istanbul ignore next */
    return;
  }

  if (fileIgnored) {
    writeOutput(context, { formatted: input }, options);
    return;
  }

  const start = Date.now();

  let result;
  let output;

  try {
    result = format(context, input, options);
    output = result.formatted;
  } catch (error) {
    handleError(context, filename, error);
    return;
  }

  const isDifferent = output !== input;

  if (isTTY()) {
    // Remove previously printed filename to log it with duration.
    parentPort.postMessage(['resetTTYLine'])
  }

  if (context.argv.write) {
    // Don't write the file if it won't change in order not to invalidate
    // mtime based caches.
    if (isDifferent) {
      if (!context.argv.check && !context.argv["list-different"]) {
        context.logger.log(`${filename} ${Date.now() - start}ms`);
      }

      try {
        await fs.writeFile(filename, output, "utf8");
      } catch (error) {
        /* istanbul ignore next */
        context.logger.error(
          `Unable to write file: ${filename}\n${error.message}`
        );

        // Don't exit the process if one file failed
        /* istanbul ignore next */
        parentPort.postMessage(['setExitCode', 2]);
      }
    } else if (!context.argv.check && !context.argv["list-different"]) {
      context.logger.log(`${chalk.grey(filename)} ${Date.now() - start}ms`);
    }
  } else if (context.argv["debug-check"]) {
    /* istanbul ignore else */
    if (result.filepath) {
      context.logger.log(result.filepath);
    } else {
      parentPort.postMessage(['setExitCode', 2]);
    }
  } else if (!context.argv.check && !context.argv["list-different"]) {
    writeOutput(context, result, options);
  }

  if (isDifferent) {
    if (context.argv.check) {
      context.logger.warn(filename);
    } else if (context.argv["list-different"]) {
      context.logger.log(filename);
    }
    parentPort.postMessage(['foundUnformatted']);
  }
}

parentPort.on('message', ([filename, ignored]) => {
  processFile(filename, ignored).then(() => parentPort.postMessage(['doneWork']));
});

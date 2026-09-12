/**
 * The slice of Homebridge's `Logging` this plugin uses.
 *
 * Declaring it here keeps the device layer testable without a Homebridge instance, and lets
 * every message carry the name of the robot it belongs to.
 */
export interface PluginLogger {
  debug: (message: string, ...parameters: unknown[]) => void;
  info: (message: string, ...parameters: unknown[]) => void;
  warn: (message: string, ...parameters: unknown[]) => void;
  error: (message: string, ...parameters: unknown[]) => void;
}

/**
 * Adapts Homebridge's logger, optionally promoting debug messages so they show up without
 * running the whole of Homebridge in debug mode.
 *
 * @param {PluginLogger} log The Homebridge logger.
 * @param {boolean} verbose Whether the user asked for debug logging in the plugin config.
 * @returns {PluginLogger} The logger the plugin writes through.
 */
export function pluginLogger(log: PluginLogger, verbose: boolean): PluginLogger {
  if (!verbose) {
    return log;
  }

  return {
    debug: (message, ...parameters) => log.info(message, ...parameters),
    info: (message, ...parameters) => log.info(message, ...parameters),
    warn: (message, ...parameters) => log.warn(message, ...parameters),
    error: (message, ...parameters) => log.error(message, ...parameters),
  };
}

/**
 * Prefixes every message with the name of the robot.
 *
 * @param {PluginLogger} log The platform logger.
 * @param {string} name The name of the robot.
 * @returns {PluginLogger} A logger writing through the platform one.
 */
export function deviceLogger(log: PluginLogger, name: string): PluginLogger {
  const prefix = (message: string) => `[${name}] ${message}`;

  return {
    debug: (message, ...parameters) => log.debug(prefix(message), ...parameters),
    info: (message, ...parameters) => log.info(prefix(message), ...parameters),
    warn: (message, ...parameters) => log.warn(prefix(message), ...parameters),
    error: (message, ...parameters) => log.error(prefix(message), ...parameters),
  };
}

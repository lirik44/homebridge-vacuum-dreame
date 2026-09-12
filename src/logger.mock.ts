import { jest } from '@jest/globals';

import type { PluginLogger } from './logger.js';

export type LoggerMock = jest.Mocked<PluginLogger>;

/** @returns {LoggerMock} A logger recording everything written to it. */
export const loggerMock = (): LoggerMock => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

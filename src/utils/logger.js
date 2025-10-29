/**
 * Logging utilities for the puppeteer scanner
 * Provides consistent logging with timestamps and different log levels
 */

/**
 * Get current timestamp in ISO format for logging
 * @returns {string} Formatted timestamp
 */
function getTimestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}



/**
 * General logging (without timestamp)
 * @param {string} message - Log message
 */
export function log(message) {
  console.log(message);
}

/**
 * Error logging (with timestamp)
 * @param {string} message - Error message
 */
export function error(message) {
  console.error(`[${getTimestamp()}] ${message}`);
}

/**
 * Debug logging (with timestamp) - only when debug mode is enabled
 * @param {string} message - Debug message
 * @param {boolean} debugMode - Whether debug mode is enabled
 */
export function debug(message, debugMode = false) {
  if (debugMode) {
    console.debug(`[${getTimestamp()}] [DEBUG] ${message}`);
  }
}
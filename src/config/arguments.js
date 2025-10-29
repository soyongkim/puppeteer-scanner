/**
 * Command line argument parsing and validation
 */

import { error, log } from '../utils/logger.js';

/**
 * Parse command line arguments into a structured object
 * @param {string[]} args - Command line arguments
 * @returns {Object} Parsed arguments
 */
export function parseArguments(args = process.argv.slice(2)) {
  const argMap = {};
  
  args.forEach(arg => {
    if (arg.includes('=')) {
      const [key, value] = arg.split('=');
      const cleanKey = key.replace(/^--/, '');
      
      // Convert string booleans to actual booleans
      if (value === 'true' || value === 'false') {
        argMap[cleanKey] = value === 'true';
      } else {
        argMap[cleanKey] = value;
      }
    } else if (arg.startsWith('--')) {
      // Handle flags without values
      const cleanKey = arg.replace(/^--/, '');
      argMap[cleanKey] = true;
    }
  });
  
  return argMap;
}

/**
 * Get configuration from parsed arguments with defaults
 * @param {Object} argMap - Parsed argument map
 * @returns {Object} Configuration object
 */
export function getConfiguration(argMap) {
  const config = {
    targetUrl: argMap.url,
    useProxy: argMap['use-proxy'] === true || argMap['use-proxy'] === 'true',
    csvFile: argMap.csv || 'webpage_analysis_results.csv',
    useJapaneseDetection: argMap.jp === true || argMap.jp === 'true',
    tcpFallback: argMap['tcp-fallback'] === true || argMap['tcp-fallback'] === 'true',
    useLanguageDetection: !(argMap['no-lang'] === true || argMap['no-lang'] === 'true'),
    noAdBlocking: argMap['no-ad'] === true || argMap['no-ad'] === 'true',
    proxyPort: argMap['proxy-port'] || '4433',
    reportPort: argMap['report-port'] || '9090',
    debugMode: argMap.debug === true || argMap.debug === 'true'
  };
  
  config.proxyHost = `http://localhost:${config.proxyPort}`;
  config.reportUrl = `http://localhost:${config.reportPort}/stats`;
  
  return config;
}

/**
 * Validate required configuration parameters
 * @param {Object} config - Configuration object
 * @returns {boolean} Whether configuration is valid
 */
export function validateConfiguration(config) {
  if (!config.targetUrl) {
    error('Missing required parameter: --url');
    showUsage();
    return false;
  }
  
  // Basic URL validation
  if (!config.targetUrl.match(/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/)) {
    error('Invalid URL format. Please provide a domain like: example.com');
    return false;
  }
  
  return true;
}

/**
 * Display usage information
 */
export function showUsage() {
  log(`
Usage: node puppeteer-client.js --url=DOMAIN [OPTIONS]

Required:
  --url=DOMAIN             Target domain to analyze (e.g., example.com)

Options:
  --use-proxy             Enable QUIC proxy routing through localhost
  --tcp-fallback          Enable TCP fallback on QUIC connection failures
  --csv=FILE              Output CSV file for results (default: webpage_analysis_results.csv)
  --jp                    Enable Japanese content detection
  --no-lang               Disable language detection analysis (enabled by default)
  --no-ad                 Enable ad/tracker blocking during page load
  --proxy-port=PORT       QUIC proxy port (default: 4433)
  --report-port=PORT      Proxy statistics port (default: 9090)
  --debug                 Enable debug logging

Examples:
  node puppeteer-client.js --url=example.com
  node puppeteer-client.js --url=example.com --use-proxy --csv=results.csv
  node puppeteer-client.js --url=example.com --use-proxy --tcp-fallback --jp
  node puppeteer-client.js --url=example.com --no-ad --debug
  node puppeteer-client.js --url=example.com --no-lang
`);
}
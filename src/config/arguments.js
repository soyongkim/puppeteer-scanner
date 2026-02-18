/**
 * Command line argument parsing and validation
 */

import { error, log } from '../utils/logger.js';
import { PROXY_CONFIG, PROXY_STATS_CONFIG } from './constants.js';

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
    proxyPort: argMap['proxy-port'] || PROXY_CONFIG.PORT.toString(),
    reportPort: argMap['report-port'] || PROXY_STATS_CONFIG.PORT.toString(),
    aggregateServer: argMap['aggregate-server'] || null,
    debugMode: argMap.debug === true || argMap.debug === 'true'
  };
  
  // Use constants for proxy configuration with user override support
  const proxyHost = argMap['proxy-host'] || PROXY_CONFIG.HOST;
  const proxyProtocol = argMap['proxy-protocol'] || PROXY_CONFIG.PROTOCOL;
  config.proxyHost = `${proxyProtocol}://${proxyHost}:${config.proxyPort}`;
  
  // Use constants for report configuration with user override support  
  const reportHost = argMap['report-host'] || PROXY_STATS_CONFIG.HOST;
  const reportProtocol = argMap['report-protocol'] || PROXY_STATS_CONFIG.PROTOCOL;
  const reportEndpoint = argMap['report-endpoint'] || PROXY_STATS_CONFIG.ENDPOINT;
  config.reportUrl = `${reportProtocol}://${reportHost}:${config.reportPort}${reportEndpoint}`;
  
  // If aggregate server is specified, parse it and build the aggregate URL
  if (config.aggregateServer) {
    // Format: host:port or http://host:port/stats
    if (config.aggregateServer.startsWith('http')) {
      config.aggregateUrl = config.aggregateServer;
    } else {
      // Assume format is host:port, build full URL
      config.aggregateUrl = `http://${config.aggregateServer}/stats`;
    }
  }
  
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
  --aggregate-server=URL  Aggregate server for connection details (e.g., localhost:9090)
                          When set, fetches detailed connection stats regardless of proxy setting
  --debug                 Enable debug logging

Examples:
  node puppeteer-client.js --url=example.com
  node puppeteer-client.js --url=example.com --use-proxy --csv=results.csv
  node puppeteer-client.js --url=example.com --use-proxy --tcp-fallback --jp
  node puppeteer-client.js --url=example.com --no-ad --debug
  node puppeteer-client.js --url=example.com --no-lang
  node puppeteer-client.js --url=example.com --aggregate-server=localhost:9090
`);
}
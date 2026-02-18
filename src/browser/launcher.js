/**
 * Browser configuration and launching utilities
 */

import puppeteer from 'puppeteer-core';
import {
  BROWSER_ARGS,
  CHROME_CONFIG,
  DEFAULT_HEADERS,
  DEFAULT_USER_AGENT,
  DEFAULT_VIEWPORT
} from '../config/constants.js';
import { log } from '../utils/logger.js';

/**
 * Create browser launch options
 * @param {Object} config - Configuration object
 * @param {boolean} useTcp - Whether to use TCP instead of QUIC
 * @returns {Object} Puppeteer launch options
 */
export function createLaunchOptions(config, useTcp = false) {
  const launchOpts = {
    headless: true,
    executablePath: CHROME_CONFIG.EXECUTABLE_PATH,
    args: [...BROWSER_ARGS]
  };

  // Remove QUIC forcing for TCP mode
  if (useTcp) {
    launchOpts.args = launchOpts.args.filter(arg => !arg.includes('origin-to-force-quic-on'));
  }

  // Add proxy configuration if needed
  if (config.useProxy) {
    launchOpts.args.push(`--proxy-server=${config.proxyHost}`);
    log(`Proxy enabled: ${config.proxyHost}`);
  } else {
    log('Proxy disabled');
  }

  return launchOpts;
}

/**
 * Launch browser with configuration
 * @param {Object} config - Configuration object
 * @param {boolean} useTcp - Whether to use TCP instead of QUIC
 * @returns {Promise<Object>} Browser and page objects
 */
export async function launchBrowser(config, useTcp = false) {
  const launchOpts = createLaunchOptions(config, useTcp);
  const protocolInfo = useTcp ? ' with TCP' : '';
  
  log(`Launching browser${protocolInfo}...`);
  
  const browser = await puppeteer.launch(launchOpts);
  const page = await browser.newPage();
  
  // Stealth mode not needed for network analysis
  
  // Set realistic user agent and viewport
  await page.setUserAgent(DEFAULT_USER_AGENT);
  await page.setViewport(DEFAULT_VIEWPORT);
  
  // Set realistic HTTP headers
  await page.setExtraHTTPHeaders(DEFAULT_HEADERS);
  
  // Disable cache at page level
  await page.setCacheEnabled(false);
  await page.setBypassServiceWorker(true);
  
  return { browser, page };
}

/**
 * Setup network monitoring for the page
 * @param {Object} page - Puppeteer page object
 * @returns {Promise<Object>} CDP client for network monitoring
 */
export async function setupNetworkMonitoring(page) {
  // Enable network domain to get detailed connection info
  const client = await page.target().createCDPSession();
  await client.send('Network.enable');
  
  // Disable cache at CDP level as well
  await client.send('Network.setCacheDisabled', { cacheDisabled: true });
  
  return client;
}

/**
 * Reconfigure browser for TCP fallback
 * @param {Object} browser - Current browser instance
 * @param {Object} config - Configuration object
 * @returns {Promise<Object>} New browser and page objects
 */
export async function reconfigureForTcp(browser, config) {
  log('Switching to TCP protocol (removed QUIC forcing)');
  
  // Close existing browser
  await browser.close();
  
  // Launch new browser with TCP configuration
  return await launchBrowser(config, true);
}
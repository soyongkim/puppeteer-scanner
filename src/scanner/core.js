/**
 * Core scanning functionality - main scanner logic
 */

import { launchBrowser, setupNetworkMonitoring } from '../browser/launcher.js';
import { RETRY_CONFIG } from '../config/constants.js';
import { createRequestInterceptor } from '../network/filters.js';
import { extractDomain } from '../network/utils.js';
import { log } from '../utils/logger.js';
import { setupPageListeners } from './listeners.js';

/**
 * Initialize scanner state
 * @returns {Object} Scanner state object
 */
export function initializeScannerState() {
  return {
    // Resource tracking
    requestedResources: [],
    failedResources: [],
    succeededResources: new Set(),
    pendingResources: new Map(),
    
    // Domain statistics
    domainStats: new Map(),
    domainToIP: new Map(),
    
    // Page state
    loadEventFired: false,
    loadEventTime: null,
    totalBytes: 0,
    mainStatus: null,
    mainHeaders: {},
    
    // Status tracking
    highestPriorityStatus: null,
    finalResultFromTCP: false,
    
    // Redirect tracking
    targetDomainRedirectInfo: {
      hasRedirect: false,
      redirectStatus: null,
      redirectLocation: null,
      finalStatus: null,
      finalDomain: null,
      redirectChain: []
    },
    
    // Filtering statistics
    filteredRequestsStats: {
      blocked_domain: 0,
      non_essential_resource: 0,
      total_filtered: 0
    }
  };
}

/**
 * Perform page scan with retry logic
 * @param {Object} config - Configuration object
 * @param {Object} state - Scanner state object
 * @returns {Promise<Object>} Scan results
 */
export async function performPageScan(config, state) {
  const { browser, page } = await launchBrowser(config);
  
  try {
    // Setup network monitoring
    const client = await setupNetworkMonitoring(page);
    
    // Setup request/response listeners
    setupPageListeners(page, state, config);
    
    // Setup request interception if filtering is enabled
    if (config.noAdBlocking) {
      await page.setRequestInterception(true);
      page.on('request', createRequestInterceptor(config));
    }
    
    // Track network responses with IP addresses from CDP
    client.on('Network.responseReceived', (params) => {
      const { response } = params;
      const domain = extractDomain(response.url);
      
      if (response.remoteIPAddress && !state.domainToIP.has(domain)) {
        state.domainToIP.set(domain, response.remoteIPAddress);
        const stats = state.domainStats.get(domain);
        if (stats) {
          stats.ip = response.remoteIPAddress;
        }
      }
    });
    
    // Track load event
    page.on('load', () => {
      state.loadEventFired = true;
      state.loadEventTime = Date.now();
      log(`[LOAD-EVENT] Page load event fired`);
    });
    
    // Perform navigation with retry logic
    const result = await attemptPageLoad(page, config, state);
    
    return {
      browser,
      page,
      response: result.response,
      startTime: result.startTime,
      success: result.success,
      // Include all state data for results processing
      mainStatus: state.mainStatus,
      mainHeaders: state.mainHeaders,
      failedResources: state.failedResources,
      requestedResources: state.requestedResources,
      succeededResources: state.succeededResources,
      pendingResources: state.pendingResources,
      totalBytes: state.totalBytes,
      domainStats: state.domainStats,
      domainToIP: state.domainToIP,
      loadEventFired: state.loadEventFired,
      targetDomainRedirectInfo: state.targetDomainRedirectInfo || {
        hasRedirect: false,
        redirectStatus: null,
        redirectLocation: null,
        finalStatus: state.mainStatus,
        finalDomain: null,
        redirectChain: []
      },
      filteredRequestsStats: state.filteredRequestsStats || {
        blocked_domain: 0,
        non_essential_resource: 0,
        total_filtered: 0
      }
    };
    
  } catch (err) {
    await browser.close();
    throw err;
  }
}

/**
 * Attempt page load with retry and fallback logic
 * @param {Object} page - Puppeteer page object
 * @param {Object} config - Configuration object
 * @param {Object} state - Scanner state object
 * @param {number} attempt - Current attempt number
 * @param {boolean} useTcp - Whether to use TCP instead of QUIC
 * @returns {Promise<Object>} Load result
 */
async function attemptPageLoad(page, config, state, attempt = 1, useTcp = false) {
  try {
    const protocolInfo = useTcp ? ' with TCP' : '';
    const attemptInfo = attempt > 1 ? ` (attempt ${attempt}/${RETRY_CONFIG.MAX_RETRIES})` : '';
    log(`Starting page load${attemptInfo}${protocolInfo}…`);
    
    const t0 = Date.now();
    
    // Setup progressive timeout monitoring
    const { timeoutPromise, cleanup } = setupProgressiveTimeout(state);
    
    let response;
    try {
      // Race between navigation and timeout
      response = await Promise.race([
        page.goto(`https://${config.targetUrl}`, { 
          waitUntil: 'load',
          timeout: RETRY_CONFIG.NAVIGATION_TIMEOUT
        }),
        timeoutPromise
      ]);
      
      cleanup();
    } catch (error) {
      cleanup();
      throw error;
    }
    
    return { 
      response, 
      startTime: t0, 
      success: true 
    };
    
  } catch (err) {
    // Handle retry logic here if needed
    // For now, just propagate the error
    throw err;
  }
}

/**
 * Setup progressive timeout that resets on network activity
 * @param {Object} state - Scanner state object
 * @returns {Object} Timeout promise and cleanup function
 */
function setupProgressiveTimeout(state) {
  let lastActivityTime = Date.now();
  let timeoutHandle = null;
  let navigationCompleted = false;
  let timeoutReject = null;

  const resetTimeout = () => {
    lastActivityTime = Date.now();
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (!navigationCompleted) {
      timeoutHandle = setTimeout(() => {
        if (!navigationCompleted && Date.now() - lastActivityTime >= RETRY_CONFIG.INACTIVITY_TIMEOUT) {
          navigationCompleted = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (timeoutReject) {
            timeoutReject(new Error(`Navigation timeout: No network activity for ${RETRY_CONFIG.INACTIVITY_TIMEOUT}ms`));
          }
        }
      }, RETRY_CONFIG.INACTIVITY_TIMEOUT);
    }
  };

  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutReject = reject;
  });

  const cleanup = () => {
    navigationCompleted = true;
    if (timeoutHandle) clearTimeout(timeoutHandle);
  };

  // Start timeout monitoring
  resetTimeout();

  return { timeoutPromise, cleanup, resetTimeout };
}
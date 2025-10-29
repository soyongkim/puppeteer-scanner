/**
 * Results processing and analysis
 * Handles the complete analysis pipeline from scan results to CSV output
 */

import {
    analyzeRedirectAndIP,
    calculateDomainStatistics,
    detectCloudflareChallenge,
    extractConnectionStatistics
} from '../analysis/domains.js';
import {
    createErrorLanguageResults,
    createSkippedLanguageResults,
    detectWebsiteLanguage
} from '../analysis/language.js';
import { extractStatusFromProxyConnection, fetchProxyStats, getDefaultProxyStats } from '../network/proxy.js';
import { escapeCsvField, writeToCsv } from '../utils/csv.js';
import { debug, log } from '../utils/logger.js';

/**
 * Process scan results and generate CSV output
 * @param {Object} scanResult - Results from the page scan
 * @param {Object} config - Configuration object
 * @returns {Object} Processed results
 */
export async function processResults(scanResult, config) {
  const {
    response,
    startTime,
    mainStatus,
    failedResources,
    requestedResources,
    succeededResources,
    pendingResources,
    totalBytes,
    targetDomainRedirectInfo,
    page
  } = scanResult;

  const baseLoadTime = ((Date.now() - startTime) / 1000);
  const loadTime = baseLoadTime.toFixed(2);

  // ── Fetch proxy statistics to check for real IP ───────────────────────
  let proxyStats = getDefaultProxyStats();
  if (config.useProxy) {
    try {
      const fetchedStats = await fetchProxyStats(config.reportUrl || `http://localhost:${config.reportPort || '9090'}/stats`, config.debugMode);
      if (fetchedStats) {
        proxyStats = fetchedStats;
        debug(`Proxy stats retrieved: ${proxyStats.total_opened_streams} streams, ${proxyStats.total_redirects} redirects, ${proxyStats.total_data_amount} bytes total, ${proxyStats.total_migrated_data_amount} bytes migrated`, config.debugMode);
      } else {
        debug(`[WARNING] No proxy statistics found.`, config.debugMode);
      }
    } catch (proxyErr) {
      debug(`[WARNING] Failed to fetch proxy statistics: ${proxyErr.message}`, config.debugMode);
    }
  }

  // ── Language Detection Analysis ─────────────────────────────────────────
  let languageResults;
  if (config.useLanguageDetection) {
    log(`\n=== LANGUAGE DETECTION ANALYSIS ===`);
    try {
      // Use standard multi-language detection
      languageResults = await detectWebsiteLanguage(page);
      
      // Display debug info
      if (languageResults.debugInfo) {
        const debug = languageResults.debugInfo;
        log(`Document State: ${debug.documentState}`);
        log(`Title: "${debug.title}"`);
        log(`Meta Description: "${debug.metaDescription}"`);
        log(`Visible Text Length: ${debug.visibleTextLength} characters`);
        log(`Full Text Length: ${debug.fullTextLength} characters`);
        log(`Element Count: ${debug.elementCount}`);
        log(`Text Sample: "${debug.textSample}"`);
        log(`Visible Elements: ${debug.visibleElements} elements`);
      }
      
      log(`Primary Language: ${languageResults.primaryLanguage} (${languageResults.confidence} confidence)`);
      log(`Language Score: ${languageResults.score}`);
      log(`Declared Language: ${languageResults.declaredLanguage}`);
      log(`Text Length: ${languageResults.textLength} characters`);
      log(`Reason: ${languageResults.reason}`);
      
      if (languageResults.secondaryLanguages && languageResults.secondaryLanguages.length > 0) {
        const secondaryLangs = languageResults.secondaryLanguages
          .map(lang => `${lang.language} (${lang.score})`)
          .join(', ');
        log(`Secondary Languages: ${secondaryLangs}`);
      }
      
    } catch (langErr) {
      log(`Language detection failed: ${langErr.message}`);
      languageResults = createErrorLanguageResults(langErr);
    }
  } else {
    // Language detection is disabled
    languageResults = createSkippedLanguageResults();
  }

  // ── Analysis of failed resources ────────────────────────────────────────
  const totalRequested = requestedResources.length;
  const uniqueDomainsRequested = new Set(requestedResources.map(r => r.domain)).size;
  const totalSucceeded = succeededResources.size;
  const totalFailed = failedResources.length;
  const totalPending = pendingResources.size;
  const httpErrorFailures = failedResources.filter(f => f.errorType === 'http_error');

  // ── Cloudflare Challenge Detection ══════════════════════════════════════
  const { cloudflareChallenge, cloudflareDetected } = detectCloudflareChallenge(response, requestedResources, failedResources);

  // Status and timing info will be shown in the main summary

  // ── Calculate domain statistics ─────────────────────────────────────────
  const domainStatistics = calculateDomainStatistics({
    httpErrorFailures,
    targetUrl: config.targetUrl,
    uniqueDomainsRequested
  });

  // ── Redirect Detection and IP Extraction ───────────────────────────────
  const redirectAnalysis = analyzeRedirectAndIP({
    targetUrl: config.targetUrl,
    response,
    proxyStats,
    useProxy: config.useProxy,
    global: global || {},
    debugMode: config.debugMode
  });

  // ── Extract comprehensive connection statistics ─────────────────────────
  const proxyFields = extractConnectionStatistics(proxyStats, uniqueDomainsRequested, config.debugMode);

  // ── Determine status codes for CSV format ──────────────────────────────
  let firstStatusCode = '-';
  let redirectedStatusCode = '-';
  
  // If there's a redirect, use the redirect status as the first status code
  // Use both redirect analysis results AND state redirect info (like original)
  if (redirectAnalysis.redirectedDomain !== '-' && (targetDomainRedirectInfo.hasRedirect || redirectAnalysis.redirectedDomain !== '-')) {
    // First status: try redirect status from state, fallback to proxy extraction
    firstStatusCode = targetDomainRedirectInfo.redirectStatus || targetDomainRedirectInfo.firstStatus;
    
    // If no status in state, extract from proxy connection details for original domain
    if (!firstStatusCode || firstStatusCode === '-') {
      const extractedStatus = extractStatusFromProxyConnection(config.targetUrl, proxyStats);
        if (extractedStatus !== '-') {
        firstStatusCode = extractedStatus;
        debug(`[REDIRECT-STATUS-EXTRACTED] Used proxy connection details for redirect from ${config.targetUrl}: ${firstStatusCode}`, config.debugMode);
      }
    }
    
    // Redirected status: extract from proxy connection details for final domain
    redirectedStatusCode = extractStatusFromProxyConnection(redirectAnalysis.redirectedDomain, proxyStats);
  } else {
    // No redirect case: first status is the main/final status, or extract from proxy if not available
    firstStatusCode = targetDomainRedirectInfo.finalStatus || mainStatus;
    
    // If we don't have a status from normal tracking, try to extract from proxy connection details
    if ((!firstStatusCode || firstStatusCode === '-') && proxyStats && proxyStats.connections_detail) {
      const extractedStatus = extractStatusFromProxyConnection(config.targetUrl, proxyStats);
      if (extractedStatus !== '-') {
        firstStatusCode = extractedStatus;
        debug(`[STATUS-EXTRACTED] Used proxy connection details for ${config.targetUrl}: ${firstStatusCode}`, config.debugMode);
      }
    }
    
    // Fallback to '-' if still no status found
    firstStatusCode = firstStatusCode || '-';
    redirectedStatusCode = '-';
  }

  // Format the CSV row data
  const csvResults = {
    targetUrl: config.targetUrl,
    originalIP: redirectAnalysis.originalIP,
    firstStatusCode,
    redirectedDomain: redirectAnalysis.redirectedDomain,
    redirectedIP: redirectAnalysis.redirectedIP,
    redirectedStatusCode,
    languageResults,
    loadTime,
    uniqueDomainsRequested: proxyFields.totalDomainsForCsv,
    connectionFailedDomains: domainStatistics.connectionFailedDomains,
    non200Domains: domainStatistics.non200Domains,
    statusCounts: domainStatistics.statusCounts,
    statusDomainNames: domainStatistics.statusDomainNames,
    tcpResult: 'QUIC', // Using QUIC by default
    cloudflareDetected,
    proxyFields,
    connectionDetails: escapeCsvField(proxyFields.connectionDetails)
  };

  // Write to CSV if file specified
  if (config.csvFile) {
    writeToCsv(config.csvFile, csvResults);
  }

  return {
    csvResults,
    scanSummary: {
      totalRequested,
      uniqueDomainsRequested,
      totalSucceeded,
      totalFailed,
      totalPending,
      loadTime: parseFloat(loadTime),
      totalBytes,
      languageResults,
      domainStatistics,
      redirectAnalysis,
      cloudflareDetected: cloudflareDetected === 'Yes',
      proxyStats
    }
  };
}

/**
 * Log comprehensive resource and domain statistics
 * @param {Object} scanResult - Scan result data
 * @param {Object} config - Configuration object
 */
export function logResourceStatistics(scanResult, config) {
  const {
    failedResources,
    requestedResources,
    succeededResources,
    pendingResources,
    domainStats,
    filteredRequestsStats
  } = scanResult;

  const totalRequested = requestedResources.length;
  const uniqueDomainsRequested = new Set(requestedResources.map(r => r.domain)).size;
  const totalSucceeded = succeededResources.size;
  const totalFailed = failedResources.length;
  const totalPending = pendingResources.size;
  const httpErrorFailures = failedResources.filter(f => f.errorType === 'http_error');
  const resetFailures = failedResources.filter(f => f.errorText && f.errorText.includes('reset'));
  const abortedFailures = failedResources.filter(f => f.errorType === 'request_aborted');
  
  // Get failed domains and their resource counts with error details
  const failedDomains = new Map();
  failedResources.forEach(f => {
    if (!failedDomains.has(f.domain)) {
      failedDomains.set(f.domain, {
        count: 0,
        errors: new Set(),
        httpErrors: 0,
        connectionErrors: 0
      });
    }
    const domainInfo = failedDomains.get(f.domain);
    domainInfo.count += 1;
    domainInfo.errors.add(f.errorText);
    if (f.errorType === 'http_error') {
      domainInfo.httpErrors++;
    } else {
      domainInfo.connectionErrors++;
    }
  });
  
  // Get pending domains and their resource counts
  const pendingDomains = new Map();
  pendingResources.forEach((info, url) => {
    if (!pendingDomains.has(info.domain)) {
      pendingDomains.set(info.domain, {
        count: 0,
        resourceTypes: new Set(),
        urls: []
      });
    }
    const domainInfo = pendingDomains.get(info.domain);
    domainInfo.count += 1;
    domainInfo.resourceTypes.add(info.resourceType);
    domainInfo.urls.push(url);
  });
  
  log(`\n=== RESOURCE SUMMARY ===`);
  log(`Resources: ${totalRequested} total, ${uniqueDomainsRequested} unique domains`);
  
  // Show filtering statistics if any requests were filtered
  if (filteredRequestsStats.total_filtered > 0) {
    log(`Filtered: ${filteredRequestsStats.total_filtered} requests ignored (${filteredRequestsStats.blocked_domain} ad/tracking domains, ${filteredRequestsStats.non_essential_resource} non-essential XHR/Fetch)`);
  }
  
  log(`Domains: ${totalSucceeded}/${uniqueDomainsRequested} succeeded, ${failedDomains.size} failed, ${pendingDomains.size} pending`);
  log(`Failures: ${totalFailed} total (${httpErrorFailures.length} HTTP errors, ${resetFailures.length} connection errors, ${abortedFailures.length} aborted)`);
  log(`Pending: ${totalPending} resources still loading after page load event`);

  // Show pending requests that never completed
  if (pendingResources.size > 0) {
    log(`\n=== PENDING/INCOMPLETE REQUESTS ===`);
    log(`${pendingResources.size} requests were started but never completed:`);
    pendingResources.forEach((info, url) => {
      const waitTime = ((Date.now() - info.startTime) / 1000).toFixed(1);
      const timingInfo = info.requestedAfterLoad ? '[AFTER-LOAD]' : '[BEFORE-LOAD]';
      let resourceName;
      try {
        const urlObj = new URL(url);
        resourceName = urlObj.pathname + urlObj.search;
        if (resourceName.length > 50) {
          resourceName = resourceName.slice(0, 50) + '...';
        }
      } catch {
        resourceName = url.length > 50 ? url.slice(0, 50) + '...' : url;
      }
      debug(`  [${info.resourceType.toUpperCase()}] ${timingInfo} ${info.domain}${resourceName} - pending ${waitTime}s`, config.debugMode);
    });
  }
}

/**
 * Handle scan errors with comprehensive error processing and CSV output
 * @param {Error} err - The error that occurred
 * @param {Object} config - Configuration object
 * @param {Object} state - Scanner state object
 */
export async function handleScanError(err, config, state) {
  log(`\nHandling scan error: ${err.message}`);
  
  // ═══ CLOUDFLARE CHALLENGE DETECTION IN ERRORS ═══
  let cloudflareChallenge = '';
  let cloudflareDetected = 'No';
  
  // Check if any of the failed resources were from Cloudflare challenges
  const challengeResources = (state.requestedResources || []).filter(r => r.url && r.url.includes('challenges.cloudflare.com'));
  const challengeFailures = (state.failedResources || []).filter(f => f.domain && f.domain.includes('challenges.cloudflare.com'));
  
  if (challengeResources.length > 0) {
    cloudflareChallenge = ' [CLOUDFLARE CHALLENGE DETECTED]';
    cloudflareDetected = 'Yes';
    log(`Additional info: ${cloudflareChallenge}`);
  } else if (challengeFailures.length > 0) {
    cloudflareChallenge = ' [CLOUDFLARE CHALLENGE IN FAILURES]';
    cloudflareDetected = 'Yes';
    log(`Additional info: ${cloudflareChallenge}`);
  }
  
  // ── Fetch proxy statistics even on connection failure ─────────────────────
  let proxyStats = getDefaultProxyStats();
  if (config.useProxy) {
    try {
      debug('Fetching proxy statistics after connection failure...', config.debugMode);
      const fetchedStats = await fetchProxyStats(config.reportUrl || `http://localhost:${config.reportPort || '9090'}/stats`, config.debugMode);
      if (fetchedStats) {
        proxyStats = fetchedStats;
        debug(`Proxy stats after failure: ${proxyStats.total_opened_streams} streams, ${proxyStats.total_redirects} redirects, ${proxyStats.total_data_amount} bytes total`, config.debugMode);
        
        // Try to get real IP even on failure
        if (proxyStats.connections_detail) {
          const { extractRealIPFromProxy } = await import('../network/proxy.js');
          const realIPInfo = extractRealIPFromProxy(config.targetUrl, proxyStats, config.debugMode);
          if (realIPInfo) {
            debug(`[REAL-IP-ERROR] Found connection IP despite failure: ${realIPInfo.ip} (${realIPInfo.domain})`, config.debugMode);
            // Store real IP info for CSV generation
            global.errorCaseRealIP = realIPInfo;
          }
        }
      } else {
        debug(`[WARNING] No proxy statistics found after connection failure.`, config.debugMode);
      }
    } catch (proxyErr) {
      debug(`[WARNING] Failed to fetch proxy statistics after connection failure: ${proxyErr.message}`, config.debugMode);
    }
  }
  
  // If it's a navigation timeout, show pending resources
  if (err.message.includes('Navigation timeout') || err.message.includes('timeout')) {
    log('\\n=== PENDING RESOURCES (likely causing timeout) ===');
    if (state.pendingResources && state.pendingResources.size > 0) {
      log(`${state.pendingResources.size} resources still pending:`);
      state.pendingResources.forEach((info, url) => {
        const waitTime = ((Date.now() - info.startTime) / 1000).toFixed(1);
        // Extract resource name for display
        let resourceName;
        try {
          const urlObj = new URL(url);
          resourceName = urlObj.pathname + urlObj.search;
          if (resourceName.length > 30) {
            resourceName = resourceName.slice(0, 30) + '...';
          }
        } catch {
          resourceName = url.length > 30 ? url.slice(0, 30) + '...' : url;
        }
        log(`  - [${info.resourceType.toUpperCase()}] ${info.domain}${resourceName} - waiting ${waitTime}s`);
      });
    } else {
      log('No pending resources found (timeout may be due to other factors)');
    }
    log('===================================================\\n');
  }
  
  // Still write CSV data even on complete failure
  try {
    // Extract clean Chromium error for chrome_fail field
    let chromeErrorForCsv = '';
    if (err.message.includes('net::ERR_')) {
      // Extract the full net::ERR_ code (including numbers and underscores)
      const match = err.message.match(/net::ERR_[A-Z0-9_]+/);
      chromeErrorForCsv = match ? match[0] : 'CHROMIUM_ERROR';
    } else if (err.message.includes('QUIC')) {
      chromeErrorForCsv = err.message.includes('QUIC_PROTOCOL_ERROR') ? 'net::ERR_QUIC_PROTOCOL_ERROR' : 'QUIC_ERROR';
    } else if (err.message.includes('timeout')) {
      chromeErrorForCsv = 'NAVIGATION_TIMEOUT';
    } else {
      // For other errors, clean up the message
      chromeErrorForCsv = err.message.split('\\n')[0]
        .replace(/[^a-zA-Z0-9\\s]/g, '') // Remove special chars but keep spaces
        .replace(/\\s+/g, '_')            // Replace spaces with underscores
        .toUpperCase()
        .substring(0, 30) || 'UNKNOWN_ERROR'; // Limit length and provide fallback
    }
    
    // Status code logic: Use first main document status if available, then highest priority status, otherwise use "-"
    let statusForCsv = state.firstMainDocumentStatus || state.highestPriorityStatus;
    if (!statusForCsv && state.targetDomainRedirectInfo && state.targetDomainRedirectInfo.finalStatus) {
      statusForCsv = state.targetDomainRedirectInfo.finalStatus;
      debug(`[ERROR-STATUS] Using final redirect status: ${statusForCsv}`, config.debugMode);
    }
    statusForCsv = statusForCsv || '-';
    
    // For error cases, extract redirect info from targetDomainRedirectInfo or proxy connections
    let errorRedirectedDomain = '-';
    let errorOriginalIP = '-';
    let errorRedirectedIP = '-';
    
    // Check if we have redirect information in state
    if (state.targetDomainRedirectInfo && state.targetDomainRedirectInfo.hasRedirect && 
        state.targetDomainRedirectInfo.redirectChain && state.targetDomainRedirectInfo.redirectChain.length > 0) {
      // Get the final domain from the redirect chain
      const lastRedirect = state.targetDomainRedirectInfo.redirectChain[state.targetDomainRedirectInfo.redirectChain.length - 1];
      errorRedirectedDomain = lastRedirect.to;
      debug(`[ERROR-REDIRECT] Using final redirected domain: ${errorRedirectedDomain}`, config.debugMode);
    } else if (proxyStats && proxyStats.connections_detail) {
      // Fallback: Extract redirect info from proxy connections when state doesn't have it
      const { parseConnectionsDetail } = await import('../network/proxy.js');
      const connections = parseConnectionsDetail(proxyStats.connections_detail);
      
      // Look for redirect status (3xx) from the original domain
      const originalConnection = connections.find(conn => conn.domain === config.targetUrl);
      if (originalConnection && originalConnection.statusInfo) {
        for (const [status, count] of Object.entries(originalConnection.statusInfo)) {
          if (status.match(/^3\d\d$/)) {
            // Found a redirect status, look for the destination domain in other connections
            const otherDomains = connections.filter(conn => conn.domain !== config.targetUrl);
            if (otherDomains.length > 0) {
              // Use the first other domain as redirect destination
              errorRedirectedDomain = otherDomains[0].domain;
              debug(`[ERROR-PROXY-REDIRECT] Detected redirect from proxy: ${config.targetUrl} (${status}) -> ${errorRedirectedDomain}`, config.debugMode);
            }
            break;
          }
        }
      }
    }
    
    // Try to extract IP from proxy connection if available
    if (global.errorCaseRealIP) {
      errorOriginalIP = global.errorCaseRealIP.ip;
      // If we have a redirected domain, try to find its IP
      if (errorRedirectedDomain !== '-' && proxyStats && proxyStats.connections_detail) {
        const { extractRealIPFromProxy } = await import('../network/proxy.js');
        const redirectIPInfo = extractRealIPFromProxy(errorRedirectedDomain, proxyStats);
        if (redirectIPInfo) {
          errorRedirectedIP = redirectIPInfo.ip;
          debug(`[ERROR-REDIRECT-IP] Found IP for ${errorRedirectedDomain}: ${errorRedirectedIP}`, config.debugMode);
        } else {
          errorRedirectedIP = '-'; // No IP found for redirected domain
        }
      } else {
        errorRedirectedIP = '-'; // No redirect, so no redirected IP
      }
      // Clean up global variable
      delete global.errorCaseRealIP;
    } else if (state.firstMainDocumentStatus || state.highestPriorityStatus) {
      errorOriginalIP = 'BLOCKED';
      errorRedirectedIP = 'BLOCKED';
    } else {
      errorOriginalIP = 'ERROR';
      errorRedirectedIP = 'ERROR';
    }
    
    log(`[DEBUG] Error case - First main status: ${state.firstMainDocumentStatus || 'None'}, Priority status: ${state.highestPriorityStatus || 'None'}, Chrome error: ${chromeErrorForCsv}`);
    log(`[DEBUG] Full original error message: ${err.message}`);
    log(`[DEBUG] CSV format - Status: ${statusForCsv}, Chrome fail: ${chromeErrorForCsv}`);
    
    // Extract status codes for error case
    let errorFirstStatusCode = '-';
    let errorRedirectedStatusCode = '-';
    
    // Determine first status code - prioritize original domain's status from proxy
    if (proxyStats && proxyStats.connections_detail) {
      const extractedStatus = extractStatusFromProxyConnection(config.targetUrl, proxyStats);
      if (extractedStatus !== '-') {
        errorFirstStatusCode = extractedStatus;
        debug(`[ERROR-FIRST-STATUS] Extracted status for ${config.targetUrl}: ${errorFirstStatusCode}`, config.debugMode);
      }
    }
    
    // Fallback to state redirect info if proxy extraction failed
    if (errorFirstStatusCode === '-') {
      if (state.targetDomainRedirectInfo && state.targetDomainRedirectInfo.firstStatus) {
        errorFirstStatusCode = state.targetDomainRedirectInfo.firstStatus;
      } else if (statusForCsv && statusForCsv !== '-') {
        errorFirstStatusCode = statusForCsv;
      }
    }
    
    // Extract redirected status code from proxy connection details if available
    if (errorRedirectedDomain !== '-' && proxyStats && proxyStats.connections_detail) {
      errorRedirectedStatusCode = extractStatusFromProxyConnection(errorRedirectedDomain, proxyStats);
      debug(`[ERROR-REDIRECT-STATUS] Extracted status for ${errorRedirectedDomain}: ${errorRedirectedStatusCode}`, config.debugMode);
    }
    
    const tcpResult = 'QUIC'; // Using QUIC by default (no TCP fallback)
    
    // Extract comprehensive connection statistics for error case CSV
    const proxyFields = extractConnectionStatistics(proxyStats, 1, config.debugMode); // Default to 1 domain for error case
    
    // For error cases, adjust domain counts
    const errorCsvResults = {
      targetUrl: config.targetUrl,
      originalIP: errorOriginalIP,
      firstStatusCode: errorFirstStatusCode,
      redirectedDomain: errorRedirectedDomain,
      redirectedIP: errorRedirectedIP,
      redirectedStatusCode: errorRedirectedStatusCode,
      languageResults: {
        primaryLanguage: 'Error',
        declaredLanguage: 'unknown'
      },
      loadTime: '-',
      uniqueDomainsRequested: proxyFields.totalDomainsForCsv,
      connectionFailedDomains: { size: 1 }, // Always 1 for complete connection failures
      non200Domains: { size: 0 }, // No HTTP errors in connection failure cases
      statusCounts: { '403': 0, '451': 0, '500': 0, '503': 0 },
      statusDomainNames: { '403': [], '451': [], '500': [], '503': [] },
      tcpResult: tcpResult,
      cloudflareDetected: cloudflareDetected,
      proxyFields: proxyFields,
      connectionDetails: escapeCsvField(proxyFields.connectionDetails),
      // Add chrome_fail field for error cases
      chromeFail: chromeErrorForCsv
    };
    
    // Write error CSV with special handling for chrome_fail field
    if (config.csvFile) {
      await writeErrorToCsv(config.csvFile, errorCsvResults);
      log(`\nError results written to: ${config.csvFile}`);
    }
    
  } catch (csvErr) {
    log('Failed to write error CSV:', csvErr.message);
  }
}

/**
 * Write error results to CSV with chrome_fail field
 * @param {string} csvPath - Path to CSV file
 * @param {Object} results - Error results object
 */
function writeErrorToCsv(csvPath, results) {
  // Use the existing writeToCsv function which now handles chromeFail field
  writeToCsv(csvPath, results);
}
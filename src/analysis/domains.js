/**
 * Domain statistics and analysis functionality
 * Extracted from the original puppeteer-scanner.js
 */

import { extractRealIPFromProxy, parseConnectionsDetail } from '../network/proxy.js';
import { debug, log } from '../utils/logger.js';

/**
 * Initialize domain statistics tracking
 * @param {string} domain - Domain to initialize stats for
 * @param {Map} domainStats - Domain statistics map
 * @returns {Object} Initialized domain stats object
 */
export function initializeDomainStats(domain, domainStats) {
  if (!domainStats.has(domain)) {
    domainStats.set(domain, {
      domain: domain,
      ip: null,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      httpErrorRequests: 0,
      connectionErrorRequests: 0,
      totalBytes: 0,
      resourceTypes: new Map(),
      statusCodes: new Map(),
      errorMessages: new Set(),
      firstSeen: Date.now(),
      lastActivity: Date.now()
    });
  }
  return domainStats.get(domain);
}

/**
 * Update domain resource type statistics
 * @param {string} domain - Domain to update
 * @param {string} resourceType - Type of resource
 * @param {string} status - Status of the request ('requested', 'successful', 'failed', 'httpErrors', 'connectionErrors')
 * @param {Map} domainStats - Domain statistics map
 */
export function updateDomainResourceType(domain, resourceType, status = 'requested', domainStats) {
  const stats = domainStats.get(domain);
  if (!stats.resourceTypes.has(resourceType)) {
    stats.resourceTypes.set(resourceType, {
      requested: 0,
      successful: 0,
      failed: 0,
      httpErrors: 0,
      connectionErrors: 0
    });
  }
  const typeStats = stats.resourceTypes.get(resourceType);
  typeStats[status]++;
  
  stats.lastActivity = Date.now();
}

/**
 * Validate if a domain is a valid redirect target based on proxy connections
 * @param {string} targetDomain - Original target domain
 * @param {string} candidateDomain - Candidate redirect domain
 * @param {Object} proxyStats - Proxy statistics
 * @param {boolean} useProxy - Whether proxy is being used
 * @param {boolean} debugMode - Debug logging enabled
 * @returns {boolean} Whether the redirect is valid
 */
function validateRedirectCandidate(targetDomain, candidateDomain, proxyStats, hasAggregateServer, debugMode) {
  if (!hasAggregateServer || !proxyStats || !proxyStats.connections_detail) {
    // Without aggregate server/proxy, accept all valid redirects
    return true;
  }

  const allConnections = parseConnectionsDetail(proxyStats.connections_detail);
  const isValid = allConnections.some(conn => {
    return conn.domain === candidateDomain || 
           conn.domain.includes(candidateDomain) || 
           candidateDomain.includes(conn.domain);
  });
  
  debug(`[REDIRECT-VALIDATION] Checking if ${candidateDomain} matches connections: ${isValid}`, debugMode);
  return isValid;
}

/**
 * Extract IP address for a redirect domain from proxy connection info
 * @param {string} domain - Domain to find IP for
 * @param {Object} proxyStats - Proxy statistics
 * @param {boolean} useProxy - Whether proxy is being used
 * @param {boolean} debugMode - Debug logging enabled
 * @returns {string} IP address or null
 */
/**
 * Extract IP address for redirected domain
 * @param {string} domain - Domain to get IP for
 * @param {Object} proxyStats - Proxy/aggregate statistics
 * @param {boolean} hasAggregateServer - Whether aggregate server is available
 * @param {Map} domainToIP - Map of domains to IPs from CDP
 * @param {boolean} debugMode - Debug mode flag
 * @returns {string|null} IP address or null
 */
function extractRedirectIP(domain, proxyStats, hasAggregateServer, domainToIP, debugMode) {
  // First try CDP tracking (works with or without proxy/aggregate)
  if (domainToIP && domainToIP.has(domain)) {
    const ip = domainToIP.get(domain);
    debug(`[REDIRECT-IP] Found IP from CDP for ${domain}: ${ip}`, debugMode);
    return ip;
  }

  // If using aggregate server, try stats
  if (hasAggregateServer && proxyStats && proxyStats.connections_detail) {
    // Try direct match first
    const redirectIPInfo = extractRealIPFromProxy(domain, proxyStats);
    if (redirectIPInfo) {
      debug(`[REDIRECT-IP] Found IP for ${domain}: ${redirectIPInfo.ip}`, debugMode);
      return redirectIPInfo.ip;
    }

    // Try partial matching as fallback
    const allConnections = parseConnectionsDetail(proxyStats.connections_detail);
    for (const conn of allConnections) {
      if (conn.ip && (conn.domain.includes(domain) || domain.includes(conn.domain))) {
        debug(`[REDIRECT-IP] Found IP via partial match for ${domain}: ${conn.ip}`, debugMode);
        return conn.ip;
      }
    }
  }

  return null;
}

/**
 * Get redirect info from multiple possible sources
 * @param {Object} global - Global object containing redirect info
 * @param {boolean} debugMode - Debug logging enabled
 * @returns {Object} Redirect info object and source
 */
function getRedirectInfo(global, debugMode) {
  let redirectInfo = global.redirectInfo;
  let redirectSource = 'global.redirectInfo';
  
  // Check for capturedRedirectInfo from state (if available)
  if (!redirectInfo && global.state && global.state.capturedRedirectInfo) {
    redirectInfo = global.state.capturedRedirectInfo;
    redirectSource = 'state.capturedRedirectInfo';
  }
  
  // Check targetDomainRedirectInfo as fallback
  if (!redirectInfo && global.targetDomainRedirectInfo && global.targetDomainRedirectInfo.redirectLocation) {
    redirectInfo = {
      locationHeader: global.targetDomainRedirectInfo.redirectLocation,
      redirectStatus: global.targetDomainRedirectInfo.redirectStatus
    };
    redirectSource = 'targetDomainRedirectInfo';
  }
  
  debug(`[REDIRECT-SOURCE] Using redirect info from: ${redirectSource}, available: ${!!redirectInfo}`, debugMode);
  
  return { redirectInfo, redirectSource };
}

/**
 * Analyze redirect detection and IP extraction
 * @param {Object} params - Parameters object
 * @param {string} params.targetUrl - Target URL
 * @param {Object} params.response - Puppeteer response object
 * @param {Object} params.proxyStats - Proxy statistics
 * @param {boolean} params.useProxy - Whether proxy is being used
 * @param {Object} params.global - Global redirect info object
 * @returns {Object} Redirect analysis results
 */
/**
 * Analyze redirect and IP information
 * @param {Object} params - Parameters object
 * @returns {Object} Redirect analysis results
 */
export function analyzeRedirectAndIP({ targetUrl, response, proxyStats, useProxy, hasAggregateServer, global, domainToIP, debugMode = false }) {
  let redirectedDomain = '-';
  let originalIP = '-';
  let redirectedIP = '-';
  
  // Get IP for original requested domain from proxy/aggregate connection info
  if (hasAggregateServer && proxyStats && proxyStats.connections_detail) {
    const originalIPInfo = extractRealIPFromProxy(targetUrl, proxyStats);
    if (originalIPInfo) {
      originalIP = originalIPInfo.ip;
      debug(`[ORIGINAL-IP] Found IP for original domain ${targetUrl}: ${originalIP}`, debugMode);
    } else {
      // Try alternative matching for original domain
      const allConnections = parseConnectionsDetail(proxyStats.connections_detail);
      for (const conn of allConnections) {
        if (conn.ip && (conn.domain.includes(targetUrl) || targetUrl.includes(conn.domain))) {
          originalIP = conn.ip;
          debug(`[ORIGINAL-IP] Found IP via partial match for ${targetUrl}: ${originalIP}`, debugMode);
          break;
        }
      }
    }
  } else if (domainToIP && domainToIP.has(targetUrl)) {
    // When aggregate server is not used, get IP from CDP tracking
    originalIP = domainToIP.get(targetUrl);
    debug(`[ORIGINAL-IP] Found IP from CDP for ${targetUrl}: ${originalIP}`, debugMode);
  } else if (response && response.remoteAddress) {
    // Fallback to response IP when available
    try {
      const remoteAddr = response.remoteAddress();
      if (remoteAddr && remoteAddr.ip) {
        originalIP = remoteAddr.ip;
        debug(`[ORIGINAL-IP] Found IP from response for ${targetUrl}: ${originalIP}`, debugMode);
      }
    } catch (ipError) {
      debug(`⚠️ Error extracting IP from response: ${ipError.message}`, debugMode);
    }
  }
  
  // ═══ REDIRECT DETECTION LOGIC ═══
  let redirectDetected = false;
  
  // METHOD 1: Check Location header from redirect response
  const { redirectInfo } = getRedirectInfo(global, debugMode);
  
  if (redirectInfo && redirectInfo.locationHeader) {
    try {
      let locationUrl = redirectInfo.locationHeader;
      
      // Handle relative URLs by making them absolute
      if (!locationUrl.startsWith('http')) {
        locationUrl = `https://${targetUrl}${locationUrl.startsWith('/') ? '' : '/'}${locationUrl}`;
      }
      
      const locationUrlObj = new URL(locationUrl);
      const locationDomain = locationUrlObj.hostname;
      
      if (targetUrl !== locationDomain) {
        if (validateRedirectCandidate(targetUrl, locationDomain, proxyStats, hasAggregateServer, debugMode)) {
          redirectedDomain = locationDomain;
          redirectDetected = true;
          redirectedIP = extractRedirectIP(locationDomain, proxyStats, hasAggregateServer, domainToIP, debugMode);
          debug(`[LOCATION-HEADER] Valid redirection detected: ${targetUrl} -> ${locationDomain} (HTTP ${redirectInfo.redirectStatus})`, debugMode);
        } else {
          debug(`[LOCATION-REJECTED] Location header ${locationDomain} not found in connections - ignoring redirect`, debugMode);
        }
      }
      
      // Clean up global redirect info
      delete global.redirectInfo;
    } catch (locationError) {
      debug(`⚠️ Error parsing Location header for redirect detection: ${locationError.message}`, debugMode);
      delete global.redirectInfo;
    }
  }
  
  // METHOD 2: Fallback to response URL comparison
  if (!redirectDetected) {
    const responseUrl = response ? response.url() : `https://${targetUrl}`;
    
    try {
      const finalUrlObj = new URL(responseUrl);
      const finalDomain = finalUrlObj.hostname;
      
      if (targetUrl !== finalDomain) {
        if (validateRedirectCandidate(targetUrl, finalDomain, proxyStats, hasAggregateServer, debugMode)) {
          redirectedDomain = finalDomain;
          redirectedIP = extractRedirectIP(finalDomain, proxyStats, hasAggregateServer, domainToIP, debugMode);
          debug(`[RESPONSE-URL] Valid redirection detected: ${targetUrl} -> ${finalDomain}`, debugMode);
        } else {
          debug(`[RESPONSE-REJECTED] Final URL ${finalDomain} not found in connections - ignoring redirect`, debugMode);
        }
      } else {
        debug(`📍 No redirection detected: ${targetUrl} (final: ${finalDomain})`, debugMode);
      }
    } catch (urlError) {
      debug(`⚠️ Error parsing final URL for redirect detection: ${urlError.message}`, debugMode);
    }
  }
  
  return {
    redirectedDomain,
    originalIP,
    redirectedIP,
    redirectDetected
  };
}

/**
 * Calculate comprehensive domain statistics from tracking data
 * @param {Object} params - Parameters object
 * @param {Array} params.httpErrorFailures - Array of HTTP error failures
 * @param {string} params.targetUrl - Target URL
 * @param {number} params.uniqueDomainsRequested - Total unique domains requested
 * @returns {Object} Domain statistics
 */
export function calculateDomainStatistics({ httpErrorFailures, targetUrl, uniqueDomainsRequested }) {
  const non200Domains = new Set();
  const connectionFailedDomains = new Set();
  const statusCounts = {
    '403': 0,
    '451': 0,
    '500': 0,
    '503': 0
  };
  const statusDomainNames = {
    '403': [],
    '451': [],
    '500': [],
    '503': []
  };
  
  // Process all HTTP error responses (excluding main domain to avoid double counting)
  httpErrorFailures.forEach(resource => {
    // Only count sub-domains, not the main target domain
    // Check if this domain is different from the main target URL
    const isMainDomain = (resource.domain === targetUrl || 
                        resource.domain === `www.${targetUrl}` || 
                        `www.${resource.domain}` === targetUrl);
    
    if (!isMainDomain && resource.statusCode) {
      non200Domains.add(resource.domain);
      
      // Count specific status codes for sub-domains (responses from each domain) and collect domain names
      const statusStr = resource.statusCode.toString();
      if (statusCounts.hasOwnProperty(statusStr)) {
        statusCounts[statusStr]++;
        // Add domain name if not already present
        if (!statusDomainNames[statusStr].includes(resource.domain)) {
          statusDomainNames[statusStr].push(resource.domain);
        }
      }
    }
  });
  
  return {
    non200Domains,
    connectionFailedDomains,
    statusCounts,
    statusDomainNames,
    uniqueDomainsRequested
  };
}

/**
 * Extract comprehensive connection statistics for CSV output
 * @param {Object} proxyStats - Proxy statistics object
 * @param {number} uniqueDomainsRequested - Default domain count
 * @returns {Object} Connection statistics
 */
export function extractConnectionStatistics(proxyStats, uniqueDomainsRequested, debugMode = false) {
  let totalDomainsForCsv = uniqueDomainsRequested; // Default to current count
  let migrationDisabledCount = 0;
  let newConnectionIdCount = 0;
  let migrationDisabledNewIdConflicts = '';
  let pvStateCounts = [0, 0, 0, 0, 0]; // idle, probing, validated, failed, migrated
  let pvProbingDomains = [];
  let pvFailedDomains = [];
  let statelessResetDomains = [];
  let migratedDomains = [];
  let connectionDetails = '';
  
  // Determine if using proxy and extract detailed stats
  const usingProxy = proxyStats && proxyStats.connections_detail;
  
  if (usingProxy) {
    try {
      const connections = parseConnectionsDetail(proxyStats.connections_detail);
      totalDomainsForCsv = connections.length; // Use connection count from proxy
      
      // Process each connection for detailed statistics
      connections.forEach(conn => {
        const domainIp = `${conn.domain}:${conn.ip}`;
        
        // Count migration disabled and new connection IDs
        if (conn.migrationDisabled) migrationDisabledCount++;
        if (conn.newConnectionIdReceived) newConnectionIdCount++;
        
        // Check for conflicting disabled + new_id combinations
        if (conn.migrationDisabled && conn.newConnectionIdReceived) {
          if (migrationDisabledNewIdConflicts) migrationDisabledNewIdConflicts += '; ';
          migrationDisabledNewIdConflicts += domainIp;
        }
        
        // Count path validation states
        const pvState = conn.pathValidationState || 'idle';
        switch (pvState) {
          case 'idle': pvStateCounts[0]++; break;
          case 'probing': 
            pvStateCounts[1]++; 
            pvProbingDomains.push(domainIp);
            break;
          case 'validated': pvStateCounts[2]++; break;
          case 'failed': 
            pvStateCounts[3]++; 
            pvFailedDomains.push(domainIp);
            break;
          case 'migrated': pvStateCounts[4]++; break;
          default: pvStateCounts[0]++; // Unknown counts as idle
        }
        
        // Track stateless resets
        if (conn.statelessReset) {
          statelessResetDomains.push(domainIp);
        }
        
        // Track migrated domains with data amounts
        if (conn.migratedPath > 0) {
          migratedDomains.push(`${domainIp}(${conn.totalData}:${conn.migratedPath})`);
        }
      });
      
      // Create comprehensive connection details string
      connectionDetails = proxyStats.connections_detail.replace(/[\r\n]+/g, ' ').trim();
      
    } catch (err) {
      // Keep defaults if parsing fails
      debug(`[WARNING] Failed to parse connection details for CSV: ${err.message}`, debugMode);
    }
  }
  
  // Format proxy-specific fields or use defaults for non-proxy mode
  return usingProxy ? {
    totalDomainsForCsv,
    newConnectionIdCount: newConnectionIdCount,
    migrationDisabledNewIdConflicts: migrationDisabledNewIdConflicts || '-',
    pvStateCounts: pvStateCounts.join(':'),
    pvProbingDomains: pvProbingDomains.join('; ') || '-',
    pvFailedDomains: pvFailedDomains.join('; ') || '-',
    statelessResetDomains: statelessResetDomains.join('; ') || '-',
    migratedDomains: migratedDomains.join('; ') || '-',
    connectionDetails: connectionDetails,
    totalOpenedStreams: proxyStats.total_opened_streams || 0,
    totalDataAmount: proxyStats.total_data_amount || 0,
    totalMigratedDataAmount: proxyStats.total_migrated_data_amount || 0,
    totalStatelessResets: proxyStats.total_stateless_resets || 0,
    totalMigrationDisabled: proxyStats.total_migration_disabled || 0,
    migrationSuccessRate: proxyStats.migration_success_rate || '0.0%'
  } : {
    totalDomainsForCsv,
    newConnectionIdCount: '-',
    migrationDisabledNewIdConflicts: '-',
    pvStateCounts: '-',
    pvProbingDomains: '-',
    pvFailedDomains: '-',
    statelessResetDomains: '-',
    migratedDomains: '-',
    connectionDetails: '-',
    totalOpenedStreams: '-',
    totalDataAmount: '-',
    totalMigratedDataAmount: '-',
    totalStatelessResets: '-',
    totalMigrationDisabled: '-',
    migrationSuccessRate: '-'
  };
}

/**
 * Detect Cloudflare challenge from response and resources
 * @param {Object} response - Puppeteer response object
 * @param {Array} requestedResources - Array of requested resources
 * @param {Array} failedResources - Array of failed resources
 * @returns {Object} Cloudflare detection results
 */
export function detectCloudflareChallenge(response, requestedResources, failedResources) {
  let cloudflareChallenge = '';
  let cloudflareDetected = 'No';
  
  // Check if main response was redirected to Cloudflare challenge
  const finalUrl = response ? response.url() : '';
  if (finalUrl.includes('challenges.cloudflare.com')) {
    cloudflareChallenge = ' [CLOUDFLARE CHALLENGE]';
    cloudflareDetected = 'Yes';
  }
  
  // Also check if any resources were from Cloudflare challenges
  const challengeResources = requestedResources.filter(r => r.url.includes('challenges.cloudflare.com'));
  if (challengeResources.length > 0 && !cloudflareChallenge) {
    cloudflareChallenge = ' [CLOUDFLARE CHALLENGE DETECTED]';
    cloudflareDetected = 'Yes';
  }
  
  // Check for Cloudflare challenge in failed resources
  const challengeFailures = failedResources.filter(f => f.domain && f.domain.includes('challenges.cloudflare.com'));
  if (challengeFailures.length > 0 && !cloudflareChallenge) {
    cloudflareChallenge = ' [CLOUDFLARE CHALLENGE IN FAILURES]';
    cloudflareDetected = 'Yes';
  }

  return {
    cloudflareChallenge,
    cloudflareDetected
  };
}

/**
 * Extract domain from URL
 * @param {string} url - URL to extract domain from
 * @returns {string} Extracted domain or fallback
 */
export function extractDomain(url) {
  try {
    if (url.startsWith('data:')) return 'data-url';
    if (url.startsWith('blob:')) return 'blob-url';
    if (url.startsWith('chrome-extension:')) return 'chrome-extension';
    if (url.startsWith('chrome:')) return 'chrome-internal';
    
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return url.split('/')[0] || 'unknown-domain';
  }
}

/**
 * Detect connection reset and failure patterns
 * @param {string} errorMessage - Error message to analyze
 * @returns {boolean} Whether this is a connection reset error
 */
export function isConnectionReset(errorMessage) {
  const resetPatterns = [
    /connection reset/i,
    /tcp_reset/i,
    /econnreset/i,
    /net::err_connection_reset/i,
    /net::err_connection_refused/i,
    /net::err_connection_aborted/i,
    /net::err_connection_closed/i,
    /net::err_connection_failed/i,
    /net::err_proxy_connection_failed/i,
    /net::err_tunnel_connection_failed/i
  ];
  return resetPatterns.some(pattern => pattern.test(errorMessage));
}

/**
 * Detect if request was aborted (not necessarily an error)
 * @param {string} errorMessage - Error message to analyze
 * @returns {boolean} Whether this is an aborted request
 */
export function isRequestAborted(errorMessage) {
  const abortedPatterns = [
    /net::err_aborted/i,
    /net::err_blocked_by_client/i,
    /net::err_blocked_by_response/i
  ];
  return abortedPatterns.some(pattern => pattern.test(errorMessage));
}

/**
 * Log detailed domain statistics summary
 * @param {Map} domainStats - Domain statistics map
 * @param {Map} failedDomains - Failed domains map
 * @param {Map} pendingDomains - Pending domains map
 * @param {Array} resetFailures - TCP reset failures
 * @param {Array} abortedFailures - Aborted request failures
 */
export function logDomainStatisticsSummary(domainStats, failedDomains, pendingDomains, resetFailures, abortedFailures) {
  log(`\\n=== DETAILED DOMAIN STATISTICS ===`);
  
  // Sort domains by total requests (most active first)
  const sortedDomains = Array.from(domainStats.entries()).sort((a, b) => b[1].totalRequests - a[1].totalRequests);
  
  // Show all domains together
  sortedDomains.forEach(([domain, stats]) => {
    const successRate = stats.totalRequests > 0 ? ((stats.successfulRequests / stats.totalRequests) * 100).toFixed(1) : '0';
    
    log(`\\n${domain} (${stats.ip || 'unknown'}):`);
    log(`  Requests: ${stats.totalRequests} total, ${stats.successfulRequests} success, ${stats.failedRequests} failed (${successRate}% success rate)`);
    log(`  Data: ${(stats.totalBytes / 1024).toFixed(2)} KB`);
    
    if (stats.httpErrorRequests > 0 || stats.connectionErrorRequests > 0) {
      log(`  Errors: ${stats.httpErrorRequests} HTTP errors, ${stats.connectionErrorRequests} connection errors`);
    }
    
    // Show status code distribution
    if (stats.statusCodes.size > 0) {
      const statusSummary = Array.from(stats.statusCodes.entries())
        .filter(([code, count]) => !code.includes('x')) // Only show specific codes, not ranges
        .sort((a, b) => b[1] - a[1]) // Sort by count
        .slice(0, 5) // Top 5 status codes
        .map(([code, count]) => `${code}:${count}`)
        .join(', ');
      if (statusSummary) {
        log(`  Status codes: ${statusSummary}`);
      }
    }
    
    // Show resource type breakdown
    if (stats.resourceTypes.size > 0) {
      const resourceBreakdown = Array.from(stats.resourceTypes.entries())
        .sort((a, b) => b[1].requested - a[1].requested)
        .map(([type, counts]) => {
          let typeStr = `${type}:${counts.requested}`;
          if (counts.failed > 0) {
            typeStr += ` (${counts.failed} failed)`;
          }
          return typeStr;
        })
        .join(', ');
      
      log(`  Resources: ${resourceBreakdown}`);
      
      // Show detailed breakdown for domains with failures
      if (stats.failedRequests > 0) {
        log(`  Detailed resource failures:`);
        stats.resourceTypes.forEach((counts, type) => {
          if (counts.failed > 0) {
            log(`    ${type}: ${counts.httpErrors} HTTP errors, ${counts.connectionErrors} connection errors`);
          }
        });
      }
    }
    
    // Show error messages if any
    if (stats.errorMessages.size > 0) {
      const errorSummary = Array.from(stats.errorMessages).slice(0, 2).join(', '); // Show first 2 errors
      log(`  Errors: ${errorSummary}${stats.errorMessages.size > 2 ? '...' : ''}`);
    }
  });
  
  if (failedDomains.size > 0) {
    log(`\\n=== FAILED DOMAINS DETAIL ===`);
    failedDomains.forEach((info, domain) => {
      const errorList = Array.from(info.errors).join(', ');
      log(`${domain}:`);
      log(`  - ${info.count} resource${info.count > 1 ? 's' : ''} failed`);
      log(`  - ${info.httpErrors} HTTP errors, ${info.connectionErrors} connection errors`);
      log(`  - Errors: ${errorList}`);
    });
  }
  
  if (resetFailures.length > 0) {
    log(`\\n=== TCP RST FAILURES ===`);
    log(`TCP RST failures: ${resetFailures.length}`);
    resetFailures.forEach(f => {
      log(`  - ${f.resourceType}: ${f.domain} - ${f.errorText}`);
    });
  }
  
  if (abortedFailures.length > 0) {
    log(`\\n=== ABORTED REQUESTS ===`);
    log(`Aborted requests: ${abortedFailures.length} (usually browser optimization or ad blocking)`);
    abortedFailures.forEach(f => {
      log(`  - ${f.resourceType}: ${f.domain} - ${f.errorText}`);
    });
  }
  
  if (pendingDomains.size > 0) {
    log(`\\n=== PENDING DOMAINS ===`);
    log(`Pending domains: ${pendingDomains.size} (resources still loading after page load event)`);
    log();
    pendingDomains.forEach((info, domain) => {
      const resourceTypes = Array.from(info.resourceTypes).join(', ');
      log(`  - ${domain}: ${info.count} resource${info.count > 1 ? 's' : ''} - ${resourceTypes}`);
    });
  }
}
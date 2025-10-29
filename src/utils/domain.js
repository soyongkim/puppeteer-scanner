/**
 * Domain utility functions for URL processing and domain statistics
 */

/**
 * Extract domain/hostname from URL with proper error handling
 * @param {string} url - The URL to extract domain from
 * @returns {string} - The domain name or fallback value
 */
export function getDomainFromUrl(url) {
  try {
    if (!url) return 'unknown';
    
    if (url.startsWith('data:')) {
      return 'data-url';
    }
    if (url.startsWith('blob:')) {
      return 'blob-url';
    }
    if (url.startsWith('chrome-extension:')) {
      return 'chrome-extension';
    }
    if (url.startsWith('chrome:')) {
      return 'chrome-internal';
    }
    
    return new URL(url).hostname;
  } catch {
    return 'invalid-url';
  }
}

/**
 * Initialize domain statistics structure
 * @param {string} domain - Domain name
 * @param {Map} domainStats - Domain statistics map
 * @returns {Object} - Domain statistics object
 */
export function initializeDomainStats(domain, domainStats) {
  if (!domainStats.has(domain)) {
    domainStats.set(domain, {
      domain: domain,
      ip: null, // Will be extracted from Chromium's network activity
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      httpErrorRequests: 0, // Non-200 status codes
      connectionErrorRequests: 0, // net::ERR_ type errors
      totalBytes: 0,
      resourceTypes: new Map(), // Track by resource type
      statusCodes: new Map(), // Track status code distribution
      errorMessages: new Set(), // Unique error messages
      firstSeen: Date.now(),
      lastActivity: Date.now()
    });
  }
  return domainStats.get(domain);
}

/**
 * Increment domain statistics for a request
 * @param {string} domain - Domain name
 * @param {Map} domainStats - Domain statistics map
 * @param {string} type - Type of increment (total, success, failed, etc.)
 * @param {Object} options - Additional options like bytes, resourceType, statusCode
 */
export function incrementDomainStats(domain, domainStats, type, options = {}) {
  const stats = initializeDomainStats(domain, domainStats);
  
  switch (type) {
    case 'total':
      stats.totalRequests++;
      break;
    case 'success':
      stats.successfulRequests++;
      break;
    case 'failed':
      stats.failedRequests++;
      break;
    case 'httpError':
      stats.httpErrorRequests++;
      break;
    case 'connectionError':
      stats.connectionErrorRequests++;
      break;
  }
  
  if (options.bytes) {
    stats.totalBytes += options.bytes;
  }
  
  if (options.resourceType) {
    const currentCount = stats.resourceTypes.get(options.resourceType) || 0;
    stats.resourceTypes.set(options.resourceType, currentCount + 1);
  }
  
  if (options.statusCode) {
    const currentCount = stats.statusCodes.get(options.statusCode) || 0;
    stats.statusCodes.set(options.statusCode, currentCount + 1);
  }
  
  if (options.errorMessage) {
    stats.errorMessages.add(options.errorMessage);
  }
  
  stats.lastActivity = Date.now();
}
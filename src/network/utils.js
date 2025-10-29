/**
 * Network utilities for domain extraction and connection analysis
 */

/**
 * Extract domain from URL
 * @param {string} url - Full URL
 * @returns {string} Domain name
 */
export function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    // Handle malformed URLs by trying to extract domain manually
    const match = url.match(/^(?:https?:\/\/)?(?:www\.)?([^\/\s]+)/);
    return match ? match[1] : url;
  }
}

/**
 * Check if error message indicates a connection reset
 * @param {string} errorMessage - Error message from request failure
 * @returns {boolean} True if connection was reset
 */
export function isConnectionReset(errorMessage) {
  const resetPatterns = [
    'net::ERR_CONNECTION_RESET',
    'net::ERR_CONNECTION_ABORTED', 
    'net::ERR_NETWORK_CHANGED',
    'net::ERR_INTERNET_DISCONNECTED',
    'Connection reset',
    'connection was forcibly closed',
    'connection reset by peer'
  ];
  
  return resetPatterns.some(pattern => 
    errorMessage.toLowerCase().includes(pattern.toLowerCase())
  );
}

/**
 * Check if error message indicates request was aborted
 * @param {string} errorMessage - Error message from request failure
 * @returns {boolean} True if request was aborted
 */
export function isRequestAborted(errorMessage) {
  const abortPatterns = [
    'net::ERR_ABORTED',
    'Request was aborted', 
    'Request aborted',
    'Operation was aborted'
  ];
  
  return abortPatterns.some(pattern => 
    errorMessage.toLowerCase().includes(pattern.toLowerCase())
  );
}

/**
 * Check if resource type is typically load-blocking
 * @param {Object} request - Puppeteer request object
 * @returns {boolean} True if resource is likely load-blocking
 */
export function isLoadBlockingResource(request) {
  const resourceType = request.resourceType();
  const url = request.url();
  
  // Load-blocking resource types
  if (['document', 'stylesheet', 'script'].includes(resourceType)) {
    return true;
  }
  
  // Check for synchronous script patterns
  if (resourceType === 'script' && !url.includes('async') && !url.includes('defer')) {
    return true;
  }
  
  // Fonts can be load-blocking depending on font-display
  if (resourceType === 'font') {
    return true;
  }
  
  return false;
}

/**
 * Extract IP address from response headers or connection info
 * @param {Object} response - Puppeteer response object  
 * @param {string} domain - Domain name for logging
 * @returns {string|null} IP address if found
 */
export function extractIPFromResponse(response, domain) {
  // Try to get from response connection info
  if (response.remoteAddress && response.remoteAddress.ip) {
    return response.remoteAddress.ip;
  }
  
  // Try alternative methods to extract IP
  const headers = response.headers();
  
  // Check for forwarded headers (when behind proxy/CDN)
  if (headers['x-forwarded-for']) {
    return headers['x-forwarded-for'].split(',')[0].trim();
  }
  
  if (headers['x-real-ip']) {
    return headers['x-real-ip'];
  }
  
  if (headers['cf-connecting-ip']) {
    return headers['cf-connecting-ip'];
  }
  
  return null;
}
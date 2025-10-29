/**
 * Request filtering utilities for ad blocking and content filtering
 */

import { AD_BLOCKING_KEYWORDS } from '../config/constants.js';

/**
 * Check if domain should be blocked based on keywords
 * @param {string} url - URL to check
 * @param {string[]} blockedKeywords - Array of keywords to block
 * @returns {boolean} True if domain should be blocked
 */
export function shouldBlockDomain(url, blockedKeywords = []) {
  if (!blockedKeywords.length) return false;
  
  const urlLower = url.toLowerCase();
  
  // Extract domain from URL
  let domain;
  try {
    domain = new URL(url).hostname.toLowerCase();
  } catch (e) {
    domain = url.toLowerCase();
  }
  
  // Check if domain or URL contains any blocked keywords
  for (const keyword of blockedKeywords) {
    const keywordLower = keyword.toLowerCase();
    
    // Check if keyword is in domain or URL
    if (domain.includes(keywordLower) || urlLower.includes(keywordLower)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Determine if a request should be ignored based on filtering rules
 * @param {string} url - Request URL
 * @param {string} resourceType - Type of resource
 * @param {Object} config - Configuration object
 * @returns {Object} Filter decision with reason
 */
export function shouldIgnoreRequest(url, resourceType, config) {
  // Get blocked keywords based on config
  const blockedKeywords = config.noAdBlocking ? AD_BLOCKING_KEYWORDS : [];
  
  // Check if domain should be blocked
  if (shouldBlockDomain(url, blockedKeywords)) {
    return { 
      shouldIgnore: true, 
      reason: 'blocked_domain',
      category: 'ad_tracking'
    };
  }
  
  // Additional filtering rules can be added here
  // For example, blocking specific resource types, file extensions, etc.
  
  return { 
    shouldIgnore: false, 
    reason: null,
    category: null
  };
}

/**
 * Create request interceptor function
 * @param {Object} config - Configuration object
 * @returns {Function} Request interceptor function
 */
export function createRequestInterceptor(config) {
  return async (request) => {
    const url = request.url();
    const resourceType = request.resourceType();
    
    const filterResult = shouldIgnoreRequest(url, resourceType, config);
    
    if (filterResult.shouldIgnore) {
      // Block the request
      await request.abort('blockedbyclient');
      return;
    }
    
    // Allow the request to continue
    await request.continue();
  };
}
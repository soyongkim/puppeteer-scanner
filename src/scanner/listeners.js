/**
 * Page event listeners for resource tracking
 * Extracted from the original puppeteer-scanner.js
 */

import { getDomainFromUrl, incrementDomainStats, initializeDomainStats } from '../utils/domain.js';
import { debug } from '../utils/logger.js';

/**
 * Set up page event listeners for resource tracking
 * @param {Object} page - Puppeteer page instance
 * @param {Object} state - Scanner state object
 * @param {Object} config - Configuration object
 */
export function setupPageListeners(page, state, config) {
  
  page.on('request', req => {
    const url = req.url();
    const domain = getDomainFromUrl(url);
    const resourceType = req.resourceType();
    
    // Handle request interception if enabled
    if (config.noAdBlocking && req.isInterceptResolutionHandled && !req.isInterceptResolutionHandled()) {
      req.continue();
    }
    
    // Initialize domain stats if first time seeing this domain
    const stats = initializeDomainStats(domain, state.domainStats);
    
    // Increment domain stats
    incrementDomainStats(domain, state.domainStats, 'total', {
      resourceType: resourceType
    });
    
    // Record full resource information
    const resourceInfo = {
      url: url,
      domain: domain,
      resourceType: resourceType,
      method: req.method(),
      requestedAfterLoad: state.loadEventFired
    };
    state.requestedResources.push(resourceInfo);
    
    // Track pending request
    state.pendingResources.set(url, {
      domain: domain,
      resourceType: resourceType,
      method: req.method(),
      requestedAfterLoad: state.loadEventFired,
      startTime: Date.now()
    });
    
    // Extract resource name (path + query) and truncate if longer than 50 characters
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
    
    // Log all resources
    const timingInfo = state.loadEventFired ? '[AFTER-LOAD]' : '[BEFORE-LOAD]';
    debug(`[${resourceType.toUpperCase()}] ${timingInfo} ${req.method()} ${domain}${resourceName}`, config.debugMode);
  });

  page.on('requestfailed', req => {
    const url = req.url();
    const domain = getDomainFromUrl(url);
    const failure = req.failure();
    const resourceType = req.resourceType();
    
    // Extract resource name for better logging
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
    
    // Remove from pending requests
    state.pendingResources.delete(url);
    
    // Update domain stats
    incrementDomainStats(domain, state.domainStats, 'failed', {
      resourceType: resourceType,
      errorMessage: failure?.errorText
    });
      
    // Add to failure tracking
    if (failure && failure.errorText) {
      // Track as failed resource
      const failedResource = {
        url: url,
        domain: domain,
        resourceType: resourceType,
        errorText: failure.errorText,
        errorType: 'connection_error'
      };
      state.failedResources.push(failedResource);
      debug(`[FAILED-RST] ${resourceType.toUpperCase()} ${domain} - ${failure.errorText}`, config.debugMode);
    }
  });

  page.on('response', async res => {
    const req = res.request();
    const url = req.url();
    const domain = getDomainFromUrl(url);
    const status = res.status();
    const resourceType = req.resourceType();

    // Calculate response size
    let len = 0;
    if (res.headers()['content-length']) {
      len = parseInt(res.headers()['content-length'], 10);
    }
    if (!len) {
      try { 
        len = (await res.buffer()).length; 
      } catch { 
        len = 0; 
      }
    }
    
    // Remove from pending requests
    state.pendingResources.delete(url);
    
    // Update domain stats
    const stats = state.domainStats.get(domain);
    if (stats) {
      // Track status code distribution
      const statusKey = `${Math.floor(status / 100)}xx`;
      stats.statusCodes.set(statusKey, (stats.statusCodes.get(statusKey) || 0) + 1);
      stats.statusCodes.set(status.toString(), (stats.statusCodes.get(status.toString()) || 0) + 1);
      
      // Track bytes (both per-domain and global)
      stats.totalBytes += len;
      state.totalBytes += len;
      
      // Treat 2xx and 3xx (redirects) as successful
      if (status >= 200 && status < 400) {
        incrementDomainStats(domain, state.domainStats, 'success', {
          resourceType: resourceType,
          statusCode: status,
          bytes: len
        });
        state.succeededResources.add(domain);
        
        // Log successful resources (only for debugging if needed)
        // debug(`[SUCCESS] ${resourceType.toUpperCase()} ${domain} - ${status}`, config.debugMode);
      } else {
        // Handle HTTP errors (4xx, 5xx)
        incrementDomainStats(domain, state.domainStats, 'httpError', {
          resourceType: resourceType,
          statusCode: status,
          bytes: len
        });
        
        const failedResource = {
          url: url,
          domain: domain,
          resourceType: resourceType,
          statusCode: status,
          errorType: 'http_error'
        };
        state.failedResources.push(failedResource);
        
        debug(`[HTTP-ERROR] ${resourceType.toUpperCase()} ${domain} - HTTP ${status}`, config.debugMode);
      }
      
      // Track main status for the target domain
      const isMainDomain = (domain === config.targetUrl || 
                           domain === `www.${config.targetUrl}` || 
                           `www.${domain}` === config.targetUrl);
      
      if (isMainDomain && resourceType === 'document') {
        if (!state.firstMainDocumentStatus) {
          state.firstMainDocumentStatus = status;
          debug(`[MAIN-STATUS] First main document status: ${status}`, config.debugMode);
        }
        
        // Update highest priority status based on error severity
        if (!state.highestPriorityStatus || 
            (status >= 400 && (!state.highestPriorityStatus || state.highestPriorityStatus < 400))) {
          state.highestPriorityStatus = status;
        }
      }
    }
  });
}
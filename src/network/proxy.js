/**
 * Proxy handling and statistics module
 * Manages QUIC proxy connections, statistics fetching, and data analysis
 */

import fetch from 'node-fetch';
import { debug } from '../utils/logger.js';

/**
 * Fetch proxy statistics from the proxy server
 * @param {string} reportUrl - URL to fetch stats from (e.g., http://localhost:9090/stats)
 * @param {boolean} debugMode - Whether debug logging is enabled
 * @returns {Promise<Object>} Proxy statistics object
 */
export async function fetchProxyStats(reportUrl, debugMode = false) {
  try {
    debug(`Fetching QUIC proxy statistics from ${reportUrl}...`, debugMode);
    const response = await fetch(reportUrl, {
      timeout: 5000 // 5 second timeout
    });
    
    if (!response.ok) {
      debug(`Proxy stats request failed: HTTP ${response.status}`, debugMode);
      return null;
    }
    
    const stats = await response.json();
    debug(`Proxy stats retrieved: ${stats.total_opened_streams} streams, ${stats.total_redirects} redirects, ${stats.total_data_amount} bytes total, ${stats.total_migrated_data_amount} bytes migrated`, debugMode);
    
    // Log DNS fallback status
    if (stats.dns_fallback_occurred !== undefined) {
      debug(`DNS Fallback: ${stats.dns_fallback_occurred ? 'YES' : 'NO'}`, debugMode);
    }
    
    return {
      total_opened_streams: stats.total_opened_streams || 0,
      total_redirects: stats.total_redirects || 0,
      total_data_amount: stats.total_data_amount || 0,
      total_previous_data_amount: stats.total_previous_data_amount || 0,
      total_migrated_data_amount: stats.total_migrated_data_amount || 0,
      total_stateless_resets: stats.total_stateless_resets || 0,
      total_migration_disabled: stats.total_migration_disabled || 0,
      migration_success_rate: stats.total_data_amount > 0 ? 
        ((stats.total_migrated_data_amount / stats.total_data_amount) * 100).toFixed(2) : 0,
      timestamp: stats.timestamp || Date.now(),
      dns_fallback_occurred: stats.dns_fallback_occurred || false,
      connections_detail: stats.connections_detail || ''
    };
  } catch (err) {
    debug(`Failed to fetch proxy stats: ${err.message}`, debugMode);
    return {
      total_opened_streams: 0,
      total_redirects: 0,
      total_data_amount: 0,
      total_previous_data_amount: 0,
      total_migrated_data_amount: 0,
      total_stateless_resets: 0,
      total_migration_disabled: 0,
      migration_success_rate: 0,
      timestamp: Date.now(),
      dns_fallback_occurred: false,
      error: err.message
    };
  }
}

/**
 * Parse the proxy connections detail string into structured data
 * @param {string} connectionsDetail - Raw connections detail string
 * @param {boolean} debugMode - Whether debug logging is enabled
 * @returns {Array<Object>} Parsed connection objects
 */
export function parseConnectionsDetail(connectionsDetail, debugMode = false) {
  if (!connectionsDetail) return [];
  
  const connections = [];
  const matches = connectionsDetail.match(/\{([^}]+)\}/g) || [];
  

  
  matches.forEach(match => {
    try {
      const content = match.slice(1, -1); // Remove { }
      const parts = content.split(';').map(p => p.trim());
      
      if (parts.length < 2) return; // Skip malformed entries
      
      // Parse domain:ip:port from first part
      const domainParts = parts[0].split(':');
      if (domainParts.length < 3) return;
      
      const connection = {
        domain: domainParts[0],
        ip: domainParts[1],
        port: domainParts[2],
        statusInfo: {},
        migrationDisabled: false,
        statelessReset: false,
        newConnectionIdReceived: false,
        pathValidationState: 'unknown',
        totalData: 0,
        previousPath: 0,
        migratedPath: 0,
        connectionFailed: false,
        failureReason: null
      };
      
      // Parse each part
      parts.forEach(part => {
        if (part.startsWith('status:')) {
          // Parse status codes (e.g., "status:200:13 204:1" or "status:Connection Close: 296" or "status:handshake fail")
          const statusPart = part.substring(7); // Remove 'status:'
          
          // Check for handshake failures or other connection failures
          if (statusPart.includes('handshake fail')) {
            connection.connectionFailed = true;
            connection.failureReason = 'handshake fail';
            connection.statusInfo['handshake fail'] = '1';
          } else if (statusPart.includes('Connection Close')) {
            connection.statusInfo['Connection Close'] = statusPart.split(': ')[1] || '1';
            connection.connectionFailed = true;
            connection.failureReason = 'Connection Close';
          } else if (statusPart.includes('timeout')) {
            connection.connectionFailed = true;
            connection.failureReason = 'timeout';
            connection.statusInfo['timeout'] = '1';
          } else if (statusPart.includes('refused')) {
            connection.connectionFailed = true;
            connection.failureReason = 'connection refused';
            connection.statusInfo['connection refused'] = '1';
          } else if (statusPart.includes('unreachable')) {
            connection.connectionFailed = true;
            connection.failureReason = 'network unreachable';
            connection.statusInfo['network unreachable'] = '1';
          } else {
            const statusMatches = statusPart.match(/(\d+):(\d+)/g) || [];
            statusMatches.forEach(sm => {
              const [code, count] = sm.split(':');
              connection.statusInfo[code] = parseInt(count);
            });
          }
        } else if (part.includes('disable_connection_migration:')) {
          connection.migrationDisabled = part.includes('true');
        } else if (part.includes('stateless_reset:')) {
          connection.statelessReset = part.includes('true');
        } else if (part.startsWith('total_data:')) {
          connection.totalData = parseInt(part.split(':')[1]) || 0;
        } else if (part.startsWith('previous_path:')) {
          connection.previousPath = parseInt(part.split(':')[1]) || 0;
        } else if (part.startsWith('migrated_path:')) {
          connection.migratedPath = parseInt(part.split(':')[1]) || 0;
        } else if (part.includes('new_connection_id_received:')) {
          connection.newConnectionIdReceived = part.includes('true');
        } else if (part.startsWith('path_validation_state:')) {
          connection.pathValidationState = part.split(':')[1] || 'unknown';
        }
      });
      
      connections.push(connection);
    } catch (err) {
      debug(`[WARNING] Failed to parse connection detail: ${match} - ${err.message}`, debugMode);
    }
  });
  
  return connections;
}

/**
 * Extract real IP address from proxy connections for a target domain
 * @param {string} targetDomain - Domain to find IP for
 * @param {Object} proxyStats - Proxy statistics object
 * @param {boolean} debugMode - Whether debug logging is enabled
 * @returns {Object|null} Connection information or null if not found
 */
export function extractRealIPFromProxy(targetDomain, proxyStats, debugMode = false) {
  if (!proxyStats || !proxyStats.connections_detail) {
    return null;
  }
  
  const connections = parseConnectionsDetail(proxyStats.connections_detail, debugMode);
  
  // Find connection for target domain (try exact match first, then with/without www)
  let targetConnection = connections.find(conn => conn.domain === targetDomain);
  
  if (!targetConnection) {
    // Try with www prefix
    targetConnection = connections.find(conn => conn.domain === `www.${targetDomain}`);
  }
  
  if (!targetConnection) {
    // Try without www prefix
    const withoutWww = targetDomain.replace(/^www\\./, '');
    targetConnection = connections.find(conn => conn.domain === withoutWww);
  }
  
  if (targetConnection) {
    debug(`Found connection for ${targetDomain}: ${targetConnection.ip} (from ${targetConnection.domain})`, debugMode);
    return {
      ip: targetConnection.ip,
      domain: targetConnection.domain,
      statusInfo: targetConnection.statusInfo,
      totalData: targetConnection.totalData,
      migrationDisabled: targetConnection.migrationDisabled,
      newConnectionIdReceived: targetConnection.newConnectionIdReceived,
      pathValidationState: targetConnection.pathValidationState
    };
  }
  
  // If no direct match, show all available connections for debugging
  if (connections.length > 0) {
    debug(`No direct match for ${targetDomain}. Available connections:`, debugMode);
    connections.forEach(conn => {
      debug(`   - ${conn.domain} -> ${conn.ip}`, debugMode);
    });
  }
  
  return null;
}

/**
 * Extract HTTP status code from proxy connection for a target domain
 * @param {string} targetDomain - Domain to find status for
 * @param {Object} proxyStats - Proxy statistics object
 * @returns {string} Status code or error description
 */
export function extractStatusFromProxyConnection(targetDomain, proxyStats) {
  if (!proxyStats || !proxyStats.connections_detail) {
    return '-';
  }
  
  const connections = parseConnectionsDetail(proxyStats.connections_detail);

  
  // Find connection for target domain (try exact match first, then with/without www)
  let targetConnection = connections.find(conn => conn.domain === targetDomain);
  
  if (!targetConnection) {
    // Try with www prefix
    targetConnection = connections.find(conn => conn.domain === `www.${targetDomain}`);
  }
  
  if (!targetConnection) {
    // Try without www prefix
    const withoutWww = targetDomain.replace(/^www\\./, '');
    targetConnection = connections.find(conn => conn.domain === withoutWww);
  }
  
  if (targetConnection) {
    // Check for HTTP status codes first
    const statusInfo = targetConnection.statusInfo;
    for (const [status, count] of Object.entries(statusInfo)) {
      if (status.match(/^\d+$/)) {
        // Return HTTP status code
        return status;
      }
    }
    
    // Check for connection errors
    if (statusInfo['Connection Close']) {
      return `Connection Close: ${statusInfo['Connection Close']}`;
    }
    
    if (targetConnection.connectionFailed) {
      return targetConnection.failureReason || 'Connection Failed';
    }
    
    // Default to first status if available
    const firstStatus = Object.keys(statusInfo)[0];
    if (firstStatus) {
      return `${firstStatus}: ${statusInfo[firstStatus]}`;
    }
  }
  
  return '-';
}

/**
 * Get default proxy statistics object (for when no proxy is used)
 * @returns {Object} Empty proxy statistics
 */
export function getDefaultProxyStats() {
  return {
    total_opened_streams: 0,
    total_redirects: 0,
    total_data_amount: 0,
    total_migrated_data_amount: 0,
    migration_success_rate: '0%',
    dns_fallback_occurred: false
  };
}
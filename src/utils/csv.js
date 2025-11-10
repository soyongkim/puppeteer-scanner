/**
 * CSV handling utilities for exporting scanner results
 */

import fs from 'fs';
import path from 'path';

/**
 * Escape CSV fields that contain commas, quotes, or newlines
 * @param {string} field - Field to escape
 * @returns {string} Escaped field
 */
export function escapeCsvField(field) {
  if (field && (field.includes(',') || field.includes('"') || field.includes('\n'))) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field || '';
}

/**
 * Generate CSV header for the analysis results (matches original format exactly)
 * @returns {string} CSV header row
 */
export function generateCsvHeader() {
  return 'timestamp,domain,ip_addr,first_status_code,redirected_domain,redirected_ip,redirected_status_code,Primary Language,Declared Language,chrome_fail,load_time,total domains,failed domains,not 200 domains,403 responses,451 responses,500 responses,503 responses,403 domain names,451 domain names,500 domain names,503 domain names,TCP return,cloudflare_challenge,total_opened_streams,total_data_amount,total_migrated_data_amount,migrated_data_rate,total_stateless_resets,total_disable_connection_migrations,new_connection_id_count,migration_disabled_new_id_conflicts,PVstate_idle:probing:validated:failed:migrated,pv_probing_domains,pv_failed_domains,stateless_reset_domains,migrated_domains,connection_details\n';
}

/**
 * Format analysis results into a CSV row (matches original format exactly)
 * @param {Object} results - Analysis results object
 * @returns {string} Formatted CSV row
 */
export function formatCsvRow(results) {
  const {
    targetUrl,
    originalIP,
    firstStatusCode,
    redirectedDomain,
    redirectedIP,
    redirectedStatusCode,
    languageResults,
    loadTime,
    uniqueDomainsRequested,
    connectionFailedDomains,
    non200Domains,
    statusCounts,
    statusDomainNames,
    tcpResult,
    cloudflareDetected,
    proxyFields,
    connectionDetails
  } = results;

  // Format domain names for CSV (semicolon separated with trailing slash)
  const format403DomainNames = statusDomainNames['403'].map(domain => `${domain}/`).join('; ');
  const format451DomainNames = statusDomainNames['451'].map(domain => `${domain}/`).join('; ');
  const format500DomainNames = statusDomainNames['500'].map(domain => `${domain}/`).join('; ');
  const format503DomainNames = statusDomainNames['503'].map(domain => `${domain}/`).join('; ');

  // Generate timestamp for this scan
  const timestamp = new Date().toISOString();
  
  // Construct row with timestamp as first column
  const chromeFail = results.chromeFail || '-';
  return `${timestamp},${escapeCsvField(targetUrl)},${escapeCsvField(originalIP)},${firstStatusCode},${escapeCsvField(redirectedDomain)},${escapeCsvField(redirectedIP)},${redirectedStatusCode},${escapeCsvField(languageResults.primaryLanguage)},${escapeCsvField(languageResults.declaredLanguage)},${chromeFail},${loadTime},${uniqueDomainsRequested},${connectionFailedDomains.size},${non200Domains.size},${statusCounts['403']},${statusCounts['451']},${statusCounts['500']},${statusCounts['503']},"${format403DomainNames}","${format451DomainNames}","${format500DomainNames}","${format503DomainNames}",${tcpResult},${cloudflareDetected},${proxyFields.totalOpenedStreams},${proxyFields.totalDataAmount},${proxyFields.totalMigratedDataAmount},${proxyFields.migrationSuccessRate},${proxyFields.totalStatelessResets},${proxyFields.totalMigrationDisabled},${proxyFields.newConnectionIdCount},${proxyFields.migrationDisabledNewIdConflicts},${proxyFields.pvStateCounts},${proxyFields.pvProbingDomains},${proxyFields.pvFailedDomains},${proxyFields.statelessResetDomains},${proxyFields.migratedDomains},${proxyFields.connectionDetails}\n`;
}

/**
 * Write results to CSV file
 * @param {string} csvPath - Path to CSV file
 * @param {Object} results - Analysis results
 */
export function writeToCsv(csvPath, results) {
  const csvFullPath = path.resolve(csvPath);
  
  // Add header if file doesn't exist
  if (!fs.existsSync(csvFullPath)) {
    fs.writeFileSync(csvFullPath, generateCsvHeader());
  }
  
  // Append results row
  const row = formatCsvRow(results);
  fs.appendFileSync(csvFullPath, row);
}
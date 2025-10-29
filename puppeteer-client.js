#!/usr/bin/env node

/**
 * Puppeteer Scanner - Main Entry Point
 * 
 * A comprehensive web page analysis tool using Puppeteer and Chrome headless
 * for detailed performance monitoring, resource tracking, and network analysis.
 * 
 * @author soyongkim
 * @version 1.0.0
 */

import { handleScanError, logResourceStatistics, processResults } from './src/analysis/results.js';
import { getConfiguration, parseArguments, validateConfiguration } from './src/config/arguments.js';
import { initializeScannerState, performPageScan } from './src/scanner/core.js';
import { error, log } from './src/utils/logger.js';
// Proxy functions are now available in: ./src/network/proxy.js
// - fetchProxyStats(reportUrl)
// - parseConnectionsDetail(connectionsDetail)  
// - extractRealIPFromProxy(targetDomain, proxyStats)
// - extractStatusFromProxyConnection(targetDomain, proxyStats)
// - getDefaultProxyStats()

/**
 * Main application entry point
 */
async function main() {
  // Parse command line arguments
  const argMap = parseArguments();
  const config = getConfiguration(argMap);
  
  // Initialize scanner state (moved outside try block for error handling access)
  let state = null;
  
  try {
    // Validate configuration
    if (!validateConfiguration(config)) {
      process.exit(1);
    }
    
    // Initialize scanner state
    state = initializeScannerState();
    
    // Display configuration
    log(`Starting Puppeteer Scanner for: ${config.targetUrl}`);
    log(`Output: ${config.csvFile}`);
    log(`TCP fallback: ${config.tcpFallback ? 'ENABLED' : 'DISABLED'}`);
    log(`Proxy: ${config.useProxy ? 'ENABLED' : 'DISABLED'}`);
    if (config.useProxy) {
      log(`   Proxy host: ${config.proxyHost}`);
      log(`   Stats URL: ${config.reportUrl}`);
    }
    
    // Perform the scan
    const scanResult = await performPageScan(config, state);
    
    log('Scan completed successfully!');
    
    // Log detailed resource statistics
    logResourceStatistics(scanResult, config);
    
    // Process results and generate CSV output
    const processedResults = await processResults(scanResult, config);
    
    log(`\nSCAN SUMMARY:`);
    
    // Domain information
    const redirectAnalysis = processedResults.scanSummary.redirectAnalysis;
    if (redirectAnalysis && redirectAnalysis.redirectedDomain !== '-') {
      log(`- Target domain: ${config.targetUrl} → ${redirectAnalysis.redirectedDomain} (redirected)`);
    } else {
      log(`- Target domain: ${config.targetUrl} (no redirection)`);
    }
    
    log(`- Total resources: ${processedResults.scanSummary.totalRequested}`);
    log(`- Unique domains: ${processedResults.scanSummary.uniqueDomainsRequested}`);
    log(`- Successful: ${processedResults.scanSummary.totalSucceeded}`);
    log(`- Failed: ${processedResults.scanSummary.totalFailed}`);
    log(`- Load time: ${processedResults.scanSummary.loadTime}s`);
    log(`- Total bytes: ${(processedResults.scanSummary.totalBytes / 1024).toFixed(2)} KB`);
    log(`- Language: ${processedResults.scanSummary.languageResults.primaryLanguage} (${processedResults.scanSummary.languageResults.confidence})`);
    
    if (config.csvFile) {
      log(`\nResults written to: ${config.csvFile}`);
    }
    
    // Clean up
    await scanResult.browser.close();
    
  } catch (err) {
    error(`Scan failed: ${err.message}`);
    
    // Handle errors with comprehensive error processing and CSV output
    // Initialize state if it wasn't created yet
    if (!state) {
      state = initializeScannerState();
    }
    await handleScanError(err, config, state);
    
    if (config && config.debugMode) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

// Handle process termination
process.on('SIGINT', () => {
  log('\nScanner interrupted by user');
  process.exit(0);
});

process.on('unhandledRejection', (err) => {
  error(`Unhandled rejection: ${err.message}`);
  process.exit(1);
});

// Run the application
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
/*  webpage_test.js
 *  Usage examples
 *    node webpage_test.js --url=example.com
 *    node webpage_test.js --url=example.com --use-proxy=true --csv=batch_01.csv
 *    node webpage_test.js --url=example.com --use-proxy=true --tcp-fallback
 *
 *  Features:
 *    - Records detailed resource information (URL, domain, type, method)
 *    - Tracks domains and their success/failure status 
 *    - Detects TCP RST packets and connection failures when using proxy
 *    - Optional TCP fallback on QUIC connection failures (--tcp-fallback)
 *    - Records failed domains with error details in CSV output
 *    - Provides statistics on resource and domain loading success rates
 *
 *  ─────────────────────────────────────────────────────────────────────────── */

import dns from 'dns/promises';
import fs from 'fs';
import fetch from 'node-fetch';
import path from 'path';
import puppeteer from 'puppeteer-core';

// ── Logging Helpers ─────────────────────────────────────────────────────────
function getTimestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// Network request-response logging (with timestamp)
function networkLog(message) {
  console.log(`[${getTimestamp()}] ${message}`);
}

// General logging (without timestamp)
function log(message) {
  console.log(message);
}

function error(message) {
  console.error(`[${getTimestamp()}] ${message}`);
}

// ── Proxy Statistics Helper ─────────────────────────────────────────────────
async function fetchProxyStats() {
  try {
    networkLog('Fetching QUIC proxy statistics...');
    const response = await fetch('http://localhost:9090/stats', {
      timeout: 5000 // 5 second timeout
    });
    
    if (!response.ok) {
      networkLog(`Proxy stats request failed: HTTP ${response.status}`);
      return null;
    }
    
    const stats = await response.json();
    networkLog(`Proxy stats retrieved: ${stats.total_opened_streams} streams, ${stats.total_redirects} redirects, ${stats.total_data_amount} bytes total, ${stats.total_migrated_data_amount} bytes migrated`);
    
    // Log DNS fallback status
    if (stats.dns_fallback_occurred !== undefined) {
      networkLog(`DNS Fallback: ${stats.dns_fallback_occurred ? 'YES' : 'NO'}`);
    }
    
    return {
      total_opened_streams: stats.total_opened_streams || 0,
      total_redirects: stats.total_redirects || 0,
      total_data_amount: stats.total_data_amount || 0,
      total_previous_data_amount: stats.total_previous_data_amount || 0,
      total_migrated_data_amount: stats.total_migrated_data_amount || 0,
      migration_success_rate: stats.total_data_amount > 0 ? 
        ((stats.total_migrated_data_amount / stats.total_data_amount) * 100).toFixed(2) : 0,
      timestamp: stats.timestamp || Date.now(),
      dns_fallback_occurred: stats.dns_fallback_occurred || false
    };
  } catch (err) {
    networkLog(`Failed to fetch proxy stats: ${err.message}`);
    return {
      total_opened_streams: 0,
      total_redirects: 0,
      total_data_amount: 0,
      total_previous_data_amount: 0,
      total_migrated_data_amount: 0,
      migration_success_rate: 0,
      timestamp: Date.now(),
      dns_fallback_occurred: false,
      error: err.message
    };
  }
}

// ── CLI flags ────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const argMap  = {};
args.forEach(arg => {
  const [k, v] = arg.split('=');
  if (k.startsWith('--')) argMap[k.slice(2)] = v === undefined ? true : v;
});

const targetUrl = argMap.url;
const useProxy  = argMap['use-proxy'] === true || argMap['use-proxy'] === 'true';
const csvFile   = argMap.csv || 'webpage_analysis_results.csv';
const tcpFallback = argMap['tcp-fallback'] === true || argMap['tcp-fallback'] === 'true';
const useJapaneseDetection = argMap.jp === true || argMap.jp === 'true';
const proxyHost = 'http://localhost:4433';

if (!targetUrl) {
  error('Missing required --url argument.');
  error('Usage: node compare_enhanced.js --url=example.com [--use-proxy] [--tcp-fallback] [--jp] [--csv=file.csv]');
  process.exit(1);
}

// ── Accumulators ─────────────────────────────────────────────────────────────
let totalBytes    = 0;
let mainStatus    = null;
let mainHeaders   = {};
let failedResources = [];
let requestedResources = [];
let succeededResources = new Set();
let pendingResources = new Map(); // Track pending requests
let loadEventFired = false; // Track when load event fires
let loadEventTime = null;
let geoBlockedResources = []; // Track geo-blocked resources
let geoBlockedDomains = new Set(); // Track domains with geo-restrictions

// Priority status code tracking (451 > 403 > 503 > 500)
let highestPriorityStatus = null;
const STATUS_PRIORITY = { 451: 4, 403: 3, 503: 2, 500: 1 };

// Track the first main document status code (including redirects like 301)
let firstMainDocumentStatus = null;

// Track if final result came from TCP fallback
let finalResultFromTCP = false;

// Helper function to update highest priority status code
function updatePriorityStatus(status) {
  const priority = STATUS_PRIORITY[status];
  if (priority) {
    const currentPriority = highestPriorityStatus ? STATUS_PRIORITY[highestPriorityStatus] : 0;
    if (priority > currentPriority) {
      highestPriorityStatus = status;
      networkLog(`🔥 Priority status updated: ${status} (priority: ${priority})`);
    }
  }
}

// Helper function to track the first main document status code
function trackFirstMainDocumentStatus(status, resourceType) {
  if (resourceType === 'document' && firstMainDocumentStatus === null) {
    firstMainDocumentStatus = status;
    networkLog(`📄 First main document status: ${status}`);
  }
}

// ── Enhanced tracking per domain ─────────────────────────────────────────────
let domainStats = new Map(); // Track detailed stats per domain
let domainToIP = new Map(); // Track IP addresses from CDP events

function initializeDomainStats(domain) {
  if (!domainStats.has(domain)) {
    domainStats.set(domain, {
      domain: domain,
      ip: null, // Will be extracted from Chromium's network activity
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      httpErrorRequests: 0, // Non-200 status codes
      connectionErrorRequests: 0, // net::ERR_ type errors
      loadBlockingRequests: 0, // Resources that block the load event
      nonLoadBlockingRequests: 0, // Resources that don't block the load event
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

// ── Helper: Extract IP from Chromium's response ─────────────────────────────
function extractIPFromResponse(response, domain) {
  try {
    // Handle special URL schemes that don't have network IPs
    if (domain === 'data-url' || domain === 'blob-url' || 
        domain === 'chrome-extension' || domain === 'chrome-internal') {
      return 'local-resource';
    }
    
    // Method 1: Try to get IP from response.remoteAddress() if available
    if (response.remoteAddress && response.remoteAddress().ip) {
      //log(`[IP-METHOD1] ${domain} -> ${response.remoteAddress().ip}`);
      return response.remoteAddress().ip;
    }
    
    // Method 2: Check if we already captured it via CDP
    if (domainToIP.has(domain)) {
      const ip = domainToIP.get(domain);
      //log(`[IP-METHOD2] ${domain} -> ${ip} (from CDP)`);
      return ip;
    }
    
    // Method 3: Alternative headers for server IP info
    const headers = response.headers();
    if (headers['x-served-by']) {
      const match = headers['x-served-by'].match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
      if (match) {
        //log(`[IP-METHOD3] ${domain} -> ${match[1]} (from x-served-by)`);
        return match[1];
      }
    }
    
    // Method 4: Check other common headers
    if (headers['cf-ray']) {
      // Cloudflare Ray ID might contain location info, but not IP
    }
    
    if (headers['server']) {
      // Some servers include IP info in server header
      const serverMatch = headers['server'].match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
      if (serverMatch) {
        //log(`[IP-METHOD4] ${domain} -> ${serverMatch[1]} (from server header)`);
        return serverMatch[1];
      }
    }
    
    //log(`[IP-UNKNOWN] ${domain} - no IP found via any method`);
    return null;
  } catch (err) {
    //log(`[IP-ERROR] ${domain} - ${err.message}`);
    return null;
  }
}

function updateDomainResourceType(domain, resourceType, status = 'requested', isLoadBlocking = false) {
  const stats = domainStats.get(domain);
  if (!stats.resourceTypes.has(resourceType)) {
    stats.resourceTypes.set(resourceType, {
      requested: 0,
      successful: 0,
      failed: 0,
      httpErrors: 0,
      connectionErrors: 0,
      loadBlocking: 0,
      nonLoadBlocking: 0
    });
  }
  const typeStats = stats.resourceTypes.get(resourceType);
  typeStats[status]++;
  
  // Track load-blocking vs non-load-blocking resources
  if (status === 'requested') {
    if (isLoadBlocking) {
      typeStats.loadBlocking++;
    } else {
      typeStats.nonLoadBlocking++;
    }
  }
  
  stats.lastActivity = Date.now();
}

// ── Helper: Determine if resource blocks load event ─────────────────────────
function isLoadBlockingResource(request) {
  // IMPORTANT: This function uses heuristics and is NOT 100% accurate!
  // Puppeteer/CDP doesn't provide a direct way to know if a resource blocks window.load
  // The only reliable method is timing analysis (see actuallyBlocking logic below)
  
  const resourceType = request.resourceType();
  const url = request.url();
  
  // Resources that LIKELY block the load event (educated guesses):
  switch (resourceType) {
    case 'document':
      // Main HTML document always blocks
      return true;
      
    case 'stylesheet':
      // Stylesheets in <head> usually block, but not always
      // Dynamic stylesheets don't block
      return true;
      
    case 'script':
      // WARNING: This is the most unreliable part!
      // We can't detect async/defer from CDP, only guess from URL patterns
      
      // Common patterns for NON-blocking scripts:
      if (url.includes('analytics') || url.includes('gtag') || url.includes('ga.js') ||
          url.includes('google-analytics') || url.includes('googletagmanager') ||
          url.includes('facebook.net') || url.includes('twitter.com') ||
          url.includes('ads') || url.includes('tracking') || url.includes('pixel') ||
          url.includes('doubleclick') || url.includes('googlesyndication') ||
          url.includes('adsystem') || url.includes('amazon-adsystem') ||
          url.includes('pubmatic') || url.includes('rubiconproject') ||
          url.includes('openx') || url.includes('adsense')) {
        return false; // Analytics/ads/tracking scripts are usually async
      }
      
      // Scripts from CDNs are often async
      if (url.includes('cdn.') || url.includes('cdnjs.') || url.includes('jsdelivr') ||
          url.includes('unpkg.') || url.includes('ajax.googleapis.com')) {
        return false;
      }
      
      // Scripts with patterns suggesting async loading
      if (url.includes('async') || url.includes('defer') || url.includes('lazy') ||
          url.includes('dynamic') || url.includes('widget') || url.includes('embed')) {
        return false;
      }
      
      // DEFAULT: Assume blocking (this is often wrong!)
      return true;
      
    case 'image':
      // Images in initial DOM usually block, but not always
      // Tracking pixels and lazy-loaded images don't block
      if (url.includes('generate_204') || url.includes('beacon') || 
          url.includes('pixel') || url.includes('tracking') ||
          url.includes('analytics') || url.includes('ads') ||
          url.includes('1x1') || url.includes('transparent')) {
        return false; // Tracking pixels don't block
      }
      
      // DEFAULT: Assume blocking (often wrong for modern sites)
      return true;
      
    case 'media':
      // Audio/video elements may or may not block
      return true;
      
    case 'font':
      // Fonts typically don't block the load event
      return false;
      
    case 'xhr':
    case 'fetch':
      // XHR and fetch requests NEVER block the load event
      return false;
      
    case 'ping':
      // Ping requests (navigator.sendBeacon) don't block
      return false;
      
    case 'other':
      // Includes preload, prefetch, service worker, etc.
      if (url.includes('preload') || url.includes('prefetch') || 
          url.includes('service-worker') || url.includes('sw.js') ||
          url.includes('beacon') || url.includes('analytics')) {
        return false;
      }
      return false;
      
    default:
      return false;
  }
}
async function getCountryFromDNS (hostname) {
  try {
    const { address } = await dns.lookup(hostname);
    const r   = await fetch(`https://ipwho.is/${address}`);
    const geo = await r.json();
    return geo && geo.success && geo.country_code
         ? { 
             country: geo.country_code, 
             countryName: geo.country || geo.country_code, 
             ip: address 
           }
         : { 
             country: 'unknown', 
             countryName: 'Unknown', 
             ip: address 
           };
  } catch {
    return { country: 'unknown', countryName: 'Unknown', ip: null };
  }
}

// ── Helper: Japanese-content detector ────────────────────────────────────────
async function detectJapaneseContent(page) {
  return await page.evaluate(() => {
    const txt  = document.body?.innerText || '';
    const hasJ = /[\u3040-\u30ff\u4e00-\u9faf]/.test(txt);

    const htmlLang  = (document.documentElement.lang || '').toLowerCase();
    const langIsJa  = htmlLang.startsWith('ja');

    const metaLangs = Array.from(
      document.querySelectorAll('meta[http-equiv="Content-Language"], meta[name="language"]')
    ).map(m => (m.content || '').toLowerCase())
     .filter(c => c.includes('ja'));

    return { hasJapaneseText: hasJ, isHtmlLangJapanese: langIsJa, metaLangs };
  });
}

// ── Helper: Comprehensive Language Detector ─────────────────────────────────
async function detectWebsiteLanguage(page) {
  return await page.evaluate(() => {
    // Get page text content
    const bodyText = document.body?.innerText || '';
    const title = document.title || '';
    const metaDescription = document.querySelector('meta[name="description"]')?.content || '';
    const fullText = `${title} ${metaDescription} ${bodyText}`.toLowerCase();
    
    // Get explicit language declarations
    const htmlLang = (document.documentElement.lang || '').toLowerCase();
    const metaLanguages = Array.from(
      document.querySelectorAll('meta[http-equiv="Content-Language"], meta[name="language"]')
    ).map(m => (m.content || '').toLowerCase());
    
    // Language detection patterns - Unicode ranges and common words
    const languagePatterns = {
      'English': {
        unicode: /[a-zA-Z]/,
        words: /\b(the|and|for|are|but|not|you|all|can|had|her|was|one|our|out|day|get|has|him|his|how|its|may|new|now|old|see|two|way|who|boy|did|man|men|put|say|she|too|use)\b/g,
        commonPhrases: /(about|after|again|against|before|being|below|between|during|further|having|other|since|through|under|until|while|would|could|should)/g
      },
      'Spanish': {
        unicode: /[a-záéíóúüñ]/i,
        words: /\b(que|con|una|por|para|más|como|pero|sus|hasta|desde|cuando|muy|sin|sobre|también|me|se|le|da|su|un|el|en|es|se|no|te|lo|le|da|mi|tu|él|yo|ha|he|si|ya|ti)\b/g,
        commonPhrases: /(porque|después|entonces|mientras|durante|aunque|todavía|siempre|ningún|algún)/g
      },
      'French': {
        unicode: /[a-zàâäçéèêëïîôùûüÿ]/i,
        words: /\b(que|les|des|est|son|une|sur|avec|tout|ses|était|être|avoir|lui|dans|ce|il|le|de|à|un|pour|pas|vous|par|sur|sont|sa|cette|au|se|ne|et|en|du|elle|la|mais|ou|si|nous|on|me|te|se)\b/g,
        commonPhrases: /(parce|après|pendant|depuis|jusqu|avant|toujours|jamais|beaucoup|encore)/g
      },
      'German': {
        unicode: /[a-zäöüß]/i,
        words: /\b(der|die|und|in|den|von|zu|das|mit|sich|des|auf|für|ist|im|dem|nicht|ein|eine|als|auch|es|an|werden|aus|er|hat|dass|sie|nach|wird|bei|einer|um|am|sind|noch|wie|einem|über|einen|so|zum|war|haben|nur|oder|aber|vor|zur|bis|unter|kann|du|sein|wenn|ich|mich|mir|dich|dir|uns|euch|ihnen|ihr|ihm|sie|ihn)\b/g,
        commonPhrases: /(weil|obwohl|während|nachdem|bevor|falls|damit|sodass)/g
      },
      'Italian': {
        unicode: /[a-zàéèíìîóòúù]/i,
        words: /\b(che|con|una|per|più|come|ma|suo|fino|da|quando|molto|senza|sopra|anche|me|se|le|gli|la|un|il|in|è|si|no|lo|mi|tu|lui|io|ha|ho|se|già|ti)\b/g,
        commonPhrases: /(perché|dopo|allora|mentre|durante|anche|ancora|sempre|nessun|qualche)/g
      },
      'Portuguese': {
        unicode: /[a-zàâãçéêíóôõú]/i,
        words: /\b(que|com|uma|por|para|mais|como|mas|seu|até|quando|muito|sem|sobre|também|me|se|lhe|da|um|o|em|é|se|não|te|lo|lhe|da|meu|teu|ele|eu|há|é|se|já|ti)\b/g,
        commonPhrases: /(porque|depois|então|enquanto|durante|embora|ainda|sempre|nenhum|algum)/g
      },
      'Russian': {
        unicode: /[а-яё]/i,
        words: /\b(что|это|как|так|все|она|эта|тот|они|мой|наш|для|его|при|был|том|два|где|там|чем|них|быть|есть|она|оно|мне|нас|вас|них|его|её|их|себя|тебя|меня|нами|вами|ними|мной|тобой|собой)\b/g,
        commonPhrases: /(потому|после|тогда|пока|пока|хотя|всегда|никогда|много|ещё)/g
      },
      'Chinese': {
        unicode: /[\u4e00-\u9fff]/,
        words: /(的|了|是|在|有|我|他|这|个|们|你|来|不|到|一|上|也|为|就|学|生|会|可|以|要|对|没|说|她|好|都|和|很|给|用|过|因|请|让|从|想|实|现|理|明|白|知|道|看|见|听|到)/g,
        commonPhrases: /(因为|所以|但是|然后|如果|虽然|然而|或者|而且|不过)/g
      },
      'Japanese': {
        unicode: /[\u3040-\u30ff\u4e00-\u9faf]/,
        words: /(の|は|に|を|が|で|て|と|も|また|より|こそ|でも|だけ|など|でしょう|ます|です|れる|ある|いる|する|なる|できる|みる|くる|いく|もの|こと|ひと|なに|みず|あめ|つち|ひかり|かぜ|そら|うみ|やま|はな|とり|むし|さかな|くさ|き|のみ|もり|かわ|いけ|たに|まち|みせ|いえ|がっこう|びょういん|こうえん)/g,
        commonPhrases: /(ですから|それで|しかし|でも|もし|だから|けれども|または|そして|ところが)/g
      },
      'Korean': {
        unicode: /[\uac00-\ud7af]/,
        words: /(이|가|를|을|에서|와|과|도|의|는|은|로|으로|하고|하다|있다|없다|되다|보다|같다|다른|많다|작다|크다|좋다|나쁘다|새로운|오래된|빠른|느린|높은|낮은)/g,
        commonPhrases: /(그래서|하지만|그러나|만약|왜냐하면|그러므로|또는|그리고|하지만)/g
      },
      'Arabic': {
        unicode: /[\u0600-\u06ff]/,
        words: /(في|من|إلى|على|هذا|هذه|ذلك|تلك|كان|كانت|ليس|ليست|أن|أنه|أنها|التي|الذي|الذين|اللاتي|اللواتي|وال|أو|إن|كل|بعد|قبل|عند|عندما|حين|حيث|كيف|لماذا|ماذا|متى)/g,
        commonPhrases: /(لأن|ولكن|ومع|إذا|عندما|بينما|حتى|أو|لكن)/g
      },
      'Dutch': {
        unicode: /[a-zäöüéèêëïîôàáâåæøß]/i,
        words: /\b(het|van|een|in|op|te|dat|de|is|en|voor|met|als|zijn|er|worden|door|ze|niet|aan|hebben|over|uit|worden|kan|maar|worden|ook|na|zoals|tussen|onder|alleen|zonder)\b/g,
        commonPhrases: /(omdat|nadat|terwijl|hoewel|voordat|zodat|indien|ofwel|echter)/g
      },
      'Polish': {
        unicode: /[a-ząćęłńóśźż]/i,
        words: /\b(że|się|nie|na|do|jest|będzie|ma|ale|jak|tak|być|czy|lub|oraz|gdy|już|jeszcze|bardzo|może|można|przez|pod|nad|między|przed|po|za|bez|dla|od|przy|we|ze|ze|co|kto|gdzie|kiedy|dlaczego)\b/g,
        commonPhrases: /(ponieważ|dlatego|jednak|jeśli|chociaż|podczas|zanim|żeby)/g
      },
      'Persian': {
        unicode: /[\u0600-\u06ff]/,
        words: /(و|های|که|در|از|به|را|ام|ان|یا|دو|آن|یا|از|یا|بر|تا|ما|این|با|یا|ان|یا|های|با|یا|اگر|که|پس|حتی|ولی|تا|که|چون|چرا|نبود|بوده|است|آمده|ورده|بود)/g,
        commonPhrases: /(چون|چرا|ولی|اگر|تا|پس|حتی|زیرا|بنابراین|البته|همچنین|یعنی)/g
      }
    };
    
    // Calculate language scores
    const languageScores = {};
    const textLength = fullText.length;
    
    if (textLength < 50) {
      return {
        primaryLanguage: 'Unknown',
        confidence: 'Low',
        reason: 'Insufficient text content',
        declaredLanguage: htmlLang || metaLanguages[0] || 'none',
        textLength: textLength,
        allScores: {}
      };
    }
    
    // Check explicit language declarations first
    let explicitLanguage = null;
    if (htmlLang) {
      const langCode = htmlLang.split('-')[0];
      explicitLanguage = langCode;
    } else if (metaLanguages.length > 0) {
      const langCode = metaLanguages[0].split('-')[0];
      explicitLanguage = langCode;
    }
    
    // Score each language
    Object.entries(languagePatterns).forEach(([language, patterns]) => {
      let score = 0;
      
      // Unicode character presence (base score)
      const unicodeMatches = fullText.match(patterns.unicode) || [];
      const unicodeScore = Math.min(unicodeMatches.length / textLength, 0.3) * 100;
      
      // Common words frequency
      const wordMatches = fullText.match(patterns.words) || [];
      const wordScore = Math.min(wordMatches.length / (textLength / 100), 0.4) * 100;
      
      // Common phrases presence  
      const phraseMatches = fullText.match(patterns.commonPhrases) || [];
      const phraseScore = Math.min(phraseMatches.length / (textLength / 200), 0.3) * 100;
      
      score = unicodeScore + wordScore + phraseScore;
      
      // Boost score if language matches explicit declaration
      if (explicitLanguage) {
        const langMap = {
          'en': 'English', 'es': 'Spanish', 'fr': 'French', 'de': 'German',
          'it': 'Italian', 'pt': 'Portuguese', 'ru': 'Russian', 'zh': 'Chinese',
          'ja': 'Japanese', 'ko': 'Korean', 'ar': 'Arabic', 'nl': 'Dutch',
          'pl': 'Polish', 'et': 'Estonian', 'da': 'Danish', 'sv': 'Swedish',
          'no': 'Norwegian', 'fi': 'Finnish', 'cs': 'Czech', 'sk': 'Slovak',
          'hu': 'Hungarian', 'ro': 'Romanian', 'bg': 'Bulgarian', 'hr': 'Croatian',
          'sl': 'Slovenian', 'lt': 'Lithuanian', 'lv': 'Latvian', 'el': 'Greek',
          'tr': 'Turkish', 'he': 'Hebrew', 'th': 'Thai', 'vi': 'Vietnamese',
          'hi': 'Hindi', 'bn': 'Bengali', 'ur': 'Urdu', 'fa': 'Persian',
          'ms': 'Malay', 'id': 'Indonesian', 'tl': 'Filipino', 'sw': 'Swahili'
        };
        if (langMap[explicitLanguage] === language) {
          score *= 1.5; //
        }
      }
      
      languageScores[language] = {
        total: Math.round(score * 10) / 10,
        unicode: Math.round(unicodeScore * 10) / 10,
        words: Math.round(wordScore * 10) / 10,
        phrases: Math.round(phraseScore * 10) / 10,
        matches: {
          unicode: unicodeMatches.length,
          words: wordMatches.length,
          phrases: phraseMatches.length
        }
      };
    });
    
    // Find the language with highest score
    const sortedLanguages = Object.entries(languageScores)
      .sort((a, b) => b[1].total - a[1].total);
    
    if (sortedLanguages.length === 0) {
      return {
        primaryLanguage: 'Unknown',
        confidence: 'Low',
        reason: 'No language patterns detected',
        declaredLanguage: explicitLanguage || 'none',
        textLength: textLength,
        allScores: languageScores
      };
    }
    
    const [topLanguage, topScore] = sortedLanguages[0];
    const [secondLanguage, secondScore] = sortedLanguages[1] || ['', { total: 0 }];
    
    // Determine confidence level
    let confidence = 'Low';
    let reason = '';
    
    if (topScore.total >= 40) {
      if (topScore.total - secondScore.total >= 15) {
        confidence = 'High';
        reason = 'Strong language patterns with clear distinction';
      } else {
        confidence = 'Medium';
        reason = 'Good language patterns but some ambiguity';
      }
    } else if (topScore.total >= 20) {
      confidence = 'Medium';
      reason = 'Moderate language patterns detected';
    } else if (topScore.total >= 5) {
      confidence = 'Low';
      reason = 'Weak language patterns detected';
    } else {
      confidence = 'Very Low';
      reason = 'Minimal language patterns detected';
    }
    
    // Check for mixed content
    const significantLanguages = sortedLanguages
      .filter(([_, score]) => score.total >= 10)
      .slice(0, 3);
    
    // Fallback: If content detection has very low confidence and HTML lang is declared,
    // trust the HTML lang attribute instead of unreliable content detection
    let finalPrimaryLanguage = topLanguage;
    let finalConfidence = confidence;
    let finalReason = reason;
    
    if ((confidence === 'Very Low' || confidence === 'Low') && topScore.total < 15 && explicitLanguage) {
      const langMap = {
        'en': 'English', 'es': 'Spanish', 'fr': 'French', 'de': 'German',
        'it': 'Italian', 'pt': 'Portuguese', 'ru': 'Russian', 'zh': 'Chinese',
        'ja': 'Japanese', 'ko': 'Korean', 'ar': 'Arabic', 'nl': 'Dutch',
        'pl': 'Polish', 'et': 'Estonian', 'da': 'Danish', 'sv': 'Swedish',
        'no': 'Norwegian', 'fi': 'Finnish', 'cs': 'Czech', 'sk': 'Slovak',
        'hu': 'Hungarian', 'ro': 'Romanian', 'bg': 'Bulgarian', 'hr': 'Croatian',
        'sl': 'Slovenian', 'lt': 'Lithuanian', 'lv': 'Latvian', 'el': 'Greek',
        'tr': 'Turkish', 'he': 'Hebrew', 'th': 'Thai', 'vi': 'Vietnamese',
        'hi': 'Hindi', 'bn': 'Bengali', 'ur': 'Urdu', 'fa': 'Persian',
        'ms': 'Malay', 'id': 'Indonesian', 'tl': 'Filipino', 'sw': 'Swahili'
      };
      
      if (langMap[explicitLanguage]) {
        finalPrimaryLanguage = langMap[explicitLanguage];
        finalConfidence = 'Medium';
        finalReason = `Fallback to HTML lang attribute (${explicitLanguage}) due to low content detection confidence`;
      } else {
        // Unknown language code - use the raw code
        finalPrimaryLanguage = explicitLanguage.toUpperCase();
        finalConfidence = 'Medium';
        finalReason = `Using HTML lang attribute (${explicitLanguage}) - language code not recognized`;
      }
    }
    
    return {
      primaryLanguage: finalPrimaryLanguage,
      confidence: finalConfidence,
      score: topScore.total,
      reason: finalReason,
      declaredLanguage: explicitLanguage || 'none',
      textLength: textLength,
      secondaryLanguages: significantLanguages.slice(1).map(([lang, score]) => ({
        language: lang,
        score: score.total
      })),
      allScores: languageScores,
      topLanguages: sortedLanguages.slice(0, 5).map(([lang, score]) => ({
        language: lang,
        score: score.total,
        breakdown: {
          unicode: score.unicode,
          words: score.words,
          phrases: score.phrases
        }
      }))
    };
  });
}

// ── Helper: Detect TCP RST and connection failures ──────────────────────────
function isConnectionReset(errorMessage) {
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

// ── Helper: Detect if request was aborted (not necessarily an error) ─────────
function isRequestAborted(errorMessage) {
  const abortedPatterns = [
    /net::err_aborted/i,
    /net::err_blocked_by_client/i,
    /net::err_blocked_by_response/i
  ];
  return abortedPatterns.some(pattern => pattern.test(errorMessage));
}

// ── Helper: Detect geo-restriction keywords in content (multilingual) ──────
async function detectGeoRestrictionInContent(response) {
  try {
    // Only check text-based content to avoid binary data
    const contentType = response.headers()['content-type'] || '';
    if (!contentType.includes('text/') && !contentType.includes('application/json') && 
        !contentType.includes('application/javascript') && !contentType.includes('application/xml')) {
      return { restricted: false, reason: null };
    }
    
    // Get response content (with size limit to avoid memory issues)
    const contentLength = parseInt(response.headers()['content-length'] || '0', 10);
    if (contentLength > 500000) { // Skip very large responses (>500KB)
      return { restricted: false, reason: 'Content too large to analyze' };
    }
    
    let content = '';
    try {
      const buffer = await response.buffer();
      content = buffer.toString('utf8').toLowerCase();
    } catch (err) {
      return { restricted: false, reason: `Failed to read content: ${err.message}` };
    }
    
    // Comprehensive multilingual geo-restriction keywords (refined for specificity)
    const geoRestrictionKeywords = [
      // ═══ ENGLISH - HIGH CONFIDENCE GEO-RESTRICTION INDICATORS ═══
      'not available in your country', 'blocked in your country', 'not available in your region',
      'content not available in your country', 'video not available in your country', 
      'this content is not available in your country', 'this video is not available in your country',
      'geo-blocked', 'geo blocked', 'geoblocked', 'geo-restricted', 'geo restricted',
      'region blocked', 'country blocked', 'location blocked', 'territory restricted',
      'geographical restrictions', 'regional restrictions', 'territorial restrictions',
      'due to licensing restrictions', 'due to copyright restrictions', 
      'licensing restrictions in your country', 'copyright restrictions in your region',
      'unavailable in your location', 'unavailable in your region', 'unavailable in your country',
      'this content is blocked in your', 'content is not available in your',
      'video is blocked in your', 'not permitted in your country', 'not allowed in your country',
      'service not available in your country', 'feature not available in your region',
      
      // ═══ SPANISH ═══
      'no disponible en tu país', 'bloqueado en tu país', 'no disponible en tu región',
      'contenido no disponible en tu país', 'video no disponible en tu país',
      'este contenido no está disponible en tu país', 'geo-bloqueado',
      'bloqueado por región', 'bloqueado por país', 'bloqueado por ubicación',
      'restricciones territoriales', 'restricciones geográficas en tu país',
      'debido a restricciones de licencia', 'debido a derechos de autor',
      'no disponible en tu ubicación', 'no permitido en tu país',
      
      // ═══ FRENCH ═══
      'non disponible dans votre pays', 'bloqué dans votre pays', 'non disponible dans votre région',
      'contenu non disponible dans votre pays', 'vidéo non disponible dans votre pays',
      'ce contenu n\'est pas disponible dans votre pays', 'géo-bloqué',
      'bloqué par région', 'bloqué par pays', 'restrictions territoriales',
      'restrictions géographiques dans votre pays', 'en raison de restrictions de licence',
      'non disponible dans votre région', 'non autorisé dans votre pays',
      
      // ═══ FRENCH ═══
      'non disponible dans votre pays', 'bloqué dans votre pays', 'non disponible dans votre région',
      'contenu non disponible', 'vidéo non disponible', 'accès refusé', 'géo-bloqué',
      'bloqué par région', 'bloqué par pays', 'bloqué par localisation',
      'restrictions territoriales', 'restrictions de droits d\'auteur', 'contenu restreint',
      'non disponible dans votre localisation', 'non accessible', 'accès restreint',
      'en raison des droits d\'auteur', 'restrictions géographiques', 'restrictions régionales',
      'ce contenu est bloqué', 'le contenu n\'est pas disponible', 'la vidéo est bloquée',
      
      // ═══ GERMAN ═══
      'nicht verfügbar in ihrem land', 'blockiert in ihrem land', 'nicht verfügbar in ihrer region',
      'inhalt nicht verfügbar', 'video nicht verfügbar', 'zugriff verweigert', 'geo-blockiert',
      'regionsblockiert', 'länderblockiert', 'standortblockiert', 'territorial eingeschränkt',
      'urheberrechtsbeschränkungen', 'inhalt eingeschränkt', 'nicht verfügbar an ihrem standort',
      'nicht zugänglich', 'zugriff eingeschränkt', 'aufgrund von urheberrechten',
      'geografische beschränkungen', 'regionale beschränkungen', 'dieser inhalt ist blockiert',
      'der inhalt ist nicht verfügbar', 'das video ist blockiert',
      
      // ═══ ITALIAN ═══
      'non disponibile nel tuo paese', 'bloccato nel tuo paese', 'non disponibile nella tua regione',
      'contenuto non disponibile', 'video non disponibile', 'accesso negato', 'geo-bloccato',
      'bloccato per regione', 'bloccato per paese', 'bloccato per posizione',
      'restrizioni territoriali', 'restrizioni di copyright', 'contenuto limitato',
      'non disponibile nella tua posizione', 'non accessibile', 'accesso limitato',
      'a causa del copyright', 'restrizioni geografiche', 'restrizioni regionali',
      'questo contenuto è bloccato', 'il contenuto non è disponibile', 'il video è bloccato',
      
      // ═══ PORTUGUESE ═══
      'não disponível em seu país', 'bloqueado em seu país', 'não disponível em sua região',
      'conteúdo não disponível', 'vídeo não disponível', 'acesso negado', 'geo-bloqueado',
      'bloqueado por região', 'bloqueado por país', 'bloqueado por localização',
      'restrições territoriais', 'restrições de direitos autorais', 'conteúdo restrito',
      'não disponível em sua localização', 'não acessível', 'acesso restrito',
      'devido aos direitos autorais', 'restrições geográficas', 'restrições regionais',
      'este conteúdo está bloqueado', 'o conteúdo não está disponível', 'o vídeo está bloqueado',
      
      // ═══ JAPANESE ═══
      'お住まいの国では利用できません', 'お住まいの地域では利用できません', 
      'この国では視聴できません', 'この地域では視聴できません',
      'コンテンツが利用できません', 'ビデオが利用できません', 'アクセスが拒否されました',
      'ジオブロック', '地域制限', '国別制限', '著作権制限による',
      'ライセンス制限による', 'お住まいの地域では再生できません',
      'この動画はお住まいの国では', 'コンテンツ制限', '利用できません',
      'ブロックされています', '制限されています', '視聴制限',
      
      // ═══ KOREAN ═══
      '귀하의 국가', '귀하의 지역',
      '이 국가에서는 시청할 수 없습니다', '이 지역에서는 시청할 수 없습니다',
      '콘텐츠를 사용할 수 없습니다', '비디오를 사용할 수 없습니다',
      '지리적 차단', '지역 제한', '국가 제한', '저작권 제한',
      '라이선스 제한', '귀하의 지역에서는 재생할 수 없습니다',
      
      // ═══ CHINESE (SIMPLIFIED) ═══
      '在您的国家/地区不可用', '在您的地区不可用', '拒绝访问', '内容不可用', '视频不可用',
      '地理封锁', '地区限制', '国家限制', '版权限制', '内容限制', '访问限制',
      '地理限制', '此内容已被屏蔽', '内容不可用', '视频被屏蔽', '不可用', '被屏蔽',
      
      // ═══ CHINESE (TRADITIONAL) ═══
      '在您的國家/地區不可用', '在您的地區不可用', '拒絕存取', '內容不可用', '影片不可用',
      '地理封鎖', '地區限制', '國家限制', '版權限制', '內容限制', '存取限制',
      '地理限制', '此內容已被封鎖', '內容不可用', '影片被封鎖', '不可用', '被封鎖',
      
      // ═══ ARABIC ═══
      'غير متوفر في بلدك', 'محظور في بلدك', 'غير متوفر في منطقتك', 'المحتوى غير متوفر',
      'الفيديو غير متوفر', 'تم رفض الوصول', 'محظور جغرافياً', 'قيود إقليمية',
      'قيود الدولة', 'قيود حقوق الطبع والنشر', 'محتوى مقيد', 'وصول مقيد',
      'قيود جغرافية', 'هذا المحتوى محظور', 'المحتوى غير متاح', 'الفيديو محظور',
      
      // ═══ RUSSIAN ═══
      'недоступно в вашей стране', 'заблокировано в вашей стране', 'недоступно в вашем регионе',
      'контент недоступен', 'видео недоступно', 'доступ запрещен', 'гео-блокировка',
      'региональная блокировка', 'блокировка по стране', 'территориальные ограничения',
      'ограничения авторского права', 'ограниченный контент', 'ограниченный доступ',
      'географические ограничения', 'этот контент заблокирован', 'контент недоступен',
      'видео заблокировано', 'недоступно', 'заблокировано',
      
      // ═══ DUTCH ═══
      'niet beschikbaar in uw land', 'geblokkeerd in uw land', 'niet beschikbaar in uw regio',
      'inhoud niet beschikbaar', 'video niet beschikbaar', 'toegang geweigerd', 'geo-geblokkeerd',
      'regio geblokkeerd', 'land geblokkeerd', 'territoriale beperkingen', 'auteursrechtbeperkingen',
      'beperkte inhoud', 'beperkte toegang', 'geografische beperkingen', 'deze inhoud is geblokkeerd',
      'de inhoud is niet beschikbaar', 'de video is geblokkeerd',
      
      // ═══ POLISH ═══
      'niedostępne w twoim kraju', 'zablokowane w twoim kraju', 'niedostępne w twoim regionie',
      'treść niedostępna', 'wideo niedostępne', 'dostęp zabroniony', 'geo-blokada',
      'blokada regionalna', 'blokada krajowa', 'ograniczenia terytorialne', 'ograniczenia praw autorskich',
      'ograniczona treść', 'ograniczony dostęp', 'ograniczenia geograficzne',
      'ta treść jest zablokowana', 'treść nie jest dostępna', 'wideo jest zablokowane',

      
      // ═══ SPECIFIC ERROR PATTERNS ═══
      'geo_restricted', 'geo_blocked', 'location_blocked', 'region_restricted',
      'territory_restricted', 'country_restricted', 'access_restricted_by_location',
      'content_restricted_in_region', 'service_unavailable_in_country',
      'licensing_restricted', 'copyright_restricted', 'broadcast_restricted',
      'not_available_in_your_region', 'blocked_in_your_location',
      
      // ═══ HTTP STATUS AND LEGAL PATTERNS ═══
      'error 451', 'http 451', 'legal block', 'compliance block', 'legal restriction',
      'dmca takedown', 'copyright takedown', 'content removed due to',
      'geo-fence', 'geo-fencing', 'ip address blocked', 'ip range blocked',
      'country restriction active', 'regional restriction active', 'territorial license restriction',
      'broadcast rights restriction', 'distribution rights unavailable', 'streaming rights restricted',
      'not authorized in your country', 'unauthorized in your region', 
      'forbidden in your location', 'blacklisted region', 'restricted territory'
    ];
    
    // Check for keyword matches
    const foundKeywords = [];
    for (const keyword of geoRestrictionKeywords) {
      if (content.includes(keyword)) {
        foundKeywords.push(keyword);
      }
    }
    
    if (foundKeywords.length > 0) {
      // Determine severity based on keyword specificity
      let severity = 'Medium';
      const highConfidenceKeywords = [
        'not available in your country', 'blocked in your country', 'geo-blocked', 'geo blocked',
        'geographical restrictions', 'regional restrictions', 'copyright restrictions',
        'お住まいの国では利用できません', '귀하의 국가에서는 사용할 수 없습니다', '在您的国家/地区不可用',
        'غير متوفر في بلدك', 'недоступно в вашей стране', 'non disponible dans votre pays',
        'nicht verfügbar in ihrem land', 'non disponibile nel tuo paese', 'não disponível em seu país'
      ];
      
      if (foundKeywords.some(keyword => highConfidenceKeywords.includes(keyword))) {
        severity = 'High';
      }
      
      const uniqueKeywords = [...new Set(foundKeywords)];
      const keywordList = uniqueKeywords.length > 3 
        ? `${uniqueKeywords.slice(0, 3).join(', ')} (and ${uniqueKeywords.length - 3} more)`
        : uniqueKeywords.join(', ');
      
      return {
        restricted: true,
        reason: `Content contains geo-restriction keywords: ${keywordList}`,
        severity: severity,
        type: 'content_keywords',
        keywordCount: foundKeywords.length,
        uniqueKeywords: uniqueKeywords.length,
        detectedKeywords: uniqueKeywords
      };
    }
    
    return { restricted: false, reason: null };
    
  } catch (err) {
    return { 
      restricted: false, 
      reason: `Content analysis failed: ${err.message}` 
    };
  }
}

// ── Helper: Detect geo-restricted responses ─────────────────────────────────
async function isGeoRestrictedResponse(response, request) {
  const status = response.status();
  const headers = response.headers();
  const url = request.url();
  const resourceType = request.resourceType();
  const domain = new URL(url).hostname;
  
  // ═══ GENERAL GEO-RESTRICTION DETECTION ═══
  
  // 1. Direct geo-restriction status codes
  if (status === 403) {
    // Check common geo-blocking headers
    if (headers['x-geo-block'] || headers['x-country-block'] || 
        headers['x-region-block'] || headers['cf-geo-blocked']) {
      return { restricted: true, reason: `HTTP ${status} with geo-blocking headers`, severity: 'High', type: 'header_based' };
    }
    
    // Check server header for geo-blocking services
    const server = headers['server'] || '';
    if (server.includes('cloudflare') || server.includes('akamai') || 
        server.includes('fastly') || server.includes('maxcdn')) {
      return { restricted: true, reason: `HTTP ${status} from CDN (likely geo-blocked)`, severity: 'Medium', type: 'cdn_blocking' };
    }
    
    return { restricted: true, reason: `HTTP ${status} (potential geo-restriction)`, severity: 'Medium', type: 'status_code' };
  }
  
  // 2. Legal/compliance blocking
  if (status === 451) {
    return { restricted: true, reason: `HTTP ${status} (legal restriction)`, severity: 'High', type: 'legal_blocking' };
  }
  
  // 3. Redirect-based geo-blocking
  if (status >= 300 && status < 400) {
    const location = headers['location'] || '';
    if (location.includes('geo') || location.includes('region') || 
        location.includes('blocked') || location.includes('restricted') ||
        location.includes('unavailable') || location.includes('not-available')) {
      return { restricted: true, reason: `HTTP ${status} redirect to geo-block page`, severity: 'High', type: 'redirect_blocking' };
    }
  }
  
  // 4. Resource-specific patterns for geo-restrictions
  if (status === 200) {
    // Even 200 responses can indicate geo-restrictions:
    
    // Video/media resources that return tiny/placeholder content
    if (resourceType === 'media' || resourceType === 'image') {
      const contentLength = parseInt(headers['content-length'] || '0', 10);
      if (contentLength > 0 && contentLength < 1000) { // Suspiciously small media
        return { restricted: true, reason: `HTTP ${status} but suspiciously small ${resourceType} (${contentLength} bytes)`, severity: 'Low', type: 'content_size' };
      }
    }
    
    // JavaScript/CSS that might contain geo-restriction logic
    if (resourceType === 'script' || resourceType === 'stylesheet') {
      const contentType = headers['content-type'] || '';
      if (contentType.includes('text/html')) { // Script/CSS serving HTML (error page)
        return { restricted: true, reason: `HTTP ${status} but ${resourceType} serving HTML content`, severity: 'Medium', type: 'content_type' };
      }
    }
    
    // Check for geo-restriction indicators in content-type or headers
    if (headers['x-geo-restriction'] || headers['x-blocked-reason'] ||
        headers['x-content-blocked'] || headers['x-region-denied']) {
      return { restricted: true, reason: `HTTP ${status} with geo-restriction headers`, severity: 'High', type: 'header_based' };
    }
    
    // ═══ CONTENT-BASED GEO-RESTRICTION DETECTION ═══
    // Check for geo-restriction keywords in response content
    const contentAnalysis = await detectGeoRestrictionInContent(response);
    if (contentAnalysis.restricted) {
      return {
        restricted: true,
        reason: contentAnalysis.reason,
        severity: contentAnalysis.severity,
        type: contentAnalysis.type,
        keywordCount: contentAnalysis.keywordCount,
        uniqueKeywords: contentAnalysis.uniqueKeywords,
        detectedKeywords: contentAnalysis.detectedKeywords
      };
    }
  }
  
  // 5. CDN-specific geo-blocking patterns
  if (status >= 400) {
    // CloudFlare geo-blocking
    if (headers['cf-ray'] && (status === 403 || status === 429)) {
      return { restricted: true, reason: `HTTP ${status} from CloudFlare (geo-blocked)`, severity: 'High', type: 'cdn_blocking' };
    }
    
    // Akamai geo-blocking
    if (headers['x-akamai-request-id'] && status === 403) {
      return { restricted: true, reason: `HTTP ${status} from Akamai (geo-blocked)`, severity: 'High', type: 'cdn_blocking' };
    }
    
    // Generic CDN blocking for media content
    if ((resourceType === 'media' || resourceType === 'image' || resourceType === 'video') && 
        (domain.includes('cdn') || domain.includes('cloudfront') || domain.includes('fastly'))) {
      return { restricted: true, reason: `HTTP ${status} CDN blocking ${resourceType}`, severity: 'Medium', type: 'cdn_blocking' };
    }
  }
  
  return { restricted: false, reason: null };
}
// ── Helper: Format resource path for CSV output ────────────────────────────
function formatResourcePath(url, maxLength = 50) {
  try {
    const urlObj = new URL(url);
    const fullPath = urlObj.pathname + urlObj.search; // Include query parameters
    
    if (fullPath.length <= maxLength) {
      return fullPath;
    }
    
    // Path is longer than maxLength, try to extract extension
    const pathOnly = urlObj.pathname;
    const lastSlash = pathOnly.lastIndexOf('/');
    const fileName = lastSlash >= 0 ? pathOnly.substring(lastSlash + 1) : pathOnly;
    
    // Look for file extension
    const lastDot = fileName.lastIndexOf('.');
    if (lastDot > 0 && lastDot < fileName.length - 1) {
      // Has extension, return just the extension with some context
      const extension = fileName.substring(lastDot);
      const queryParams = urlObj.search;
      
      // If there are query parameters, include them if they fit
      if (queryParams && (extension + queryParams).length <= maxLength) {
        return extension + queryParams;
      } else {
        return extension;
      }
    } else {
      // No extension, truncate to maxLength
      return fullPath.substring(0, maxLength) + '...';
    }
  } catch {
    // If URL parsing fails, just return truncated URL
    return url.length > maxLength ? url.substring(0, maxLength) + '...' : url;
  }
}

function extractDomain(url) {
  try {
    // Handle special URL schemes
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

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {

  const launchOpts = {
  headless: true,
  executablePath: './chromium/chrome-headless-shell-linux64/chrome-headless-shell',
  args: [
    // ═══ BASIC BROWSER FLAGS ═══
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
    '--mute-audio',
    '--disable-gpu',
    '--enable-unsafe-swiftshader',
    '--ignore-certificate-errors',

    // ═══ STEALTH FLAGS TO AVOID BOT DETECTION ═══
    '--disable-blink-features=AutomationControlled',
    '--disable-web-security',
    '--disable-features=VizDisplayCompositor,VizServiceDisplay',
    '--disable-ipc-flooding-protection',
    '--no-first-run',
    '--no-service-autorun',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-component-extensions-with-background-pages',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=TranslateUI',
    '--disable-features=BlinkGenPropertyTrees',
    '--no-default-browser-check',
    '--disable-hang-monitor',
    '--disable-prompt-on-repost',
    '--disable-domain-reliability',

    // ═══ QUIC-SPECIFIC ═══
    '--origin-to-force-quic-on=*',

    // ═══ SECURITY/ENCRYPTION ═══
    // '--disable-features=PostQuantumKeyAgreement,EncryptedClientHello',

    // ═══ LOGGING ═══
    '--log-net-log=netlog.json',
    '--enable-logging',
    '--log-level=0',
    '--enable-network-service-logging',
    
    // ═══ COMPREHENSIVE CACHE DISABLING ═══
    '--disable-http-cache',
    '--disable-cache', 
    '--disable-application-cache',
    '--disable-offline-load-stale-cache',
    '--disable-gpu-sandbox',
    '--disable-dev-shm-usage',
    '--disk-cache-size=0',
    '--media-cache-size=0',
    '--aggressive-cache-discard',
    '--disable-extensions-http-throttling'
  ],
};

  if (useProxy) {
    launchOpts.args.push(`--proxy-server=${proxyHost}`);
    log(`Proxy enabled: ${proxyHost}`);
  } else {
    log('Proxy disabled');
  }

  let browser = await puppeteer.launch(launchOpts);
  let page    = await browser.newPage();

  // ═══ STEALTH CONFIGURATIONS TO AVOID BOT DETECTION ═══
  
  // Set realistic user agent
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  
  // Set realistic viewport
  await page.setViewport({ 
    width: 1920, 
    height: 1080,
    deviceScaleFactor: 1,
    hasTouch: false,
    isLandscape: true,
    isMobile: false
  });

  // Hide automation indicators and add realistic browser properties
  await page.evaluateOnNewDocument(() => {
    // Hide webdriver property
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
    
    // Mock plugins to appear like a real browser
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        {
          0: {type: "application/x-google-chrome-pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: Plugin},
          description: "Portable Document Format",
          filename: "internal-pdf-viewer",
          length: 1,
          name: "Chrome PDF Plugin"
        },
        {
          0: {type: "application/pdf", suffixes: "pdf", description: "", enabledPlugin: Plugin},
          description: "",
          filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai",
          length: 1,
          name: "Chrome PDF Viewer"
        },
        {
          0: {type: "application/x-nacl", suffixes: "", description: "Native Client Executable", enabledPlugin: Plugin},
          1: {type: "application/x-pnacl", suffixes: "", description: "Portable Native Client Executable", enabledPlugin: Plugin},
          description: "",
          filename: "internal-nacl-plugin",
          length: 2,
          name: "Native Client"
        }
      ],
    });
    
    // Mock languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });
    
    // Mock chrome property
    window.chrome = {
      runtime: {},
      loadTimes: function() {
        return {
          requestTime: Date.now() * 0.001,
          startLoadTime: Date.now() * 0.001,
          commitLoadTime: Date.now() * 0.001,
          finishDocumentLoadTime: Date.now() * 0.001,
          finishLoadTime: Date.now() * 0.001,
          firstPaintTime: Date.now() * 0.001,
          firstPaintAfterLoadTime: 0,
          navigationType: "Other",
          wasFetchedViaSpdy: false,
          wasNpnNegotiated: false,
          npnNegotiatedProtocol: "",
          wasAlternateProtocolAvailable: false,
          connectionInfo: "http/1.1"
        };
      },
      csi: function() {
        return {
          startE: Date.now(),
          onloadT: Date.now(),
          pageT: Date.now(),
          tran: 15
        };
      }
    };
    
    // Mock permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Reflect.get(Notification, 'permission') }) :
        originalQuery(parameters)
    );

    // Mock webGL vendor and renderer
    const getParameter = WebGLRenderingContext.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) {
        return 'Intel Inc.';
      }
      if (parameter === 37446) {
        return 'Intel Iris OpenGL Engine';
      }
      return getParameter(parameter);
    };

    // Override the `toDataURL` function of the `HTMLCanvasElement` to prevent canvas fingerprinting
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type) {
      if (type === 'image/png' && this.width === 16 && this.height === 16) {
        // Return a predefined image for small canvases used in fingerprinting
        return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABklEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
      }
      return originalToDataURL.apply(this, arguments);
    };

    // Mock battery API
    if (navigator.getBattery) {
      navigator.getBattery = () => Promise.resolve({
        charging: true,
        chargingTime: 0,
        dischargingTime: Infinity,
        level: 1,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => {}
      });
    }
  });

  // ═══ ADDITIONAL CACHE DISABLING AT PAGE LEVEL ═══
  await page.setCacheEnabled(false);

  // Enable network domain to get detailed connection info
  const client = await page.target().createCDPSession();
  await client.send('Network.enable');
  
  // Disable cache at CDP level as well
  await client.send('Network.setCacheDisabled', { cacheDisabled: true });
  
  // Track network responses with IP addresses from CDP
  client.on('Network.responseReceived', (params) => {
    const { response } = params;
    const domain = extractDomain(response.url);
    
    if (response.remoteIPAddress && !domainToIP.has(domain)) {
      domainToIP.set(domain, response.remoteIPAddress);
      const stats = domainStats.get(domain);
      if (stats) {
        stats.ip = response.remoteIPAddress;
        //log(`[IP-RESOLVED] ${domain} -> ${response.remoteIPAddress}`);
      }
    }
  });
  
  // Also track from network events
  client.on('Network.loadingFinished', (params) => {
    // Additional place to capture IP if missed in responseReceived
  });

  // ── Listeners ──────────────────────────────────────────────────────────────
  
  // Track when load event fires
  page.on('load', () => {
    loadEventFired = true;
    loadEventTime = Date.now();
    networkLog(`[LOAD-EVENT] Page load event fired at ${loadEventTime}`);
  });
  
  // Setup request/response listeners
  setupPageListeners();

  // ── CSV path setup ──────────────────────────────────────────────────────────
  const csvPath   = path.resolve(csvFile);

  // ── Helper function to setup page listeners ─────────────────────────────────
  function setupPageListeners() {
    page.on('request', req => {
      const url = req.url();
      const domain = extractDomain(url);
      const isLoadBlocking = isLoadBlockingResource(req);
      
      // RELIABILITY NOTE: Determining load-blocking behavior is complex
      // 
      // 1. isLoadBlockingResource() uses heuristics (URL patterns) - NOT 100% accurate
      // 2. The key insight: If load event already fired, resource can't block it
      // 3. This timing-based approach is more reliable than pure heuristics
      // 
      // Limitations:
      // - Can't detect async/defer attributes from CDP
      // - Can't distinguish initial DOM vs dynamically added resources
      // - URL-based heuristics may be wrong
      // 
      // More accurate load-blocking detection:
      // If the load event already fired, this resource definitely doesn't block it
      const actuallyBlocking = isLoadBlocking && !loadEventFired;
      
      // Initialize domain stats if first time seeing this domain
      const stats = initializeDomainStats(domain);
      stats.totalRequests++;
      
      // Track load-blocking vs non-load-blocking requests
      if (actuallyBlocking) {
        stats.loadBlockingRequests++;
      } else {
        stats.nonLoadBlockingRequests++;
      }
      
      updateDomainResourceType(domain, req.resourceType(), 'requested', actuallyBlocking);
      
      // Record full resource information
      const resourceInfo = {
        url: url,
        domain: domain,
        resourceType: req.resourceType(),
        method: req.method(),
        isLoadBlocking: actuallyBlocking,
        requestedAfterLoad: loadEventFired
      };
      requestedResources.push(resourceInfo);
      
      // Track pending request
      pendingResources.set(url, {
        domain: domain,
        resourceType: req.resourceType(),
        method: req.method(),
        isLoadBlocking: actuallyBlocking,
        requestedAfterLoad: loadEventFired,
        startTime: Date.now()
      });
      
      // Extract resource name (path + query) and truncate if longer than 20 characters
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
      const timingInfo = loadEventFired ? '[AFTER-LOAD]' : '[BEFORE-LOAD]';
      networkLog(`[${req.resourceType().toUpperCase()}] ${timingInfo} ${req.method()} ${domain}${resourceName}`);
    });

    page.on('requestfailed', req => {
      const url = req.url();
      const domain = extractDomain(url);
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
      
      // Update domain stats for connection failure
      const stats = domainStats.get(domain);
      if (stats) {
        stats.failedRequests++;
        stats.connectionErrorRequests++;
        if (failure) {
          stats.errorMessages.add(failure.errorText);
        }
        updateDomainResourceType(domain, resourceType, 'failed');
        updateDomainResourceType(domain, resourceType, 'connectionErrors');
      }
      
      // Remove from pending requests
      pendingResources.delete(url);
      
      if (failure) {
        if (isRequestAborted(failure.errorText)) {
          const failedResource = {
            domain: domain,
            resourceType: resourceType,
            errorText: failure.errorText,
            method: req.method(),
            errorType: 'request_aborted'
          };
          failedResources.push(failedResource);
          networkLog(`[ABORTED] ${resourceType.toUpperCase()} ${domain} - ${failure.errorText}`);
        } else if (isConnectionReset(failure.errorText)) {
          const failedResource = {
            domain: domain,
            resourceType: resourceType,
            errorText: failure.errorText,
            method: req.method(),
            errorType: 'connection_reset'
          };
          failedResources.push(failedResource);
          networkLog(`[FAILED-RST] ${resourceType.toUpperCase()} ${domain} - ${failure.errorText}`);
        } else {
          const failedResource = {
            domain: domain,
            resourceType: resourceType,
            errorText: failure.errorText,
            method: req.method(),
            errorType: 'connection_error'
          };
          failedResources.push(failedResource);
          networkLog(`[FAILED] ${resourceType.toUpperCase()} ${domain} - ${failure.errorText}`);
        }
      }
    });

    page.on('response', async res => {
      const req = res.request();
      const url = req.url();
      const domain = extractDomain(url);
      const status = res.status();
      
      // ═══ TRACK FIRST MAIN DOCUMENT STATUS ═══
      trackFirstMainDocumentStatus(status, req.resourceType());
      
      // ═══ PRIORITY STATUS CODE TRACKING ═══
      updatePriorityStatus(status);
      
      // ═══ GEO-RESTRICTION DETECTION + NON-200 STATUS TRACKING ═══
      // Check for geo-restriction indicators AND track all non-200 responses
      const isGeoRestricted = await isGeoRestrictedResponse(res, req);
      
      // Calculate response size first (needed for tracking)
      let len = 0;
      if (res.headers()['content-length']) {
        len = parseInt(res.headers()['content-length'], 10);
      }
      if (!len) {
        try { len = (await res.buffer()).length; } catch { len = 0; }
      }
      
      // Track ALL non-200 responses (not just traditional geo-restrictions)
      if (status !== 200 || isGeoRestricted.restricted) {
        const logType = isGeoRestricted.restricted ? '[GEO-BLOCKED]' : '[NON-200]';
        const reason = isGeoRestricted.restricted ? isGeoRestricted.reason : `HTTP ${status}`;
        log(`${logType} ${req.resourceType().toUpperCase()} ${domain} - ${reason}`);
        
        // Track non-200 response or geo-blocked resource with actual size
        const blockedResource = {
          domain: domain,
          resourceType: req.resourceType(),
          status: status,
          reason: reason,
          url: url,
          method: req.method(),
          errorType: isGeoRestricted.restricted ? 'geo_restriction' : 'http_non_200',
          size: len,
          keywordCount: isGeoRestricted.keywordCount || 0,
          uniqueKeywords: isGeoRestricted.uniqueKeywords || 0,
          detectedKeywords: isGeoRestricted.detectedKeywords || []
        };
        geoBlockedResources.push(blockedResource);
        geoBlockedDomains.add(domain);
      }
      
      // Remove from pending requests
      pendingResources.delete(url);
      
      // Extract IP address from Chromium's actual connection
      const ip = extractIPFromResponse(res, domain);
      
      // Update domain stats
      const stats = domainStats.get(domain);
      if (stats) {
        // Store the actual IP used by Chromium for this domain
        if (ip && !stats.ip) {
          stats.ip = ip;
        }
        
        // Track status code distribution
        const statusKey = `${Math.floor(status / 100)}xx`;
        stats.statusCodes.set(statusKey, (stats.statusCodes.get(statusKey) || 0) + 1);
        stats.statusCodes.set(status.toString(), (stats.statusCodes.get(status.toString()) || 0) + 1);
        
        // Treat 2xx and 3xx (redirects) as successful
        if (status >= 200 && status < 400) {
          stats.successfulRequests++;
          updateDomainResourceType(domain, req.resourceType(), 'successful');
          succeededResources.add(domain);
          
          // Find the corresponding resource info to log all successful resources
          const resourceInfo = requestedResources.find(r => r.url === url);
          
          // Log all successful resources
          if (resourceInfo) {
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
            
            networkLog(`[${req.resourceType().toUpperCase()}] [SUCCESS] ${req.method()} ${domain}${resourceName} - HTTP ${status}`);
          }
          
          // Log redirects for information but don't treat as errors
          if (status >= 300 && status < 400) {
            networkLog(`[REDIRECT] ${req.resourceType().toUpperCase()} ${domain} - HTTP ${status}`);
          }
        } else {
          stats.failedRequests++;
          stats.httpErrorRequests++;
          updateDomainResourceType(domain, req.resourceType(), 'failed');
          updateDomainResourceType(domain, req.resourceType(), 'httpErrors');
          
          // Log HTTP errors (4xx, 5xx)
          const failedResource = {
            domain: domain,
            resourceType: req.resourceType(),
            errorText: `HTTP ${status}`,
            method: req.method(),
            errorType: 'http_error',
            statusCode: status
          };
          failedResources.push(failedResource);
          
          // Extract resource name for better logging
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
          
          networkLog(`[HTTP-ERROR] ${req.resourceType().toUpperCase()} ${domain}${resourceName} - HTTP ${status}`);
        }
      }

      if (req.frame() === page.mainFrame() && req.resourceType() === 'document') {
        mainStatus  = res.status();
        mainHeaders = res.headers();
      }

      totalBytes += isNaN(len) ? 0 : len;
      
      // Update domain byte count
      if (stats && !isNaN(len)) {
        stats.totalBytes += len;
      }
    });
  }

  // ── Retry logic for QUIC, navigation timeout, and non-200 status failures ──────────────────
  const MAX_RETRIES = 0
  const RETRY_DELAYS = [2000, 5000, 10000, 15000, 20000, 30000]; // Exponential backoff: 2s, 5s, 10s, 15s, 20s, 30s
  
  async function attemptPageLoad(attempt = 1, useTcp = false) {
    try {
      const protocolInfo = useTcp ? ' with TCP' : '';
      const attemptInfo = attempt > 1 ? ` (attempt ${attempt}/${MAX_RETRIES})` : '';
      networkLog(`Starting page load${attemptInfo}${protocolInfo}…`);
      
      // ═══ RECONFIGURE BROWSER FOR TCP IF NEEDED ═══
      if (useTcp) {
        // Close existing browser and create new one without QUIC
        await browser.close();
        
        // Remove QUIC forcing from launch options
        const tcpLaunchOpts = JSON.parse(JSON.stringify(launchOpts)); // Deep copy
        tcpLaunchOpts.args = tcpLaunchOpts.args.filter(arg => !arg.includes('origin-to-force-quic-on'));
        
        log('🔄 Switching to TCP protocol (removed QUIC forcing)');
        browser = await puppeteer.launch(tcpLaunchOpts);
        page = await browser.newPage();
        
        // Re-apply all browser configurations
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setViewport({ 
          width: 1920, 
          height: 1080,
          deviceScaleFactor: 1,
          hasTouch: false,
          isLandscape: true,
          isMobile: false
        });

        // Re-apply stealth configurations
        await page.evaluateOnNewDocument(() => {
          // Hide webdriver property
          Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
          });
          
          // Mock plugins to appear like a real browser
          Object.defineProperty(navigator, 'plugins', {
            get: () => [
              {
                0: {type: "application/x-google-chrome-pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: Plugin},
                description: "Portable Document Format",
                filename: "internal-pdf-viewer",
                length: 1,
                name: "Chrome PDF Plugin"
              },
              {
                0: {type: "application/pdf", suffixes: "pdf", description: "", enabledPlugin: Plugin},
                description: "",
                filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai",
                length: 1,
                name: "Chrome PDF Viewer"
              },
              {
                0: {type: "application/x-nacl", suffixes: "", description: "Native Client Executable", enabledPlugin: Plugin},
                1: {type: "application/x-pnacl", suffixes: "", description: "Portable Native Client Executable", enabledPlugin: Plugin},
                description: "",
                filename: "internal-nacl-plugin",
                length: 2,
                name: "Native Client"
              }
            ],
          });
          
          // Mock languages
          Object.defineProperty(navigator, 'languages', {
            get: () => ['en-US', 'en'],
          });
          
          // Mock chrome property
          window.chrome = {
            runtime: {},
            loadTimes: function() {
              return {
                requestTime: Date.now() * 0.001,
                startLoadTime: Date.now() * 0.001,
                commitLoadTime: Date.now() * 0.001,
                finishDocumentLoadTime: Date.now() * 0.001,
                finishLoadTime: Date.now() * 0.001,
                firstPaintTime: Date.now() * 0.001,
                firstPaintAfterLoadTime: 0,
                navigationType: "Other",
                wasFetchedViaSpdy: false,
                wasNpnNegotiated: false,
                npnNegotiatedProtocol: "",
                wasAlternateProtocolAvailable: false,
                connectionInfo: "http/1.1"
              };
            },
            csi: function() {
              return {
                startE: Date.now(),
                onloadT: Date.now(),
                pageT: Date.now(),
                tran: 15
              };
            }
          };
          
          // Mock permissions
          const originalQuery = window.navigator.permissions.query;
          window.navigator.permissions.query = (parameters) => (
            parameters.name === 'notifications' ?
              Promise.resolve({ state: Reflect.get(Notification, 'permission') }) :
              originalQuery(parameters)
          );

          // Mock webGL vendor and renderer
          const getParameter = WebGLRenderingContext.getParameter;
          WebGLRenderingContext.prototype.getParameter = function(parameter) {
            if (parameter === 37445) {
              return 'Intel Inc.';
            }
            if (parameter === 37446) {
              return 'Intel Iris OpenGL Engine';
            }
            return getParameter(parameter);
          };

          // Override the `toDataURL` function of the `HTMLCanvasElement` to prevent canvas fingerprinting
          const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
          HTMLCanvasElement.prototype.toDataURL = function(type) {
            if (type === 'image/png' && this.width === 16 && this.height === 16) {
              // Return a predefined image for small canvases used in fingerprinting
              return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABklEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
            }
            return originalToDataURL.apply(this, arguments);
          };

          // Mock battery API
          if (navigator.getBattery) {
            navigator.getBattery = () => Promise.resolve({
              charging: true,
              chargingTime: 0,
              dischargingTime: Infinity,
              level: 1,
              addEventListener: () => {},
              removeEventListener: () => {},
              dispatchEvent: () => {}
            });
          }
        });

        // Re-apply cache disabling
        await page.setCacheEnabled(false);

        // Re-enable network domain
        const client = await page.target().createCDPSession();
        await client.send('Network.enable');
        await client.send('Network.setCacheDisabled', { cacheDisabled: true });
        
        // Re-setup network tracking
        client.on('Network.responseReceived', (params) => {
          const { response } = params;
          const domain = extractDomain(response.url);
          
          if (response.remoteIPAddress && !domainToIP.has(domain)) {
            domainToIP.set(domain, response.remoteIPAddress);
            const stats = domainStats.get(domain);
            if (stats) {
              stats.ip = response.remoteIPAddress;
              //log(`[IP-RESOLVED] ${domain} -> ${response.remoteIPAddress}`);
            }
          }
        });

        // Re-setup page event listeners
        page.on('load', () => {
          loadEventFired = true;
          loadEventTime = Date.now();
          networkLog(`[LOAD-EVENT] Page load event fired at ${loadEventTime}`);
        });
        
        // Re-setup request/response listeners (reusing the same logic)
        setupPageListeners();
      }
      
      // ═══ SET REALISTIC HTTP HEADERS ═══
      await page.setExtraHTTPHeaders({
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        // 'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-CH-UA': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'Sec-CH-UA-Mobile': '?0',
        'Sec-CH-UA-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
      });
      
      const t0 = Date.now();
      
      // Progressive timeout that resets on network activity
      let lastActivityTime = Date.now();
      let timeoutHandle = null;
      let navigationCompleted = false;
      let timeoutReject = null;
      const INACTIVITY_TIMEOUT = 60000; // 1 second of no network activity

      // Monitor network responses to reset timeout
      const resetTimeout = () => {
        lastActivityTime = Date.now();
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        if (!navigationCompleted) {
          timeoutHandle = setTimeout(() => {
            if (!navigationCompleted && Date.now() - lastActivityTime >= INACTIVITY_TIMEOUT) {
              navigationCompleted = true;
              if (timeoutHandle) clearTimeout(timeoutHandle);
              page.off('response', resetTimeout);
              page.off('request', resetTimeout);
              if (timeoutReject) {
                timeoutReject(new Error(`Navigation timeout: No network activity for ${INACTIVITY_TIMEOUT}ms`));
              }
            }
          }, INACTIVITY_TIMEOUT);
        }
      };
      
      // Set up network monitoring
      page.on('response', resetTimeout);
      page.on('request', resetTimeout);
      
      // Start timeout monitoring
      resetTimeout();
      
      // Create a promise that rejects on timeout
      const timeoutPromise = new Promise((resolve, reject) => {
        timeoutReject = reject;
      });
      
      let response;
      try {
        // Race between navigation and timeout
        response = await Promise.race([
          page.goto(`https://${targetUrl}`, { 
            waitUntil: 'load',
            timeout: 60000  // Higher overall timeout, progressive timeout handles real timeouts
          }),
          timeoutPromise
        ]);
        navigationCompleted = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        
        // Clean up listeners
        page.off('response', resetTimeout);
        page.off('request', resetTimeout);
      } catch (error) {
        navigationCompleted = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        page.off('response', resetTimeout);
        page.off('request', resetTimeout);
        throw error;
      }
      
      // Check if main response status is not 200 and should retry (but not for TCP attempts)
      const status = response.status();
      if (status !== 200 && attempt < MAX_RETRIES && !useTcp) {
        // Track the highest priority status code even during retries
        updatePriorityStatus(status);
        
        log(`❌ Main page returned HTTP ${status} (non-200 status)`);
        log(`⏳ Retrying in ${RETRY_DELAYS[attempt - 1]/1000}s... (attempt ${attempt + 1}/${MAX_RETRIES})`);
        
        // Wait before retry with exponential backoff
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[attempt - 1]));
        
        // Reset accumulators for retry attempt
        totalBytes = 0;
        mainStatus = null;
        mainHeaders = {};
        failedResources.length = 0;
        requestedResources.length = 0;
        succeededResources.clear();
        pendingResources.clear();
        geoBlockedResources.length = 0;
        geoBlockedDomains.clear();
        domainStats.clear();
        domainToIP.clear();
        loadEventFired = false;
        loadEventTime = null;
        // Don't reset highestPriorityStatus - preserve across retries
        
        return await attemptPageLoad(attempt + 1);
      }
      // If max retries reached or TCP attempt with non-200, record the last result
      if (status !== 200 && (attempt === MAX_RETRIES || useTcp)) {
        const attemptType = useTcp ? 'TCP attempt' : `Max retries (${MAX_RETRIES})`;
        log(`❌ ${attemptType} - Recording result with HTTP ${status}.`);
        // Set mainStatus and mainHeaders for CSV output
        mainStatus = status;
        mainHeaders = response.headers();
        return { response, startTime: t0, success: false };
      }
      
      return { response, startTime: t0, success: true };
      
    } catch (err) {
      const isQuicError = (
        err.message.includes('QUIC_PROTOCOL_ERROR') ||
        err.message.includes('ERR_QUIC_PROTOCOL_ERROR') ||
        err.message.includes('net::ERR_QUIC_PROTOCOL_ERROR') ||
        err.message.includes('QUIC') && err.message.includes('protocol') && err.message.includes('error')
      );
      
      const isTimeoutError = (
        err.message.includes('Navigation timeout') ||
        err.message.includes('timeout') ||
        err.message.includes('TimeoutError')
      );
      
      const shouldRetry = (isQuicError || isTimeoutError) && attempt < MAX_RETRIES && !useTcp;
      
      if (shouldRetry) {
        const delay = RETRY_DELAYS[attempt - 1];
        const errorType = isQuicError ? 'QUIC Protocol Error' : 'Navigation Timeout';
        networkLog(`❌ ${errorType}: ${err.message}`);
        log(`⏳ Retrying in ${delay/1000}s... (attempt ${attempt + 1}/${MAX_RETRIES})`);
        
        // Wait before retry with exponential backoff
        await new Promise(resolve => setTimeout(resolve, delay));
        
        // Reset accumulators for retry attempt
        totalBytes = 0;
        mainStatus = null;
        mainHeaders = {};
        failedResources.length = 0;
        requestedResources.length = 0;
        succeededResources.clear();
        pendingResources.clear();
        geoBlockedResources.length = 0;
        geoBlockedDomains.clear();
        domainStats.clear();
        domainToIP.clear();
        loadEventFired = false;
        loadEventTime = null;
        // Don't reset highestPriorityStatus or firstMainDocumentStatus - preserve across retries
        
        return await attemptPageLoad(attempt + 1);
      } else {
        // Either non-retryable error or max retries exceeded
        // TCP fallback should ONLY happen for connection errors, not HTTP status codes
        const hasHttpStatusCode = highestPriorityStatus !== null;
        
        if (attempt >= MAX_RETRIES && (isQuicError || isTimeoutError) && !useTcp && !hasHttpStatusCode && tcpFallback) {
          const errorType = isQuicError ? 'QUIC' : 'timeout';
          networkLog(`❌ Max ${errorType} retries (${MAX_RETRIES}) exceeded with QUIC.`);
          log(`🔄 Attempting final fallback with TCP protocol...`);
          
          // Reset accumulators for TCP attempt
          totalBytes = 0;
          mainStatus = null;
          mainHeaders = {};
          failedResources.length = 0;
          requestedResources.length = 0;
          succeededResources.clear();
          pendingResources.clear();
          geoBlockedResources.length = 0;
          geoBlockedDomains.clear();
          domainStats.clear();
          domainToIP.clear();
          loadEventFired = false;
          loadEventTime = null;
          // Preserve highestPriorityStatus and firstMainDocumentStatus across TCP fallback
          
          // Mark that final result will come from TCP
          finalResultFromTCP = true;
          
          return await attemptPageLoad(1, true); // Single TCP attempt, no retries
        } else if (attempt >= MAX_RETRIES && (isQuicError || isTimeoutError) && !useTcp && !hasHttpStatusCode && !tcpFallback) {
          const errorType = isQuicError ? 'QUIC' : 'timeout';
          networkLog(`❌ Max ${errorType} retries (${MAX_RETRIES}) exceeded with QUIC. TCP fallback disabled.`);
        } else if (attempt >= MAX_RETRIES && hasHttpStatusCode) {
          // We got HTTP status codes via QUIC, so connection was successful - no TCP needed
          networkLog(`✅ QUIC connection successful (HTTP ${highestPriorityStatus}). No TCP fallback needed.`);
        } else if (attempt >= MAX_RETRIES && (isQuicError || isTimeoutError) && useTcp) {
          networkLog(`❌ TCP fallback failed. All retry options exhausted.`);
          throw err; // Re-throw after single TCP attempt fails
        } else if (!isQuicError && !isTimeoutError) {
          networkLog(`❌ Non-retryable error: ${err.message}`);
        }
        throw err; // Re-throw to be handled by outer catch
      }
    }
  }

  try {
    log(`🔧 TCP fallback: ${tcpFallback ? 'ENABLED' : 'DISABLED'}`);
    const { response, startTime } = await attemptPageLoad();

    if (mainStatus === null) {                    // fallback
      mainStatus  = response.status();
      mainHeaders = response.headers();
    }

    const baseLoadTime = ((Date.now() - startTime) / 1000);
    const country    = await getCountryFromDNS(targetUrl);

    // ── Add status and load time logging with timestamp ──────────────────────
    const protocol = useProxy ? '(proxy)' : '(direct)';
    networkLog(`${mainStatus} https://${targetUrl}, ${country.countryName || 'Unknown'} (${country.country || 'XX'}) ${protocol}`);
    
    // ── Fetch proxy statistics to check for DNS fallback ───────────────────
    let proxyStats = { total_opened_streams: 0, total_redirects: 0, total_data_amount: 0, total_migrated_data_amount: 0, migration_success_rate: '0%', dns_fallback_occurred: false };
    if (useProxy) {
      try {
        const fetchedStats = await fetchProxyStats();
        if (fetchedStats) {
          proxyStats = fetchedStats;
        } else {
          networkLog(`[WARNING] No proxy statistics found.`);
        }
      } catch (proxyErr) {
        networkLog(`[WARNING] Failed to fetch proxy statistics: ${proxyErr.message}`);
      }
    }
    
    // ── Adjust load time based on DNS fallback ─────────────────────────────
    let adjustedLoadTime = baseLoadTime;
    if (proxyStats.dns_fallback_occurred) {
      adjustedLoadTime = Math.max(0, baseLoadTime - 3); // Subtract 3 seconds, but don't go below 0
      networkLog(`DNS Fallback detected - Adjusting load time: ${baseLoadTime.toFixed(2)}s -> ${adjustedLoadTime.toFixed(2)}s (-3s)`);
    }
    const loadTime = adjustedLoadTime.toFixed(2);
    
    networkLog(`Load time: ${loadTime}s | Bytes: ${(totalBytes / 1024).toFixed(2)} KB`);

    // ═══ CLOUDFLARE CHALLENGE DETECTION ═══
    let cloudflareChallenge = '';
    let cloudflareDetected = 'No';
    
    // Check if main response was redirected to Cloudflare challenge
    const finalUrl = response.url();
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

    // log(`${mainStatus} ${response.url()}, ${country.country}`);
    // log(`Load time: ${loadTime}s | Bytes: ${(totalBytes/1024).toFixed(2)} KB`);


    // ── Analysis of failed resources ────────────────────────────────────────
    const totalRequested = requestedResources.length;
    const uniqueDomainsRequested = new Set(requestedResources.map(r => r.domain)).size;
    const totalSucceeded = succeededResources.size;
    const totalFailed = failedResources.length;
    const totalPending = pendingResources.size;
    const resetFailures = failedResources.filter(f => isConnectionReset(f.errorText));
    const httpErrorFailures = failedResources.filter(f => f.errorType === 'http_error');
    const abortedFailures = failedResources.filter(f => f.errorType === 'request_aborted');
    
    // Calculate load-blocking statistics
    const loadBlockingResources = Array.from(domainStats.values()).reduce((sum, stats) => sum + stats.loadBlockingRequests, 0);
    const nonLoadBlockingResources = Array.from(domainStats.values()).reduce((sum, stats) => sum + stats.nonLoadBlockingRequests, 0);
    
    // ── GEO-RESTRICTION ANALYSIS ─────────────────────────────────────────────
    const totalGeoBlocked = geoBlockedResources.length;
    const geoBlockedDomainsCount = geoBlockedDomains.size;
    const geoBlockingRatio = uniqueDomainsRequested > 0 ? (geoBlockedDomainsCount / uniqueDomainsRequested) : 0;
    
    // Analyze patterns in geo-blocked resources
    const geoBlockedByType = new Map();
    const geoBlockedByStatus = new Map();
    
    geoBlockedResources.forEach(resource => {
      // Count by resource type
      geoBlockedByType.set(resource.resourceType, (geoBlockedByType.get(resource.resourceType) || 0) + 1);
      
      // Count by status code
      geoBlockedByStatus.set(resource.status, (geoBlockedByStatus.get(resource.status) || 0) + 1);
    });
    
    // Check for complete domain blocking
    const completelyBlockedDomains = [];
    geoBlockedDomains.forEach(domain => {
      const domainStat = domainStats.get(domain);
      if (domainStat && domainStat.successfulRequests === 0 && domainStat.failedRequests > 0) {
        completelyBlockedDomains.push(domain);
      }
    });
    
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
        networkLog(`  [${info.resourceType.toUpperCase()}] ${timingInfo} ${info.domain}${resourceName} - pending ${waitTime}s`);
      });
    }
    
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
    log(`Load Event: ${loadBlockingResources} blocking, ${nonLoadBlockingResources} non-blocking`);
    log(`Domains: ${totalSucceeded}/${uniqueDomainsRequested} succeeded, ${failedDomains.size} failed, ${pendingDomains.size} pending`);
    log(`Failures: ${totalFailed} total (${httpErrorFailures.length} HTTP errors, ${resetFailures.length} connection errors, ${abortedFailures.length} aborted)`);
    log(`Pending: ${totalPending} resources still loading after page load event`);
    log(`Geo-restrictions: ${totalGeoBlocked} resources from ${geoBlockedDomainsCount} domains (${(geoBlockingRatio * 100).toFixed(1)}% of domains)`);
    log(`Non-200 responses: ${geoBlockedResources.filter(r => r.status !== 200).length} resources from ${new Set(geoBlockedResources.filter(r => r.status !== 200).map(r => r.domain)).size} domains`);
    
    // ── NON-200 STATUS CODE ANALYSIS ─────────────────────────────────────────
    const non200Resources = geoBlockedResources.filter(r => r.status !== 200);
    if (non200Resources.length > 0) {
      log(`\n=== NON-200 STATUS CODE ANALYSIS ===`);
      log(`Total non-200 resources: ${non200Resources.length}`);
      log(`Non-200 domains: ${new Set(non200Resources.map(r => r.domain)).size}/${uniqueDomainsRequested}`);
      
      // Analyze patterns in non-200 responses
      const non200ByStatus = new Map();
      const non200ByType = new Map();
      const non200ByCDN = new Map();
      
      non200Resources.forEach(resource => {
        // Count by status code
        non200ByStatus.set(resource.status, (non200ByStatus.get(resource.status) || 0) + 1);
        
        // Count by resource type
        non200ByType.set(resource.resourceType, (non200ByType.get(resource.resourceType) || 0) + 1);
      });
      
      // Show breakdown by status code
      if (non200ByStatus.size > 0) {
        const statusBreakdown = Array.from(non200ByStatus.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([status, count]) => `${status}:${count}`)
          .join(', ');
        log(`Status codes: ${statusBreakdown}`);
      }
      
      // Show breakdown by resource type
      if (non200ByType.size > 0) {
        const typeBreakdown = Array.from(non200ByType.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([type, count]) => `${type}:${count}`)
          .join(', ');
        log(`Resource types: ${typeBreakdown}`);
      }
      
      // Show first few non-200 resources for detail
      log(`\nDetailed non-200 resources:`);
      non200Resources.slice(0, 5).forEach(resource => {
        const severity = resource.status >= 400 && resource.status < 500 ? '🟡' : 
                        resource.status >= 500 ? '🔴' : '🟢';
        log(`  ${severity} ${resource.resourceType.toUpperCase()} ${resource.domain} - HTTP ${resource.status}`);
      });
      const totalShown = Math.min(5, non200Resources.length);
      if (non200Resources.length > totalShown) {
        log(`  ... and ${non200Resources.length - totalShown} more`);
      }
    }
    
    
    log(`\n=== DETAILED DOMAIN STATISTICS FOR LOAD ===`);
    
    // Sort domains by total requests (most active first)
    const sortedDomains = Array.from(domainStats.entries()).sort((a, b) => b[1].totalRequests - a[1].totalRequests);
    
    // First pass: domains with load-blocking resources
    const loadRelatedDomains = sortedDomains.filter(([domain, stats]) => stats.loadBlockingRequests > 0);
    
    loadRelatedDomains.forEach(([domain, stats]) => {
      const successRate = stats.totalRequests > 0 ? ((stats.successfulRequests / stats.totalRequests) * 100).toFixed(1) : '0';
      
      log(`\n${domain} (${stats.ip || 'unknown'}):`);
      log(`  Requests: ${stats.totalRequests} total, ${stats.successfulRequests} success, ${stats.failedRequests} failed (${successRate}% success rate)`);
      log(`  Load Event: ${stats.loadBlockingRequests} blocking, ${stats.nonLoadBlockingRequests} non-blocking`);
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
      
      // Show resource type breakdown with details - separate blocking and non-blocking
      if (stats.resourceTypes.size > 0) {
        // First show load-blocking resources
        const blockingResources = Array.from(stats.resourceTypes.entries())
          .filter(([type, counts]) => counts.loadBlocking > 0)
          .sort((a, b) => b[1].loadBlocking - a[1].loadBlocking)
          .map(([type, counts]) => {
            let typeStr = `${type}:${counts.loadBlocking}`;
            if (counts.failed > 0) {
              typeStr += ` (${counts.failed} failed)`;
            }
            return typeStr;
          })
          .join(', ');
        
        // Then show non-load-blocking resources
        const nonBlockingResources = Array.from(stats.resourceTypes.entries())
          .filter(([type, counts]) => counts.nonLoadBlocking > 0)
          .sort((a, b) => b[1].nonLoadBlocking - a[1].nonLoadBlocking)
          .map(([type, counts]) => {
            let typeStr = `${type}:${counts.nonLoadBlocking}`;
            if (counts.failed > 0) {
              typeStr += ` (${counts.failed} failed)`;
            }
            return typeStr;
          })
          .join(', ');
        
        if (blockingResources) {
          log(`  Load-blocking resources: ${blockingResources}`);
        }
        if (nonBlockingResources) {
          log(`  Non-load-blocking resources: ${nonBlockingResources}`);
        }
        
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
    
    log(`\n=== DETAILED DOMAIN STATISTICS NOT RELATED TO LOAD ===`);
    
    // Second pass: domains with only non-load-blocking resources
    const nonLoadRelatedDomains = sortedDomains.filter(([domain, stats]) => stats.loadBlockingRequests === 0);
    
    nonLoadRelatedDomains.forEach(([domain, stats]) => {
      const successRate = stats.totalRequests > 0 ? ((stats.successfulRequests / stats.totalRequests) * 100).toFixed(1) : '0';
      
      log(`\n${domain} (${stats.ip || 'unknown'}):`);
      log(`  Requests: ${stats.totalRequests} total, ${stats.successfulRequests} success, ${stats.failedRequests} failed (${successRate}% success rate)`);
      log(`  Load Event: ${stats.loadBlockingRequests} blocking, ${stats.nonLoadBlockingRequests} non-blocking`);
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
      
      // Show resource type breakdown with details - only non-blocking resources
      if (stats.resourceTypes.size > 0) {
        // Show non-load-blocking resources (these domains have no blocking resources)
        const nonBlockingResources = Array.from(stats.resourceTypes.entries())
          .filter(([type, counts]) => counts.nonLoadBlocking > 0)
          .sort((a, b) => b[1].nonLoadBlocking - a[1].nonLoadBlocking)
          .map(([type, counts]) => {
            let typeStr = `${type}:${counts.nonLoadBlocking}`;
            if (counts.failed > 0) {
              typeStr += ` (${counts.failed} failed)`;
            }
            return typeStr;
          })
          .join(', ');
        
        if (nonBlockingResources) {
          log(`  Non-load-blocking resources: ${nonBlockingResources}`);
        }
        
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
      log(`\n=== FAILED DOMAINS DETAIL ===`);
      failedDomains.forEach((info, domain) => {
        const errorList = Array.from(info.errors).join(', ');
        log(`${domain}:`);
        log(`  - ${info.count} resource${info.count > 1 ? 's' : ''} failed`);
        log(`  - ${info.httpErrors} HTTP errors, ${info.connectionErrors} connection errors`);
        log(`  - Errors: ${errorList}`);
      });
    }
    
    if (resetFailures.length > 0) {
      log(`\n=== TCP RST FAILURES ===`);
      log(`TCP RST failures: ${resetFailures.length}`);
      resetFailures.forEach(f => {
        log(`  - ${f.resourceType}: ${f.domain} - ${f.errorText}`);
      });
    }
    
    if (abortedFailures.length > 0) {
      log(`\n=== ABORTED REQUESTS ===`);
      log(`Aborted requests: ${abortedFailures.length} (usually browser optimization or ad blocking)`);
      abortedFailures.forEach(f => {
        log(`  - ${f.resourceType}: ${f.domain} - ${f.errorText}`);
      });
    }
    
    if (pendingDomains.size > 0) {
      log(`\n=== PENDING DOMAINS ===`);
      log(`Pending domains: ${pendingDomains.size} (resources still loading after page load event)`);
      log();
      pendingDomains.forEach((info, domain) => {
        const resourceTypes = Array.from(info.resourceTypes).join(', ');
        log(`  - ${domain}: ${info.count} resource${info.count > 1 ? 's' : ''} - ${resourceTypes}`);
      });
    }

    log(`${mainStatus} ${response.url()}, ${country.countryName} (${country.country})${cloudflareChallenge}`);
    log(`Load time: ${loadTime}s | Bytes: ${(totalBytes/1024).toFixed(2)} KB`);

    // ── LANGUAGE DETECTION ANALYSIS ─────────────────────────────────────────
    log(`\n=== LANGUAGE DETECTION ANALYSIS ===`);
    let languageResults;
    try {
      if (useJapaneseDetection) {
        // Use Japanese-specific content detection
        log(`Using Japanese content detection (--jp flag enabled)`);
        const japaneseResults = await detectJapaneseContent(page);
        
        // Also run full language detection to get the actual primary language
        const fullLanguageResults = await detectWebsiteLanguage(page);
        
        // Determine if content is Japanese based on the simple detection
        const isJapanese = japaneseResults.hasJapaneseText || japaneseResults.isHtmlLangJapanese || japaneseResults.metaLangs.length > 0;
        
        // Map Japanese detection results to standard language results format for CSV compatibility
        languageResults = {
          primaryLanguage: isJapanese ? 'Japanese' : 'Not Japanese',
          confidence: isJapanese ? 'High' : 'High',
          score: isJapanese ? 1 : 0,
          reason: isJapanese ? 'Japanese characters or language declaration detected' : 'No Japanese content detected',
          declaredLanguage: fullLanguageResults.primaryLanguage, // Use actual detected primary language
          textLength: fullLanguageResults.textLength
        };
        
        log(`Japanese Text Found: ${japaneseResults.hasJapaneseText ? 'Yes' : 'No'}`);
        log(`HTML Lang Japanese: ${japaneseResults.isHtmlLangJapanese ? 'Yes' : 'No'}`);
        log(`Meta Languages: ${japaneseResults.metaLangs.length > 0 ? japaneseResults.metaLangs.join(', ') : 'None'}`);
        log(`Final Result: ${languageResults.primaryLanguage}`);
        log(`Actual Primary Language: ${fullLanguageResults.primaryLanguage} (${fullLanguageResults.confidence} confidence)`);
        log(`Declared Language: ${languageResults.declaredLanguage}`);
        
      } else {
        // Use standard multi-language detection
        languageResults = await detectWebsiteLanguage(page);
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
        
        if (languageResults.topLanguages && languageResults.topLanguages.length > 1) {
          log(`\nTop Language Candidates:`);
          languageResults.topLanguages.slice(0, 3).forEach((lang, index) => {
            const ranking = ['🥇', '🥈', '🥉'][index] || '  ';
            log(`  ${ranking} ${lang.language}: ${lang.score} (unicode: ${lang.breakdown.unicode}, words: ${lang.breakdown.words}, phrases: ${lang.breakdown.phrases})`);
          });
        }
      }
    } catch (langErr) {
      log(`Language detection failed: ${langErr.message}`);
      languageResults = {
        primaryLanguage: 'Error',
        confidence: 'None',
        score: 0,
        reason: `Detection failed: ${langErr.message}`,
        declaredLanguage: 'unknown',
        textLength: 0
      };
    }

    // ── CSV output ──────────────────────────────────────────────────────────
    // Format: SNI, ip addr, ip country, main first status code, Primary Language, Declared Language, chrome_fail, total domains, not 200 domains, 403 responses, 451 responses, 500 responses, 503 responses, 403 domain names, 451 domain names, 500 domain names, 503 domain names, TCP return, cloudflare_challenge, total_opened_streams, total_redirects, total_data_amount, total_migrated_data_amount, migration_success_rate, load_time
    const header = 'SNI,ip addr,ip country,main first status code,Primary Language,Declared Language,chrome_fail,total domains,not 200 domains,403 responses,451 responses,500 responses,503 responses,403 domain names,451 domain names,500 domain names,503 domain names,TCP return,cloudflare_challenge,total_opened_streams,total_redirects,total_data_amount,total_migrated_data_amount,migration_success_rate,load_time\n';
    
    // Calculate domains with non-200 status codes and specific status code counts
    const non200Domains = new Set();
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
    
    // Process all non-200 responses (excluding main domain to avoid double counting)
    geoBlockedResources.forEach(resource => {
      if (resource.status !== 200) {
        // Only count sub-domains, not the main target domain
        // Check if this domain is different from the main target URL
        const isMainDomain = (resource.domain === targetUrl || 
                            resource.domain === `www.${targetUrl}` || 
                            `www.${resource.domain}` === targetUrl);
        
        if (!isMainDomain) {
          non200Domains.add(resource.domain);
          
          // Count specific status codes for sub-domains (responses from each domain) and collect domain names
          const statusStr = resource.status.toString();
          if (statusCounts.hasOwnProperty(statusStr)) {
            statusCounts[statusStr]++;
            // Add domain name if not already present
            if (!statusDomainNames[statusStr].includes(resource.domain)) {
              statusDomainNames[statusStr].push(resource.domain);
            }
          }
        }
      }
    });
    
    // Function to escape CSV fields that contain commas, quotes, or newlines
    function escapeCsvField(field) {
      if (field && (field.includes(',') || field.includes('"') || field.includes('\n'))) {
        return `"${field.replace(/"/g, '""')}"`;
      }
      return field || '';
    }
    
    // Format domain names for CSV (semicolon separated)
    const format403DomainNames = statusDomainNames['403'].map(domain => `${domain}/`).join('; ');
    const format451DomainNames = statusDomainNames['451'].map(domain => `${domain}/`).join('; ');
    const format500DomainNames = statusDomainNames['500'].map(domain => `${domain}/`).join('; ');
    const format503DomainNames = statusDomainNames['503'].map(domain => `${domain}/`).join('; ');
    
    // Format the row with the new format including chrome_fail and TCP return columns
    // SNI, ip addr, ip country, main first status code, Primary Language, Declared Language, chrome_fail, total domains, not 200 domains, 403 responses, 451 responses, 500 responses, 503 responses, 403 domain names, 451 domain names, 500 domain names, 503 domain names, TCP return, cloudflare_challenge, total_opened_streams, total_redirects, total_data_amount, total_migrated_data_amount, migration_success_rate, load_time
    const tcpResult = finalResultFromTCP ? 'TCP' : 'QUIC';
    
    
    const row = `${escapeCsvField(targetUrl)},${escapeCsvField(country.ip || '')},${escapeCsvField(country.countryName || 'Unknown')},${mainStatus},${escapeCsvField(languageResults.primaryLanguage)},${escapeCsvField(languageResults.declaredLanguage)},-,${uniqueDomainsRequested},${non200Domains.size},${statusCounts['403']},${statusCounts['451']},${statusCounts['500']},${statusCounts['503']},"${format403DomainNames}","${format451DomainNames}","${format500DomainNames}","${format503DomainNames}",${tcpResult},${cloudflareDetected},${proxyStats.total_opened_streams},${proxyStats.total_redirects},${proxyStats.total_data_amount},${proxyStats.total_migrated_data_amount},${proxyStats.migration_success_rate},${loadTime}\n`;

    if (!fs.existsSync(csvPath)) fs.writeFileSync(csvPath, header);
    fs.appendFileSync(csvPath, row);

  } catch (err) {
    // ═══ CLOUDFLARE CHALLENGE DETECTION IN ERRORS ═══
    let cloudflareChallenge = '';
    let cloudflareDetected = 'No';
    
    // Check if any of the failed resources were from Cloudflare challenges
    const challengeResources = requestedResources.filter(r => r.url.includes('challenges.cloudflare.com'));
    const challengeFailures = failedResources.filter(f => f.domain && f.domain.includes('challenges.cloudflare.com'));
    
    if (challengeResources.length > 0) {
      cloudflareChallenge = ' [CLOUDFLARE CHALLENGE DETECTED]';
      cloudflareDetected = 'Yes';
    } else if (challengeFailures.length > 0) {
      cloudflareChallenge = ' [CLOUDFLARE CHALLENGE IN FAILURES]';
      cloudflareDetected = 'Yes';
    }
    
    error(`Failed: ${err.message}${cloudflareChallenge}`);
    
    // If it's a navigation timeout, show pending resources
    if (err.message.includes('Navigation timeout') || err.message.includes('timeout')) {
      log('\n=== PENDING RESOURCES (likely causing timeout) ===');
      if (pendingResources.size > 0) {
        log(`${pendingResources.size} resources still pending:`);
        pendingResources.forEach((info, url) => {
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
      log('===================================================\n');
    }
    
    // Still write CSV data even on complete failure
    try {
      // Format the main error for the CSV with full Chrome error message
      let mainErrorForCsv = '';
      if (err.message.includes('net::ERR_')) {
        // Extract and preserve the full net::ERR_ code
        const match = err.message.match(/net::ERR_[A-Z_]+/);
        const fullErrorCode = match ? match[0] : err.message;
        mainErrorForCsv = `${targetUrl}(${fullErrorCode})`;
      } else if (err.message.includes('QUIC')) {
        // For QUIC errors, try to preserve more detail
        if (err.message.includes('QUIC_PROTOCOL_ERROR')) {
          mainErrorForCsv = `${targetUrl}(net::ERR_QUIC_PROTOCOL_ERROR)`;
        } else {
          mainErrorForCsv = `${targetUrl}(QUIC_ERROR)`;
        }
      } else if (err.message.includes('timeout')) {
        mainErrorForCsv = `${targetUrl}(NAVIGATION_TIMEOUT)`;
      } else {
        // For other errors, try to extract meaningful error info
        const cleanError = err.message.split('\n')[0].replace(/[^A-Z0-9_]/g, '_').toUpperCase();
        mainErrorForCsv = `${targetUrl}(${cleanError})`;
      }
      
      const header = 'SNI,ip addr,ip country,main first status code,Primary Language,Declared Language,chrome_fail,total domains,not 200 domains,403 responses,451 responses,500 responses,503 responses,403 domain names,451 domain names,500 domain names,503 domain names,TCP return,cloudflare_challenge\n';
      
      // Extract clean Chromium error for chrome_fail field
      let chromeErrorForCsv = '';
      if (err.message.includes('net::ERR_')) {
        // Extract the full net::ERR_ code
        const match = err.message.match(/net::ERR_[A-Z_]+/);
        chromeErrorForCsv = match ? match[0] : 'CHROMIUM_ERROR';
      } else if (err.message.includes('QUIC')) {
        chromeErrorForCsv = err.message.includes('QUIC_PROTOCOL_ERROR') ? 'net::ERR_QUIC_PROTOCOL_ERROR' : 'QUIC_ERROR';
      } else if (err.message.includes('timeout')) {
        chromeErrorForCsv = 'NAVIGATION_TIMEOUT';
      } else {
        // For other errors, clean up the message
        chromeErrorForCsv = err.message.split('\n')[0].replace(/[^A-Z0-9_]/g, '_').toUpperCase();
      }
      
      // Status code logic: Use first main document status if available, then highest priority status, otherwise use "-"
      const statusForCsv = firstMainDocumentStatus || highestPriorityStatus || '-';
      const ipForCsv = (firstMainDocumentStatus || highestPriorityStatus) ? 'BLOCKED' : 'ERROR';
      const countryForCsv = 'Unknown';
      
      log(`📊 Error case - First main status: ${firstMainDocumentStatus || 'None'}, Priority status: ${highestPriorityStatus || 'None'}, Chrome error: ${chromeErrorForCsv}`);
      log(`📊 CSV format - Status: ${statusForCsv}, Chrome fail: ${chromeErrorForCsv}`);
      
      const tcpResult = finalResultFromTCP ? 'TCP' : 'QUIC';
      const row = `${targetUrl},${ipForCsv},${countryForCsv},${statusForCsv},Error,unknown,${chromeErrorForCsv},-,-,-,-,-,-,"","","","",${tcpResult},${cloudflareDetected}\n`;

      if (!fs.existsSync(csvPath)) fs.writeFileSync(csvPath, header);
      fs.appendFileSync(csvPath, row);
    } catch (csvErr) {
      error('Failed to write CSV:', csvErr.message);
    }
  } finally {
    await browser.close();
  }
})();

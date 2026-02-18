/**
 * Constants and configuration values used throughout the scanner
 */

// Ad blocking and tracking keywords
export const AD_BLOCKING_KEYWORDS = [
  // Google Ads
  'googleads', 'googlesyndication', 'googleadservices', 'googletagmanager', 'googletagservices',
  'doubleclick', 'google-analytics', 'googleanalytics', 'googletag',
  
  // Facebook/Meta
  'facebook.com/tr', 'facebook.net', 'fbcdn.net', 'facebook.com/plugins',
  'connect.facebook', 'fbevents.js', 'fbq(',
  
  // Amazon
  'amazon-adsystem', 'assoc-amazon', 'amazontracking',
  
  // Microsoft
  'msads.net', 'microsoft.com/ads', 'bing.com/ads',
  
  // General tracking
  'analytics', 'tracking', 'tracker', 'metrics', 'telemetry',
  'stats', 'pixel', 'beacon', 'tag.', 'tags.',
  
  // Ad networks
  'adsystem', 'adservice', 'adserver', 'adserv', 'ads.', '/ads/', '_ads_',
  'advertising', 'advertisement', 'advert', 'adsense', 'adnxs',
  'adform', 'adsrvr', 'adtech', 'adnexus', 'adskeeper',
  'outbrain', 'taboola', 'criteo', 'pubmatic', 'rubiconproject',
  
  // Social widgets  
  'addthis', 'sharethis', 'disqus', 'livechat', 'zendesk',
  
  // Heat mapping & session recording
  'hotjar', 'fullstory', 'logrocket', 'smartlook', 'mouseflow',
  'crazyegg', 'clicktale', 'sessioncam',
  
  // A/B testing
  'optimizely', 'google-optimize', 'vwo.com', 'unbounce',
  
  // CDNs commonly used for ads
  'googlesyndication', 'googleadservices', 'gstatic.com/ads',
  
  // Specific ad-related paths
  '/gtag/', '/analytics/', '/tracking/', '/pixel/', '/beacon/',
  '/advertisement/', '/sponsored/', '/promo/'
];

// Status code priority for error handling
export const STATUS_PRIORITY = { 
  451: 4,  // Unavailable For Legal Reasons (highest priority)
  403: 3,  // Forbidden
  503: 2,  // Service Unavailable
  500: 1   // Internal Server Error (lowest priority)
};

// Retry configuration
export const RETRY_CONFIG = {
  MAX_RETRIES: 0,  // Currently disabled
  DELAYS: [2000, 5000, 10000, 15000, 20000, 30000], // Exponential backoff in ms
  INACTIVITY_TIMEOUT: 15000, // 60 seconds of no network activity
  NAVIGATION_TIMEOUT: 15000   // Overall navigation timeout
};

// Chrome configuration
export const CHROME_CONFIG = {
  VERSION: '140.0.7339.82',
  EXECUTABLE_PATH: './chromium/chrome-headless-shell-linux64/chrome-headless-shell',
  DOWNLOAD_URL: 'https://storage.googleapis.com/chrome-for-testing-public/140.0.7339.82/linux64/chrome-headless-shell-linux64.zip'
};

// Browser launch arguments.
export const BROWSER_ARGS = [
    // ═══ BASIC BROWSER FLAGS ═══
    '--no-sandbox',
    '--ignore-certificate-errors',
    '--disable-dev-shm-usage',
    '--remote-debugging-port=0',

    // ═══ QUIC-SPECIFIC ═══
    '--origin-to-force-quic-on=*',

    // ═══ SECURITY/ENCRYPTION Finally google and cloudflare is working  ═══
    '--disable-features=PostQuantumKyber',
];

// Default HTTP headers for realistic browsing
export const DEFAULT_HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
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
};

// Default user agent (referred from recent Chrome version)
export const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

// Default viewport
export const DEFAULT_VIEWPORT = {
  width: 1920,
  height: 1080,
  deviceScaleFactor: 1,
  hasTouch: false,
  isLandscape: true,
  isMobile: false
};

// Language detection patterns
export const LANGUAGE_PATTERNS = {
  HIRAGANA: /[\u3040-\u309f]/,
  KATAKANA: /[\u30a0-\u30ff]/,
  KANJI: /[\u4e00-\u9faf]/,
  JAPANESE_PUNCTUATION: /[\u3000-\u303f]/
};

// Proxy configuration
export const PROXY_CONFIG = {
  HOST: 'localhost',
  PORT: 4433,
  PROTOCOL: 'http',
  get URL() {
    return `${this.PROTOCOL}://${this.HOST}:${this.PORT}`;
  }
};

// Proxy stats/report configuration
export const PROXY_STATS_CONFIG = {
  HOST: 'localhost',
  PORT: 9090,
  PROTOCOL: 'http',
  ENDPOINT: '/stats',
  get URL() {
    return `${this.PROTOCOL}://${this.HOST}:${this.PORT}${this.ENDPOINT}`;
  }
};
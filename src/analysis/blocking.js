/**
 * Geo-blocking and CAPTCHA detection for web pages
 * Detects blocking indicators in HTML body content
 */

/**
 * Detect geo-blocking and CAPTCHA in page content
 * @param {Object} page - Puppeteer page object
 * @returns {Object} Detection results with geo-blocking and CAPTCHA status
 */
export async function detectBlockingIndicators(page) {
  try {
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 1000 });
  } catch (e) {
    console.log('Warning: Page readiness check failed for blocking detection, continuing...');
  }

  return await page.evaluate(() => {
    // Extract all visible text from the page body
    const bodyText = (document.body && document.body.innerText) || '';
    const bodyHTML = (document.body && document.body.innerHTML) || '';
    const fullText = bodyText.toLowerCase();
    const fullHTML = bodyHTML.toLowerCase();

    // ═══════════════════════════════════════════════════════════════
    // GEO-BLOCKING KEYWORD PATTERNS - Simple and obvious
    // ═══════════════════════════════════════════════════════════════
    const geoBlockingKeywords = [
      'geo location',
      'geo-location',
      'geolocation',
      'geo block',
      'geo-block',
      'geoblock',
      'geographic region',
      'geographic location',
      'geographical region',
      'geographical location',
      'blocked by geo',
      'blocked access to the site for certain geographic',
      'not available in your country',
      'not available in your region',
      'not available in your location',
      'unavailable in your country',
      'unavailable in your region',
      'restricted in your country',
      'restricted in your region',
      'access denied.*country',
      'access denied.*region',
      'access denied.*location',
      'region restriction',
      'country restriction',
      'location restriction',
      'regional restriction',
      'geographic restriction',
      'geographical restriction',
      'blocked.*geographic',
      'blocked.*country',
      'blocked.*region',
      'error 451',
      'http 451',
      '451 unavailable'
    ];

    // Check for geo-blocking keywords
    let geoBlockingDetected = false;
    let geoBlockingKeywordsFound = [];
    
    for (const keyword of geoBlockingKeywords) {
      if (fullText.includes(keyword.toLowerCase())) {
        geoBlockingDetected = true;
        geoBlockingKeywordsFound.push(keyword);
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // CAPTCHA KEYWORD PATTERNS - Simple and obvious
    // ═══════════════════════════════════════════════════════════════
    const captchaKeywords = [
      'captcha',
      'recaptcha',
      'hcaptcha',
      'h-captcha',
      're-captcha',
      'human verification',
      'verify you are human',
      'verify you\'re human',
      'prove you are human',
      'prove you\'re human',
      'are you human',
      'not a robot',
      'not a bot',
      'are you a robot',
      'are you a bot',
      'robot verification',
      'bot detection',
      'security check',
      'security verification',
      'security challenge',
      'verification required',
      'checking your browser',
      'cloudflare',
      'unusual traffic',
      'suspicious activity',
      'automated queries',
      'rate limit',
      'too many requests',
      'select all images',
      'select all squares',
      'i\'m not a robot',
      'i am not a robot',
      'verify access',
      'access verification',
      'one more step',
      'please verify',
      'confirm you are human',
      'confirm you\'re human'
    ];

    // Check for CAPTCHA keywords
    let captchaDetected = false;
    let captchaKeywordsFound = [];
    
    for (const keyword of captchaKeywords) {
      if (fullText.includes(keyword.toLowerCase())) {
        captchaDetected = true;
        captchaKeywordsFound.push(keyword);
      }
    }

    // Additional HTML-based detection (for invisible elements or specific services)
    // Check for common CAPTCHA service identifiers in HTML
    const captchaServices = [
      'g-recaptcha',
      'h-captcha',
      'hcaptcha',
      'recaptcha',
      'captcha-box',
      'cf-challenge',
      'challenge-form',
      'turnstile' // Cloudflare Turnstile
    ];

    for (const service of captchaServices) {
      if (fullHTML.includes(service)) {
        captchaDetected = true;
        if (!captchaKeywordsFound.includes(service)) {
          captchaKeywordsFound.push(`HTML:${service}`);
        }
      }
    }

    // Return detection results
    return {
      geoBlocking: {
        detected: geoBlockingDetected,
        keywords: geoBlockingKeywordsFound.slice(0, 5), // Limit to first 5 matches
        count: geoBlockingKeywordsFound.length
      },
      captcha: {
        detected: captchaDetected,
        keywords: captchaKeywordsFound.slice(0, 5), // Limit to first 5 matches
        count: captchaKeywordsFound.length
      },
      textLength: bodyText.length,
      htmlLength: bodyHTML.length,
      debugInfo: {
        bodyExists: !!document.body,
        textSample: bodyText.substring(0, 200),
        htmlSample: bodyHTML.substring(0, 200)
      }
    };
  });
}

/**
 * Create default blocking detection results when detection is skipped
 * @returns {Object} Default blocking detection results
 */
export function createSkippedBlockingResults() {
  return {
    geoBlocking: {
      detected: false,
      keywords: [],
      count: 0
    },
    captcha: {
      detected: false,
      keywords: [],
      count: 0
    },
    textLength: 0,
    htmlLength: 0
  };
}

/**
 * Create error blocking detection results when detection fails
 * @param {Error} error - The error that occurred
 * @returns {Object} Error blocking detection results
 */
export function createErrorBlockingResults(error) {
  return {
    geoBlocking: {
      detected: false,
      keywords: [`Error: ${error.message}`],
      count: 0
    },
    captcha: {
      detected: false,
      keywords: [`Error: ${error.message}`],
      count: 0
    },
    textLength: 0,
    htmlLength: 0,
    error: error.message
  };
}

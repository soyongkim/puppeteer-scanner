/**
 * Anti-detection and stealth mode configurations for the browser
 */

/**
 * Apply comprehensive stealth configurations to avoid bot detection
 * @param {Object} page - Puppeteer page object
 */
export async function setupStealthMode(page) {
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

    // Mock screen properties to appear more realistic
    Object.defineProperty(screen, 'colorDepth', {
      get: () => 24
    });
    
    Object.defineProperty(screen, 'pixelDepth', {
      get: () => 24
    });

    // Mock timezone
    Object.defineProperty(Intl.DateTimeFormat.prototype, 'resolvedOptions', {
      value: function() {
        return {
          timeZone: 'America/New_York',
          locale: 'en-US'
        };
      }
    });

    // Hide automation indicators in iframe detection
    Object.defineProperty(window, 'outerHeight', {
      get: () => window.innerHeight
    });

    Object.defineProperty(window, 'outerWidth', {
      get: () => window.innerWidth
    });

    // Mock document.hidden to appear as if page is visible
    Object.defineProperty(document, 'hidden', {
      get: () => false
    });

    Object.defineProperty(document, 'visibilityState', {
      get: () => 'visible'
    });
  });
}
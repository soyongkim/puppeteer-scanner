/**
 * Comprehensive language detection for web pages
 * Extracted from the original puppeteer-scanner.js
 */


/**
 * Detect website language using comprehensive content analysis
 * @param {Object} page - Puppeteer page object
 * @param {string} targetUrl - Target URL for fallback curl requests
 * @param {Object} config - Configuration object with proxy settings
 * @returns {Object} Language detection results
 */
export async function detectWebsiteLanguage(page) {
  try {
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 1000 });
  } catch (e) {
    console.log('Warning: Page readiness check failed, continuing with language detection...');
  }

  return await page.evaluate(() => {
    // Simple text extraction using only visible elements
    const title = document.title || '';
    const metaDescription = document.querySelector('meta[name="description"]')?.content || '';
    
    // Extract text from visible elements
    const allElements = Array.from(document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, div, span, a, td, th, li, article, section, main, nav, header, footer, button, label, input, textarea'));
    const visibleText = allElements
      .map(el => {
        // Skip hidden elements
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') {
          return '';
        }
        const text = el.innerText || '';
        return text.trim();
      })
      .filter(text => text.length > 1)
      .join(' ');
    
    const fullText = `${title} ${metaDescription} ${visibleText}`.toLowerCase();
    
    // Debug info
    const debugInfo = {
      documentState: document.readyState,
      title: title,
      metaDescription: metaDescription,
      visibleTextLength: visibleText.length,
      fullTextLength: fullText.length,
      elementCount: document.querySelectorAll('*').length,
      textSample: visibleText.substring(0, 200) || fullText.substring(0, 200),
      visibleElements: allElements.length
    };
    
    // Get explicit language declarations with enhanced detection
    const htmlElement = document.documentElement || document.querySelector('html');
    const htmlLang = (htmlElement?.lang || htmlElement?.getAttribute('lang') || '').toLowerCase().trim();
    const bodyLang = (document.body?.lang || '').toLowerCase().trim();
    const metaLanguages = Array.from(
      document.querySelectorAll('meta[http-equiv="Content-Language"], meta[name="language"], meta[property="og:locale"]')
    ).map(m => (m.content || '').toLowerCase().trim()).filter(lang => lang.length > 0);
    
    // Debug: Log what we're actually seeing
    console.log('DEBUG HTML lang detection:', {
      htmlElementExists: !!htmlElement,
      htmlLang: htmlLang,
      bodyLang: bodyLang,
      metaLanguages: metaLanguages,
      documentHTML: document.documentElement?.outerHTML?.substring(0, 500) || 'No HTML found'
    });
    
    // Parse lang codes to extract primary language (e.g., "fr-FR" -> "fr")
    const parseLangCode = (langCode) => {
      if (!langCode) return '';
      const parts = langCode.split('-');
      const primary = parts[0];
      
      // Map common language codes to full names
      const langMap = {
        'en': 'English',
        'fr': 'French', 
        'es': 'Spanish',
        'de': 'German',
        'it': 'Italian',
        'pt': 'Portuguese',
        'ru': 'Russian',
        'zh': 'Chinese',
        'ja': 'Japanese',
        'ko': 'Korean',
        'ar': 'Arabic',
        'nl': 'Dutch',
        'pl': 'Polish',
        'fa': 'Persian',
        'pe': 'Persian'
      };
      
      return langMap[primary] || primary;
    };
    
    const declaredLanguages = [
      parseLangCode(htmlLang),
      parseLangCode(bodyLang),
      ...metaLanguages.map(parseLangCode)
    ].filter(lang => lang.length > 0);
    
    const primaryDeclaredLanguage = declaredLanguages[0] || '';
    
    // Language detection patterns - Unicode ranges and common words
    const languagePatterns = {
      'English': {
        unicode: /[a-zA-Z]/g,
        words: /\b(the|and|for|are|but|not|you|all|can|had|her|was|one|our|out|day|get|has|him|his|how|its|may|new|now|old|see|two|way|who|boy|did|man|men|put|say|she|too|use)\b/g,
      },
      'Spanish': {
        unicode: /[a-záéíóúüñ]/gi,
        words: /\b(que|con|una|por|para|más|como|pero|sus|hasta|desde|cuando|muy|sin|sobre|también|me|se|le|da|su|un|el|en|es|se|no|te|lo|le|da|mi|tu|él|yo|ha|he|si|ya|ti)\b/g,
      },
      'French': {
        unicode: /[a-zàâäçéèêëïîôùûüÿ]/gi,
        words: /\b(que|les|des|est|son|une|sur|avec|tout|ses|était|être|avoir|lui|dans|ce|il|le|de|à|un|pour|pas|vous|par|sur|sont|sa|cette|au|se|ne|et|en|du|elle|la|mais|ou|si|nous|on|me|te|se)\b/g,
      },
      'German': {
        unicode: /[a-zäöüß]/gi,
        words: /\b(der|die|und|in|den|von|zu|das|mit|sich|des|auf|für|ist|im|dem|nicht|ein|eine|als|auch|es|an|werden|aus|er|hat|dass|sie|nach|wird|bei|einer|um|am|sind|noch|wie|einem|über|einen|so|zum|war|haben|nur|oder|aber|vor|zur|bis|unter|kann|du|sein|wenn|ich|mich|mir|dich|dir|uns|euch|ihnen|ihr|ihm|sie|ihn)\b/g,
      },
      'Italian': {
        unicode: /[a-zàéèíìîóòúù]/gi,
        words: /\b(che|con|una|per|più|come|ma|suo|fino|da|quando|molto|senza|sopra|anche|me|se|le|gli|la|un|il|in|è|si|no|lo|mi|tu|lui|io|ha|ho|se|già|ti)\b/g,
      },
      'Portuguese': {
        unicode: /[a-zàâãçéêíóôõú]/gi,
        words: /\b(que|com|uma|por|para|mais|como|mas|seu|até|quando|muito|sem|sobre|também|me|se|lhe|da|um|o|em|é|se|não|te|lo|lhe|da|meu|teu|ele|eu|há|é|se|já|ti)\b/g,
        commonPhrases: /(porque|depois|então|enquanto|durante|embora|ainda|sempre|nenhum|algum)/g
      },
      'Russian': {
        unicode: /[а-яё]/gi,
        words: /\b(что|это|как|так|все|она|эта|тот|они|мой|наш|для|его|при|был|том|два|где|там|чем|них|быть|есть|она|оно|мне|нас|вас|njih|его|её|их|себя|тебя|меня|нами|вами|ними|мной|тобой|собой)\b/g,
      },
      'Chinese': {
        unicode: /[\u4e00-\u9fff]/g,
        words: /(的|了|是|在|有|我|他|这|个|们|你|来|不|到|一|上|也|为|就|学|生|会|可|以|要|对|没|说|她|好|都|和|很|给|用|过|因|请|让|从|想|实|现|理|明|白|知|道|看|见|听|到)/g,
      },
      'Japanese': {
        unicode: /[\u3040-\u30ff\u4e00-\u9faf]/g,
        words: /(の|は|に|を|が|で|て|と|も|また|より|こそ|でも|だけ|など|でしょう|ます|です|れる|ある|いる|する|なる|できる|みる|くる|いく|もの|こと|ひと|なに|みず|あめ|つち|ひかり|かぜ|そら|うみ|やま|はな|とり|むし|さかな|くさ|き|のみ|もり|かわ|いけ|たに|まち|みせ|いえ|がっこう|びょういん|こうえん)/g,
      },
      'Korean': {
        unicode: /[\uac00-\ud7af]/g,
        words: /(이|가|를|을|에서|와|과|도|의|는|은|로|으로|하고|하다|있다|없다|되다|보다|같다|다른|많다|작다|크다|좋다|나쁘다|새로운|오래된|빠른|느린|높은|낮은)/g,
      },
      'Arabic': {
        unicode: /[\u0600-\u06ff]/g,
        words: /(في|من|إلى|على|هذا|هذه|ذلك|تلك|كان|كانت|ليس|ليست|أن|أنه|أنها|التي|الذي|الذين|اللاتي|اللواتي|وال|أو|إن|كل|بعد|قبل|عند|عندما|حين|حيث|كيف|لماذا|ماذا|متى)/g,
      },
      'Dutch': {
        unicode: /[a-zäöüéèêëïîôàáâåæøß]/gi,
        words: /\b(het|van|een|in|op|te|dat|de|is|en|voor|met|als|zijn|er|worden|door|ze|niet|aan|hebben|over|uit|worden|kan|maar|worden|ook|na|zoals|tussen|onder|alleen|zonder)\b/g,
      },
      'Polish': {
        unicode: /[a-ząćęłńóśźż]/gi,
        words: /\b(że|się|nie|na|do|jest|będzie|ma|ale|jak|tak|być|czy|lub|oraz|gdy|już|jeszcze|bardzo|może|można|przez|pod|nad|między|przed|po|za|bez|dla|od|przy|we|ze|ze|co|kto|gdzie|kiedy|dlaczego)\b/g,
      },
      'Persian': {
        unicode: /[\u0600-\u06ff]/g,
        words: /(و|های|که|در|از|به|را|ام|ان|یا|دو|آن|یا|از|یا|بر|تا|ما|این|با|یا|ان|یا|های|با|یا|اگر|که|پس|حتی|ولی|تا|که|چون|چرا|نبود|بوده|است|آمده|ورده|بود)/g,
      }
    };
    
    // Calculate language scores
    const languageScores = {};
    const textLength = fullText.length;
    
    // 1. First priority: Check HTML lang attribute
    if (htmlLang) {
      const htmlLangCode = htmlLang.split('-')[0];
      const detectedFromHtml = parseLangCode(htmlLang);
      if (detectedFromHtml) {
        return {
          primaryLanguage: detectedFromHtml,
          confidence: 'High',
          reason: 'Detected from HTML lang attribute',
          declaredLanguage: htmlLang,
          textLength: textLength,
          debugInfo: debugInfo
        };
      }
    }
    
    // 2. Second priority: Check body lang attribute
    if (bodyLang) {
      const bodyLangCode = bodyLang.split('-')[0];
      const detectedFromBody = parseLangCode(bodyLang);
      if (detectedFromBody) {
        return {
          primaryLanguage: detectedFromBody,
          confidence: 'High',
          reason: 'Detected from body lang attribute',
          declaredLanguage: bodyLang,
          textLength: textLength,
          debugInfo: debugInfo
        };
      }
    }
    
    // 3. Third priority: Check meta language tags
    if (metaLanguages.length > 0) {
      const detectedFromMeta = parseLangCode(metaLanguages[0]);
      if (detectedFromMeta) {
        return {
          primaryLanguage: detectedFromMeta,
          confidence: 'High',
          reason: 'Detected from meta language tag',
          declaredLanguage: metaLanguages[0],
          textLength: textLength,
          debugInfo: debugInfo
        };
      }
    }
    
    // 4. Final fallback: Content analysis using language patterns
    console.log('No language declarations found, analyzing content patterns...');
    
    // TWO-STAGE APPROACH: Unicode first, then word disambiguation
    
    // Stage 1: Unicode-based filtering
    const unicodeCandidates = [];
    
    Object.entries(languagePatterns).forEach(([language, patterns]) => {
      const unicodeMatches = fullText.match(patterns.unicode) || [];
      const unicodeScore = Math.min(unicodeMatches.length / textLength, 1.0) * 100;
      
      if (unicodeScore > 5) { // Only consider languages with significant Unicode presence
        unicodeCandidates.push({
          language,
          unicodeScore,
          unicodeMatches: unicodeMatches.length,
          patterns
        });
      }
    });
    
    // Sort by Unicode score
    unicodeCandidates.sort((a, b) => b.unicodeScore - a.unicodeScore);
    
    console.log(`Stage 1 - Unicode candidates: ${unicodeCandidates.map(c => `${c.language}(${c.unicodeScore.toFixed(1)})`).join(', ')}`);
    
    // Stage 2: Check if disambiguation needed
    let finalCandidates = [];
    
    if (unicodeCandidates.length === 0) {
      return {
        primaryLanguage: 'Unknown',
        confidence: 'Low',
        reason: 'No Unicode patterns matched',
        declaredLanguage: 'none',
        textLength: textLength,
        debugInfo: debugInfo
      };
    } else if (unicodeCandidates.length === 1) {
      // Only one candidate - no disambiguation needed
      console.log(`Stage 2 - Single candidate: ${unicodeCandidates[0].language}, using Unicode only`);
      finalCandidates = unicodeCandidates;
    } else {
      // Multiple candidates - use word patterns for disambiguation
      console.log(`Stage 2 - Multiple candidates detected, using word analysis for disambiguation`);
      
      unicodeCandidates.forEach(candidate => {
        const wordMatches = fullText.match(candidate.patterns.words) || [];
        const wordScore = Math.min(wordMatches.length / (textLength / 100), 1.0) * 100;
        
        candidate.finalScore = candidate.unicodeScore + wordScore;
        candidate.wordMatches = wordMatches.length;
        candidate.wordScore = wordScore;
      });
      
      finalCandidates = unicodeCandidates.sort((a, b) => b.finalScore - a.finalScore);
    }
    
    // Create language scores for output
    finalCandidates.forEach(candidate => {
      languageScores[candidate.language] = {
        total: Math.round((candidate.finalScore || candidate.unicodeScore) * 10) / 10,
        unicode: Math.round(candidate.unicodeScore * 10) / 10,
        words: Math.round((candidate.wordScore || 0) * 10) / 10,
        matches: {
          unicode: candidate.unicodeMatches,
          words: candidate.wordMatches || 0
        }
      };
    });
    
    // Get final results
    const sortedLanguages = Object.entries(languageScores)
      .sort((a, b) => b[1].total - a[1].total);
    
    const [topLanguage, topScore] = sortedLanguages[0];
    const [secondLanguage, secondScore] = sortedLanguages[1] || ['', { total: 0 }];
    
    // Determine confidence and reason based on detection method
    let confidence = 'Medium';
    let reason = '';
    
    if (unicodeCandidates.length === 1) {
      confidence = 'High';
      reason = 'Unique Unicode pattern detected';
    } else if (unicodeCandidates.length > 1) {
      if (topScore.total - secondScore.total >= 15) {
        confidence = 'High';
        reason = 'Word analysis successfully disambiguated Unicode candidates';
      } else {
        confidence = 'Medium';
        reason = 'Multiple Unicode candidates, partial disambiguation';
      }
    } else {
      confidence = 'Low';
      reason = 'Weak Unicode patterns detected';
    }
    
    // Check for mixed content
    const significantLanguages = sortedLanguages
      .filter(([_, score]) => score.total >= 5)
      .slice(0, 3);
    
    // Return content-based detection results
    return {
      primaryLanguage: topLanguage,
      confidence: confidence,
      score: topScore.total,
      reason: reason,
      declaredLanguage: 'none',
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
          words: score.words
        }
      })),
      debugInfo: debugInfo
    };
  });
}

/**
 * Create default language results when detection is disabled
 * @returns {Object} Default language results
 */
export function createSkippedLanguageResults() {
  return {
    primaryLanguage: 'Skipped',
    confidence: 'None',
    score: 0,
    reason: 'Language detection disabled via command line flag',
    declaredLanguage: 'unknown',
    textLength: 0
  };
}

/**
 * Create error language results when detection fails
 * @param {Error} error - The error that occurred
 * @returns {Object} Error language results
 */
export function createErrorLanguageResults(error) {
  return {
    primaryLanguage: 'Error',
    confidence: 'None',
    score: 0,
    reason: `Detection failed: ${error.message}`,
    declaredLanguage: 'unknown',
    textLength: 0
  };
}
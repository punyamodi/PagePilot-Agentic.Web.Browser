import 'webextension-polyfill';
import {
  connect,
  ExtensionTransport,
  type HTTPRequest,
  type HTTPResponse,
  type ProtocolType,
  type KeyInput,
} from 'puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js';
import type { Browser } from 'puppeteer-core/lib/esm/puppeteer/api/Browser.js';
import type { Page as PuppeteerPage } from 'puppeteer-core/lib/esm/puppeteer/api/Page.js';
import type { ElementHandle } from 'puppeteer-core/lib/esm/puppeteer/api/ElementHandle.js';
import type { Frame } from 'puppeteer-core/lib/esm/puppeteer/api/Frame.js';
import {
  getClickableElements as _getClickableElements,
  removeHighlights as _removeHighlights,
  getScrollInfo as _getScrollInfo,
  getMarkdownContent as _getMarkdownContent,
  getReadabilityContent as _getReadabilityContent,
  type ReadabilityResult,
} from '../dom/service';
import { DOMElementNode, type DOMState } from '../dom/views';
import { type BrowserContextConfig, DEFAULT_BROWSER_CONTEXT_CONFIG, type PageState } from './types';
import { createLogger } from '@src/background/log';

const logger = createLogger('Page');

declare global {
  interface Window {
    turn2Markdown: (selector?: string) => string;
  }
}

export function build_initial_state(tabId?: number, url?: string, title?: string): PageState {
  return {
    elementTree: new DOMElementNode({
      tagName: 'root',
      isVisible: true,
      parent: null,
      xpath: '',
      attributes: {},
      children: [],
    }),
    selectorMap: new Map(),
    tabId: tabId || 0,
    url: url || '',
    title: title || '',
    screenshot: null,
    pixelsAbove: 0,
    pixelsBelow: 0,
  };
}

export default class Page {
  private _tabId: number;
  private _browser: Browser | null = null;
  private _puppeteerPage: PuppeteerPage | null = null;
  private _config: BrowserContextConfig;
  private _state: PageState;
  private _validWebPage = false;

  constructor(tabId: number, url: string, title: string, config: Partial<BrowserContextConfig> = {}) {
    this._tabId = tabId;
    this._config = { ...DEFAULT_BROWSER_CONTEXT_CONFIG, ...config };
    this._state = build_initial_state(tabId, url, title);
    // chrome://newtab/, chrome://newtab/extensions are not valid web pages, can't be attached
    this._validWebPage = (tabId && url && url.startsWith('http')) || false;
  }

  get tabId(): number {
    return this._tabId;
  }

  get validWebPage(): boolean {
    return this._validWebPage;
  }

  get attached(): boolean {
    return this._validWebPage && this._puppeteerPage !== null;
  }

  async attachPuppeteer(): Promise<boolean> {
    if (!this._validWebPage) {
      return false;
    }

    if (this._puppeteerPage) {
      return true;
    }

    logger.info('attaching puppeteer', this._tabId);
    const browser = await connect({
      transport: await ExtensionTransport.connectTab(this._tabId),
      defaultViewport: null,
      protocol: 'cdp' as ProtocolType,
    });
    this._browser = browser;

    const [page] = await browser.pages();
    this._puppeteerPage = page;

    // Add anti-detection scripts
    await this._addAntiDetectionScripts();

    return true;
  }

  private async _addAntiDetectionScripts(): Promise<void> {
    if (!this._puppeteerPage) {
      return;
    }

    await this._puppeteerPage.evaluateOnNewDocument(`
      // Webdriver property
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });

      // Languages
      // Object.defineProperty(navigator, 'languages', {
      //   get: () => ['en-US']
      // });

      // Plugins
      // Object.defineProperty(navigator, 'plugins', {
      //   get: () => [1, 2, 3, 4, 5]
      // });

      // Chrome runtime
      window.chrome = { runtime: {} };

      // Permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );

      // Shadow DOM
      (function () {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function attachShadow(options) {
          return originalAttachShadow.call(this, { ...options, mode: "open" });
        };
      })();
    `);
  }

  async detachPuppeteer(): Promise<void> {
    if (this._browser) {
      await this._browser.disconnect();
      this._browser = null;
      this._puppeteerPage = null;
      // reset the state
      this._state = build_initial_state(this._tabId);
    }
  }

  async removeHighlight(): Promise<void> {
    if (this._config.highlightElements && this._validWebPage) {
      await _removeHighlights(this._tabId);
    }
  }

  async getClickableElements(focusElement: number): Promise<DOMState | null> {
    if (!this._validWebPage) {
      return null;
    }
    return _getClickableElements(
      this._tabId,
      this._config.highlightElements,
      focusElement,
      this._config.viewportExpansion,
    );
  }

  // Get scroll position information for the current page.
  async getScrollInfo(): Promise<[number, number]> {
    if (!this._validWebPage) {
      return [0, 0];
    }
    return _getScrollInfo(this._tabId);
  }

  async getContent(): Promise<string> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page is not connected');
    }
    return await this._puppeteerPage.content();
  }

  async getMarkdownContent(selector?: string): Promise<string> {
    if (!this._validWebPage) {
      return '';
    }
    return _getMarkdownContent(this._tabId, selector);
  }

  async getReadabilityContent(): Promise<ReadabilityResult> {
    if (!this._validWebPage) {
      return {
        title: '',
        content: '',
        textContent: '',
        length: 0,
        excerpt: '',
        byline: '',
        dir: '',
        siteName: '',
        lang: '',
        publishedTime: '',
      };
    }
    return _getReadabilityContent(this._tabId);
  }

  async getState(): Promise<PageState> {
    if (!this._validWebPage) {
      // return the initial state
      return build_initial_state(this._tabId);
    }
    await this.waitForPageAndFramesLoad();
    const state = await this._updateState();
    return state;
  }

  async _updateState(useVision = true, focusElement = -1): Promise<PageState> {
    try {
      // Test if page is still accessible
      // @ts-expect-error - puppeteerPage is not null, already checked before calling this function
      await this._puppeteerPage.evaluate('1');
    } catch (error) {
      logger.warning('Current page is no longer accessible:', error);
      if (this._browser) {
        const pages = await this._browser.pages();
        if (pages.length > 0) {
          this._puppeteerPage = pages[0];
        } else {
          throw new Error('Browser closed: no valid pages available');
        }
      }
    }

    try {
      await this.removeHighlight();

      // Get DOM content (equivalent to dom_service.get_clickable_elements)
      // This part would need to be implemented based on your DomService logic
      const content = await this.getClickableElements(focusElement);
      if (!content) {
        logger.warning('Failed to get clickable elements');
        // Return last known good state if available
        return this._state;
      }
      // log the attributes of content object
      if ('selectorMap' in content) {
        logger.debug('content.selectorMap:', content.selectorMap.size);
      } else {
        logger.debug('content.selectorMap: not found');
      }
      if ('elementTree' in content) {
        logger.debug('content.elementTree:', content.elementTree?.tagName);
      } else {
        logger.debug('content.elementTree: not found');
      }

      // Take screenshot if needed
      const screenshot = useVision ? await this.takeScreenshot() : null;
      const [pixelsAbove, pixelsBelow] = await this.getScrollInfo();

      // update the state
      this._state.elementTree = content.elementTree;
      this._state.selectorMap = content.selectorMap;
      this._state.url = this._puppeteerPage?.url() || '';
      this._state.title = (await this._puppeteerPage?.title()) || '';
      this._state.screenshot = screenshot;
      this._state.pixelsAbove = pixelsAbove;
      this._state.pixelsBelow = pixelsBelow;
      return this._state;
    } catch (error) {
      logger.error('Failed to update state:', error);
      // Return last known good state if available
      return this._state;
    }
  }

  async takeScreenshot(fullPage = false): Promise<string | null> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page is not connected');
    }

    try {
      // First disable animations/transitions using string-based evaluate
      await this._puppeteerPage.evaluate(`
        (function() {
          const styleId = 'puppeteer-disable-animations';
          if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }';
            document.head.appendChild(style);
          }
        })()
      `);

      // Take the screenshot using JPEG format with 80% quality
      const screenshot = await this._puppeteerPage.screenshot({
        fullPage: fullPage,
        encoding: 'base64',
        type: 'jpeg',
        quality: 80, // Good balance between quality and file size
      });

      // Clean up the style element using string-based evaluate
      await this._puppeteerPage.evaluate(`
        (function() {
          const style = document.getElementById('puppeteer-disable-animations');
          if (style) {
            style.remove();
          }
        })()
      `);

      return screenshot as string;
    } catch (error) {
      logger.error('Failed to take screenshot:', error);
      throw error;
    }
  }

  url(): string {
    if (this._puppeteerPage) {
      return this._puppeteerPage.url();
    }
    return this._state.url;
  }

  async title(): Promise<string> {
    if (this._puppeteerPage) {
      return await this._puppeteerPage.title();
    }
    return this._state.title;
  }

  async navigateTo(url: string): Promise<void> {
    if (!this._puppeteerPage) {
      return;
    }
    logger.info('navigateTo', url);

    try {
      await Promise.all([this.waitForPageAndFramesLoad(), this._puppeteerPage.goto(url)]);
      logger.info('navigateTo complete');
    } catch (error) {
      // Check if it's a timeout error
      if (error instanceof Error && error.message.includes('timeout')) {
        logger.warning('Navigation timeout, but page might still be usable:', error);
        // You might want to check if the page is actually loaded despite the timeout
      } else {
        logger.error('Navigation failed:', error);
        throw error; // Re-throw non-timeout errors
      }
    }
  }

  async refreshPage(): Promise<void> {
    if (!this._puppeteerPage) return;

    try {
      await Promise.all([this.waitForPageAndFramesLoad(), this._puppeteerPage.reload()]);
      logger.info('Page refresh complete');
    } catch (error) {
      if (error instanceof Error && error.message.includes('timeout')) {
        logger.warning('Refresh timeout, but page might still be usable:', error);
      } else {
        logger.error('Page refresh failed:', error);
        throw error;
      }
    }
  }

  async goBack(): Promise<void> {
    if (!this._puppeteerPage) return;

    try {
      await Promise.all([this.waitForPageAndFramesLoad(), this._puppeteerPage.goBack()]);
      logger.info('Navigation back completed');
    } catch (error) {
      if (error instanceof Error && error.message.includes('timeout')) {
        logger.warning('Back navigation timeout, but page might still be usable:', error);
      } else {
        logger.error('Could not navigate back:', error);
        throw error;
      }
    }
  }

  async goForward(): Promise<void> {
    if (!this._puppeteerPage) return;

    try {
      await Promise.all([this.waitForPageAndFramesLoad(), this._puppeteerPage.goForward()]);
      logger.info('Navigation forward completed');
    } catch (error) {
      if (error instanceof Error && error.message.includes('timeout')) {
        logger.warning('Forward navigation timeout, but page might still be usable:', error);
      } else {
        logger.error('Could not navigate forward:', error);
        throw error;
      }
    }
  }

  async scrollDown(amount?: number): Promise<void> {
    if (this._puppeteerPage) {
      if (amount) {
        await this._puppeteerPage?.evaluate(`window.scrollBy(0, ${amount});`);
      } else {
        await this._puppeteerPage?.evaluate('window.scrollBy(0, window.innerHeight);');
      }
    }
  }

  async scrollUp(amount?: number): Promise<void> {
    if (this._puppeteerPage) {
      if (amount) {
        await this._puppeteerPage?.evaluate(`window.scrollBy(0, -${amount});`);
      } else {
        await this._puppeteerPage?.evaluate('window.scrollBy(0, -window.innerHeight);');
      }
    }
  }

  async sendKeys(keys: string): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page is not connected');
    }

    // Split combination keys (e.g., "Control+A" or "Shift+ArrowLeft")
    const keyParts = keys.split('+');
    const modifiers = keyParts.slice(0, -1);
    const mainKey = keyParts[keyParts.length - 1];

    // Press modifiers and main key, ensure modifiers are released even if an error occurs.
    try {
      // Press all modifier keys (e.g., Control, Shift, etc.)
      for (const modifier of modifiers) {
        await this._puppeteerPage.keyboard.down(this._convertKey(modifier));
      }
      // Press the main key
      // also wait for stable state
      await Promise.all([
        this._puppeteerPage.keyboard.press(this._convertKey(mainKey)),
        this.waitForPageAndFramesLoad(),
      ]);
      logger.info('sendKeys complete', keys);
    } catch (error) {
      logger.error('Failed to send keys:', error);
      throw new Error(`Failed to send keys: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // Release all modifier keys in reverse order regardless of any errors in key press.
      for (const modifier of [...modifiers].reverse()) {
        try {
          await this._puppeteerPage.keyboard.up(this._convertKey(modifier));
        } catch (releaseError) {
          logger.error('Failed to release modifier:', modifier, releaseError);
        }
      }
    }
  }

  private _convertKey(key: string): KeyInput {
    const lowerKey = key.trim().toLowerCase();
    const keyMap: { [key: string]: string } = {
      // Letters
      a: 'KeyA',
      b: 'KeyB',
      c: 'KeyC',
      d: 'KeyD',
      e: 'KeyE',
      f: 'KeyF',
      g: 'KeyG',
      h: 'KeyH',
      i: 'KeyI',
      j: 'KeyJ',
      k: 'KeyK',
      l: 'KeyL',
      m: 'KeyM',
      n: 'KeyN',
      o: 'KeyO',
      p: 'KeyP',
      q: 'KeyQ',
      r: 'KeyR',
      s: 'KeyS',
      t: 'KeyT',
      u: 'KeyU',
      v: 'KeyV',
      w: 'KeyW',
      x: 'KeyX',
      y: 'KeyY',
      z: 'KeyZ',

      // Numbers
      '0': 'Digit0',
      '1': 'Digit1',
      '2': 'Digit2',
      '3': 'Digit3',
      '4': 'Digit4',
      '5': 'Digit5',
      '6': 'Digit6',
      '7': 'Digit7',
      '8': 'Digit8',
      '9': 'Digit9',

      // Special keys
      control: 'Control',
      shift: 'Shift',
      alt: 'Alt',
      meta: 'Meta',
      enter: 'Enter',
      backspace: 'Backspace',
      delete: 'Delete',
      arrowleft: 'ArrowLeft',
      arrowright: 'ArrowRight',
      arrowup: 'ArrowUp',
      arrowdown: 'ArrowDown',
      escape: 'Escape',
      tab: 'Tab',
      space: 'Space',
    };

    const convertedKey = keyMap[lowerKey] || key;
    logger.info('convertedKey', convertedKey);
    return convertedKey as KeyInput;
  }

  async scrollToText(text: string): Promise<boolean> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    try {
      // Try different locator strategies
      const selectors = [
        // Using text selector (equivalent to get_by_text)
        `::-p-text(${text})`,
        // Using XPath selector (contains text) - case insensitive
        `::-p-xpath(//*[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '${text.toLowerCase()}')])`,
      ];

      for (const selector of selectors) {
        try {
          const element = await this._puppeteerPage.$(selector);
          if (element) {
            // Check if element is visible
            const isVisible = await element.evaluate(el => {
              const style = window.getComputedStyle(el);
              return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
            });

            if (isVisible) {
              await this._scrollIntoViewIfNeeded(element);
              await new Promise(resolve => setTimeout(resolve, 500)); // Wait for scroll to complete
              return true;
            }
          }
        } catch (e) {
          logger.debug(`Locator attempt failed: ${e}`);
        }
      }
      return false;
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
  }

  async getDropdownOptions(index: number): Promise<Array<{ index: number; text: string; value: string }>> {
    const selectorMap = this.getSelectorMap();
    const element = selectorMap?.get(index);

    if (!element || !this._puppeteerPage) {
      throw new Error('Element not found or puppeteer is not connected');
    }

    try {
      // Get the element handle using the element's selector
      const elementHandle = await this.locateElement(element);
      if (!elementHandle) {
        throw new Error('Dropdown element not found');
      }

      // Evaluate the select element to get all options
      const options = await elementHandle.evaluate(select => {
        if (!(select instanceof HTMLSelectElement)) {
          throw new Error('Element is not a select element');
        }

        return Array.from(select.options).map(option => ({
          index: option.index,
          text: option.text, // Not trimming to maintain exact match for selection
          value: option.value,
        }));
      });

      if (!options.length) {
        throw new Error('No options found in dropdown');
      }

      return options;
    } catch (error) {
      throw new Error(`Failed to get dropdown options: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async selectDropdownOption(index: number, text: string): Promise<string> {
    const selectorMap = this.getSelectorMap();
    const element = selectorMap?.get(index);

    if (!element || !this._puppeteerPage) {
      throw new Error('Element not found or puppeteer is not connected');
    }

    logger.debug(`Attempting to select '${text}' from dropdown`);
    logger.debug(`Element attributes: ${JSON.stringify(element.attributes)}`);
    logger.debug(`Element tag: ${element.tagName}`);

    // Validate that we're working with a select element
    if (element.tagName?.toLowerCase() !== 'select') {
      const msg = `Cannot select option: Element with index ${index} is a ${element.tagName}, not a SELECT`;
      logger.error(msg);
      throw new Error(msg);
    }

    try {
      // Get the element handle using the element's selector
      const elementHandle = await this.locateElement(element);
      if (!elementHandle) {
        throw new Error(`Dropdown element with index ${index} not found`);
      }

      // Verify dropdown and select option in one call
      const result = await elementHandle.evaluate(
        (select, optionText, elementIndex) => {
          if (!(select instanceof HTMLSelectElement)) {
            return {
              found: false,
              message: `Element with index ${elementIndex} is not a SELECT`,
            };
          }

          const options = Array.from(select.options);
          const option = options.find(opt => opt.text.trim() === optionText);

          if (!option) {
            const availableOptions = options.map(o => o.text.trim()).join('", "');
            return {
              found: false,
              message: `Option "${optionText}" not found in dropdown element with index ${elementIndex}. Available options: "${availableOptions}"`,
            };
          }

          // Set the value and dispatch events
          const previousValue = select.value;
          select.value = option.value;

          // Only dispatch events if the value actually changed
          if (previousValue !== option.value) {
            select.dispatchEvent(new Event('change', { bubbles: true }));
            select.dispatchEvent(new Event('input', { bubbles: true }));
          }

          return {
            found: true,
            message: `Selected option "${optionText}" with value "${option.value}"`,
          };
        },
        text,
        index,
      );

      logger.debug('Selection result:', result);
      // whether found or not, return the message
      return result.message;
    } catch (error) {
      const errorMessage = `${error instanceof Error ? error.message : String(error)}`;
      logger.error(errorMessage);
      throw new Error(errorMessage);
    }
  }

  async locateElement(element: DOMElementNode): Promise<ElementHandle | null> {
    if (!this._puppeteerPage) {
      logger.warning('Puppeteer is not connected');
      return null;
    }
    let currentFrame: PuppeteerPage | Frame = this._puppeteerPage;

    // Start with the target element and collect all parents
    const parents: DOMElementNode[] = [];
    let current = element;
    while (current.parent) {
      parents.push(current.parent);
      current = current.parent;
    }

    // Process all iframe parents in sequence (in reverse order - top to bottom)
    const iframes = parents.reverse().filter(item => item.tagName === 'iframe');
    for (const parent of iframes) {
      const cssSelector = parent.enhancedCssSelectorForElement(this._config.includeDynamicAttributes);
      const frameElement: ElementHandle | null = await currentFrame.$(cssSelector);
      if (!frameElement) {
        logger.warning(`Could not find iframe with selector: ${cssSelector}`);
        return null;
      }
      const frame: Frame | null = await frameElement.contentFrame();
      if (!frame) {
        logger.warning(`Could not access frame content for selector: ${cssSelector}`);
        return null;
      }
      currentFrame = frame;
    }

    // Strategy 1: Try CSS selector first
    const cssSelector = element.enhancedCssSelectorForElement(this._config.includeDynamicAttributes);
    logger.info(`Locating element with CSS selector: ${cssSelector}`);

    try {
      const elementHandle: ElementHandle | null = await currentFrame.$(cssSelector);
      if (elementHandle) {
        logger.info(`Element found with CSS selector: ${cssSelector}`);
        await this._scrollIntoViewIfNeeded(elementHandle);
        return elementHandle;
      }
      logger.warning(`Element NOT found with CSS selector: ${cssSelector}`);
    } catch (error) {
      logger.error(`Failed to locate element with CSS selector ${cssSelector}:`, error);
    }

    // Strategy 2: Try using the XPath directly
    if (element.xpath) {
      const xpathSelector = `//${element.xpath}`;
      logger.info(`Trying XPath selector: ${xpathSelector}`);
      try {
        // Use Puppeteer's XPath selector syntax
        const xpathHandle = await currentFrame.$(`xpath/${element.xpath}`);
        if (xpathHandle) {
          logger.info(`Element found with XPath: ${xpathSelector}`);
          await this._scrollIntoViewIfNeeded(xpathHandle);
          return xpathHandle;
        }
        logger.warning(`Element NOT found with XPath: ${xpathSelector}`);
      } catch (error) {
        logger.error(`Failed to locate element with XPath ${xpathSelector}:`, error);
      }
    }

    // Strategy 3: If element has an ID, try simple ID selector
    // biome-ignore lint/complexity/useLiteralKeys: <explanation>
    const elementId = element.attributes['id'];
    if (elementId) {
      logger.info(`Trying simple ID selector: #${elementId}`);
      try {
        const idHandle = await currentFrame.$(`#${elementId}`);
        if (idHandle) {
          logger.info(`Element found with ID selector: #${elementId}`);
          await this._scrollIntoViewIfNeeded(idHandle);
          return idHandle;
        }
        logger.warning(`Element NOT found with ID selector: #${elementId}`);
      } catch (error) {
        logger.error(`Failed to locate element with ID #${elementId}:`, error);
      }
    }

    // Strategy 4: Try name attribute for form elements
    // biome-ignore lint/complexity/useLiteralKeys: <explanation>
    const elementName = element.attributes['name'];
    if (elementName && element.tagName) {
      const nameSelector = `${element.tagName}[name="${elementName}"]`;
      logger.info(`Trying name selector: ${nameSelector}`);
      try {
        const nameHandle = await currentFrame.$(nameSelector);
        if (nameHandle) {
          logger.info(`Element found with name selector: ${nameSelector}`);
          await this._scrollIntoViewIfNeeded(nameHandle);
          return nameHandle;
        }
        logger.warning(`Element NOT found with name selector: ${nameSelector}`);
      } catch (error) {
        logger.error(`Failed to locate element with name selector ${nameSelector}:`, error);
      }
    }

    // Strategy 5: Try aria-label for accessibility
    // biome-ignore lint/complexity/useLiteralKeys: <explanation>
    const ariaLabel = element.attributes['aria-label'];
    if (ariaLabel && element.tagName) {
      const ariaSelector = `${element.tagName}[aria-label="${ariaLabel}"]`;
      logger.info(`Trying aria-label selector: ${ariaSelector}`);
      try {
        const ariaHandle = await currentFrame.$(ariaSelector);
        if (ariaHandle) {
          logger.info(`Element found with aria-label selector: ${ariaSelector}`);
          await this._scrollIntoViewIfNeeded(ariaHandle);
          return ariaHandle;
        }
        logger.warning(`Element NOT found with aria-label selector: ${ariaSelector}`);
      } catch (error) {
        logger.error(`Failed to locate element with aria-label selector ${ariaSelector}:`, error);
      }
    }

    logger.error(`All strategies failed to locate element: ${element.tagName}[${element.highlightIndex}]`);
    return null;
  }

  async inputTextElementNode(useVision: boolean, elementNode: DOMElementNode, text: string): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    try {
      // Use the element's information for error messages
      const elementInfo = `${elementNode.tagName || 'element'}[${elementNode.highlightIndex}]`;

      // Highlight before typing and get fresh element from updated state
      let targetElement = elementNode;
      if (elementNode.highlightIndex !== undefined) {
        await this._updateState(useVision, elementNode.highlightIndex);
        // Get fresh element from the updated selectorMap (it may have new xpath/attributes)
        const freshElement = this._state.selectorMap.get(elementNode.highlightIndex);
        if (freshElement) {
          targetElement = freshElement;
          logger.debug(`Using fresh element from selectorMap for index ${elementNode.highlightIndex}`);
        } else {
          logger.warning(
            `Element index ${elementNode.highlightIndex} no longer exists in selectorMap after state update`,
          );
        }
      }

      const element = await this.locateElement(targetElement);
      if (element) {
        // Puppeteer method - scroll, clear, and type
        await this._scrollIntoViewIfNeeded(element);

        // Clear the input field (equivalent to fill(''))
        await element.evaluate(el => {
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });

        // Type the text
        await element.type(text);
        logger.info(`Successfully typed into element ${elementInfo} using Puppeteer`);
        return;
      }

      // Fallback: Use chrome.scripting.executeScript to interact directly
      // This bypasses Puppeteer's DOM querying which may have issues
      logger.warning(`Puppeteer locateElement failed for ${elementInfo}, trying chrome.scripting fallback`);

      // biome-ignore lint/complexity/useLiteralKeys: <explanation>
      const elementId = targetElement.attributes['id'];
      // biome-ignore lint/complexity/useLiteralKeys: <explanation>
      const elementName = targetElement.attributes['name'];
      // biome-ignore lint/complexity/useLiteralKeys: <explanation>
      const ariaLabel = targetElement.attributes['aria-label'];
      const tagName = targetElement.tagName || 'input';

      const result = await chrome.scripting.executeScript({
        target: { tabId: this._tabId },
        func: function (params: { id?: string; name?: string; ariaLabel?: string; tagName: string; text: string }) {
          let element: HTMLElement | null = null;

          // Try to find element by ID
          if (params.id) {
            element = document.getElementById(params.id);
          }

          // Try by name
          if (!element && params.name) {
            element = document.querySelector(`${params.tagName}[name="${params.name}"]`);
          }

          // Try by aria-label
          if (!element && params.ariaLabel) {
            element = document.querySelector(`${params.tagName}[aria-label="${params.ariaLabel}"]`);
          }

          // Try just by tag name with role combobox (common for search boxes)
          if (!element) {
            element = document.querySelector(`${params.tagName}[role="combobox"]`);
          }

          if (!element) {
            return { success: false, error: 'Element not found via any selector' };
          }

          // Focus and input text
          element.focus();
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            element.value = params.text;
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            return { success: true };
          }

          // For contenteditable elements
          if (element.isContentEditable) {
            element.textContent = params.text;
            element.dispatchEvent(new Event('input', { bubbles: true }));
            return { success: true };
          }

          return { success: false, error: 'Element is not an input or contenteditable' };
        },
        args: [{ id: elementId, name: elementName, ariaLabel: ariaLabel, tagName: tagName, text: text }],
      });

      const scriptResult = result[0]?.result;
      if (scriptResult?.success) {
        logger.info(`Successfully typed into element ${elementInfo} using chrome.scripting fallback`);
        return;
      }

      const errorMsg = scriptResult?.error || 'Unknown error';
      logger.error(`chrome.scripting fallback also failed: ${errorMsg}`);
      throw new Error(
        `Element ${elementInfo} not found. CSS selector: ${targetElement.enhancedCssSelectorForElement(this._config.includeDynamicAttributes)}. Fallback error: ${errorMsg}`,
      );
    } catch (error) {
      const errorInfo = `${elementNode.tagName || 'element'}[${elementNode.highlightIndex}]`;
      throw new Error(
        `Failed to input text into ${errorInfo}. Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async _scrollIntoViewIfNeeded(element: ElementHandle, timeout = 2500): Promise<void> {
    const startTime = Date.now();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Check if element is in viewport
      const isVisible = await element.evaluate(el => {
        const rect = el.getBoundingClientRect();

        // Check if element has size
        if (rect.width === 0 || rect.height === 0) return false;

        // Check if element is hidden
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
          return false;
        }

        // Check if element is in viewport
        const isInViewport =
          rect.top >= 0 &&
          rect.left >= 0 &&
          rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
          rect.right <= (window.innerWidth || document.documentElement.clientWidth);

        if (!isInViewport) {
          // Scroll into view if not visible
          el.scrollIntoView({
            behavior: 'auto',
            block: 'center',
            inline: 'center',
          });
          return false;
        }

        return true;
      });

      if (isVisible) break;

      // Check timeout
      if (Date.now() - startTime > timeout) {
        throw new Error('Timed out while trying to scroll element into view');
      }

      // Small delay before next check
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async clickElementNode(useVision: boolean, elementNode: DOMElementNode): Promise<void> {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer is not connected');
    }

    try {
      // Highlight before clicking and get fresh element from updated state
      let targetElement = elementNode;
      if (elementNode.highlightIndex !== undefined) {
        await this._updateState(useVision, elementNode.highlightIndex);
        // Get fresh element from the updated selectorMap (it may have new xpath/attributes)
        const freshElement = this._state.selectorMap.get(elementNode.highlightIndex);
        if (freshElement) {
          targetElement = freshElement;
          logger.debug(`Using fresh element from selectorMap for index ${elementNode.highlightIndex}`);
        } else {
          logger.warning(
            `Element index ${elementNode.highlightIndex} no longer exists in selectorMap after state update`,
          );
        }
      }

      const element = await this.locateElement(targetElement);

      // If element is found via CSS selector, try clicking it
      if (element) {
        // Scroll element into view if needed
        await this._scrollIntoViewIfNeeded(element);

        try {
          // First attempt: Use Puppeteer's click method with timeout
          logger.info(`Clicking element with index ${targetElement.highlightIndex} using Puppeteer click`);
          await Promise.race([
            element.click(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Click timeout')), 2000)),
          ]);
          return; // Success!
        } catch (error) {
          logger.info('Puppeteer click failed, trying JavaScript click', error);

          try {
            // Second attempt: Use evaluate to perform a direct click
            await element.evaluate(el => (el as HTMLElement).click());
            return; // Success!
          } catch (secondError) {
            logger.info('JavaScript click failed, trying coordinate-based click', secondError);
          }
        }
      } else {
        logger.info(
          `Element with index ${targetElement.highlightIndex} not found via CSS selector, trying coordinate-based click`,
        );
      }

      // Third attempt: Use stored viewport coordinates for mouse click
      if (targetElement.viewportCoordinates?.center) {
        const { x, y } = targetElement.viewportCoordinates.center;
        logger.info(`Attempting coordinate-based click at (${x}, ${y})`);

        try {
          // Move to position and click
          await this._puppeteerPage.mouse.move(x, y);
          await this._puppeteerPage.mouse.click(x, y);
          return; // Success!
        } catch (coordError) {
          logger.error('Coordinate-based click failed:', coordError);
        }
      }

      // Fourth attempt: Use pageCoordinates if viewport coordinates failed
      if (targetElement.pageCoordinates?.center) {
        const { x, y } = targetElement.pageCoordinates.center;
        // Convert page coordinates to viewport coordinates by subtracting scroll position
        const scrollX = targetElement.viewportInfo?.scrollX ?? 0;
        const scrollY = targetElement.viewportInfo?.scrollY ?? 0;
        const viewportX = x - scrollX;
        const viewportY = y - scrollY;

        logger.info(`Attempting page-coordinate-based click at viewport (${viewportX}, ${viewportY})`);

        try {
          await this._puppeteerPage.mouse.move(viewportX, viewportY);
          await this._puppeteerPage.mouse.click(viewportX, viewportY);
          return; // Success!
        } catch (pageCoordError) {
          logger.error('Page-coordinate-based click failed:', pageCoordError);
        }
      }

      // Fifth attempt: Use chrome.scripting.executeScript as final fallback
      logger.warning(
        `All Puppeteer click methods failed for ${targetElement.tagName}[${targetElement.highlightIndex}], trying chrome.scripting fallback`,
      );

      // biome-ignore lint/complexity/useLiteralKeys: <explanation>
      const elementId = targetElement.attributes['id'];
      // biome-ignore lint/complexity/useLiteralKeys: <explanation>
      const elementName = targetElement.attributes['name'];
      // biome-ignore lint/complexity/useLiteralKeys: <explanation>
      const ariaLabel = targetElement.attributes['aria-label'];
      const tagName = targetElement.tagName || '*';
      const viewportCenter = targetElement.viewportCoordinates?.center;

      const result = await chrome.scripting.executeScript({
        target: { tabId: this._tabId },
        func: function (params: {
          id?: string;
          name?: string;
          ariaLabel?: string;
          tagName: string;
          center?: { x: number; y: number };
        }) {
          let element: HTMLElement | null = null;

          // Try to find element by ID
          if (params.id) {
            element = document.getElementById(params.id);
          }

          // Try by name
          if (!element && params.name) {
            element = document.querySelector(`${params.tagName}[name="${params.name}"]`);
          }

          // Try by aria-label
          if (!element && params.ariaLabel) {
            element = document.querySelector(`${params.tagName}[aria-label="${params.ariaLabel}"]`);
          }

          // Try using elementFromPoint if we have coordinates
          if (!element && params.center) {
            element = document.elementFromPoint(params.center.x, params.center.y) as HTMLElement;
          }

          if (!element) {
            return { success: false, error: 'Element not found via any selector' };
          }

          // Click the element
          element.click();
          return { success: true };
        },
        args: [{ id: elementId, name: elementName, ariaLabel: ariaLabel, tagName: tagName, center: viewportCenter }],
      });

      const scriptResult = result[0]?.result;
      if (scriptResult?.success) {
        logger.info(
          `Successfully clicked element ${targetElement.tagName}[${targetElement.highlightIndex}] using chrome.scripting fallback`,
        );
        return;
      }

      const errorMsg = scriptResult?.error || 'Unknown error';
      logger.error(`chrome.scripting fallback also failed: ${errorMsg}`);

      throw new Error(
        `All click attempts failed for element ${targetElement.tagName || 'element'}[${targetElement.highlightIndex}]. Fallback error: ${errorMsg}`,
      );
    } catch (error) {
      throw new Error(
        `Failed to click element: ${elementNode.tagName}[${elementNode.highlightIndex}]. Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  getSelectorMap(): Map<number, DOMElementNode> {
    return this._state.selectorMap;
  }

  async getElementByIndex(index: number): Promise<ElementHandle | null> {
    const selectorMap = this.getSelectorMap();
    const element = selectorMap.get(index);
    if (!element) return null;
    return await this.locateElement(element);
  }

  getDomElementByIndex(index: number): DOMElementNode | null {
    const selectorMap = this.getSelectorMap();
    return selectorMap.get(index) || null;
  }

  isFileUploader(elementNode: DOMElementNode, maxDepth = 3, currentDepth = 0): boolean {
    if (currentDepth > maxDepth) {
      return false;
    }

    // Check current element
    if (elementNode.tagName === 'input') {
      // Check for file input attributes
      const attributes = elementNode.attributes;
      // biome-ignore lint/complexity/useLiteralKeys: <explanation>
      if (attributes['type']?.toLowerCase() === 'file' || !!attributes['accept']) {
        return true;
      }
    }

    // Recursively check children
    if (elementNode.children && currentDepth < maxDepth) {
      for (const child of elementNode.children) {
        if ('tagName' in child) {
          // DOMElementNode type guard
          if (this.isFileUploader(child as DOMElementNode, maxDepth, currentDepth + 1)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  async waitForPageLoadState(timeout?: number) {
    const timeoutValue = timeout || 8000;
    await this._puppeteerPage?.waitForNavigation({ timeout: timeoutValue });
  }

  private async _waitForStableNetwork() {
    if (!this._puppeteerPage) {
      throw new Error('Puppeteer page is not connected');
    }

    const RELEVANT_RESOURCE_TYPES = new Set(['document', 'stylesheet', 'image', 'font', 'script', 'iframe']);

    const RELEVANT_CONTENT_TYPES = new Set([
      'text/html',
      'text/css',
      'application/javascript',
      'image/',
      'font/',
      'application/json',
    ]);

    const IGNORED_URL_PATTERNS = new Set([
      // Analytics and tracking
      'analytics',
      'tracking',
      'telemetry',
      'beacon',
      'metrics',
      // Ad-related
      'doubleclick',
      'adsystem',
      'adserver',
      'advertising',
      // Social media widgets
      'facebook.com/plugins',
      'platform.twitter',
      'linkedin.com/embed',
      // Live chat and support
      'livechat',
      'zendesk',
      'intercom',
      'crisp.chat',
      'hotjar',
      // Push notifications
      'push-notifications',
      'onesignal',
      'pushwoosh',
      // Background sync/heartbeat
      'heartbeat',
      'ping',
      'alive',
      // WebRTC and streaming
      'webrtc',
      'rtmp://',
      'wss://',
      // Common CDNs
      'cloudfront.net',
      'fastly.net',
    ]);

    const pendingRequests = new Set();
    let lastActivity = Date.now();

    const onRequest = (request: HTTPRequest) => {
      // Filter by resource type
      const resourceType = request.resourceType();
      if (!RELEVANT_RESOURCE_TYPES.has(resourceType)) {
        return;
      }

      // Filter out streaming, websocket, and other real-time requests
      if (['websocket', 'media', 'eventsource', 'manifest', 'other'].includes(resourceType)) {
        return;
      }

      // Filter out by URL patterns
      const url = request.url().toLowerCase();
      if (Array.from(IGNORED_URL_PATTERNS).some(pattern => url.includes(pattern))) {
        return;
      }

      // Filter out data URLs and blob URLs
      if (url.startsWith('data:') || url.startsWith('blob:')) {
        return;
      }

      // Filter out requests with certain headers
      const headers = request.headers();
      if (
        // biome-ignore lint/complexity/useLiteralKeys: <explanation>
        headers['purpose'] === 'prefetch' ||
        headers['sec-fetch-dest'] === 'video' ||
        headers['sec-fetch-dest'] === 'audio'
      ) {
        return;
      }

      pendingRequests.add(request);
      lastActivity = Date.now();
    };

    const onResponse = (response: HTTPResponse) => {
      const request = response.request();
      if (!pendingRequests.has(request)) {
        return;
      }

      // Filter by content type
      const contentType = response.headers()['content-type']?.toLowerCase() || '';

      // Skip streaming content
      if (
        ['streaming', 'video', 'audio', 'webm', 'mp4', 'event-stream', 'websocket', 'protobuf'].some(t =>
          contentType.includes(t),
        )
      ) {
        pendingRequests.delete(request);
        return;
      }

      // Only process relevant content types
      if (!Array.from(RELEVANT_CONTENT_TYPES).some(ct => contentType.includes(ct))) {
        pendingRequests.delete(request);
        return;
      }

      // Skip large responses
      const contentLength = response.headers()['content-length'];
      if (contentLength && Number.parseInt(contentLength) > 5 * 1024 * 1024) {
        // 5MB
        pendingRequests.delete(request);
        return;
      }

      pendingRequests.delete(request);
      lastActivity = Date.now();
    };

    // Add event listeners
    this._puppeteerPage.on('request', onRequest);
    this._puppeteerPage.on('response', onResponse);

    try {
      const startTime = Date.now();

      // eslint-disable-next-line no-constant-condition
      while (true) {
        await new Promise(resolve => setTimeout(resolve, 100));

        const now = Date.now();
        const timeSinceLastActivity = (now - lastActivity) / 1000; // Convert to seconds

        if (pendingRequests.size === 0 && timeSinceLastActivity >= this._config.waitForNetworkIdlePageLoadTime) {
          break;
        }

        const elapsedTime = (now - startTime) / 1000; // Convert to seconds
        if (elapsedTime > this._config.maximumWaitPageLoadTime) {
          console.debug(
            `Network timeout after ${this._config.maximumWaitPageLoadTime}s with ${pendingRequests.size} pending requests:`,
            Array.from(pendingRequests).map(r => (r as HTTPRequest).url()),
          );
          break;
        }
      }
    } finally {
      // Clean up event listeners
      this._puppeteerPage.off('request', onRequest);
      this._puppeteerPage.off('response', onResponse);
    }
    console.debug(`Network stabilized for ${this._config.waitForNetworkIdlePageLoadTime} seconds`);
  }

  async waitForPageAndFramesLoad(timeoutOverwrite?: number): Promise<void> {
    // Start timing
    const startTime = Date.now();

    // Wait for page load
    try {
      await this._waitForStableNetwork();
    } catch (error) {
      console.warn('Page load failed, continuing...');
    }

    // Calculate remaining time to meet minimum wait time
    const elapsed = (Date.now() - startTime) / 1000; // Convert to seconds
    const minWaitTime = timeoutOverwrite || this._config.minimumWaitPageLoadTime;
    const remaining = Math.max(minWaitTime - elapsed, 0);

    console.debug(
      `--Page loaded in ${elapsed.toFixed(2)} seconds, waiting for additional ${remaining.toFixed(2)} seconds`,
    );

    // Sleep remaining time if needed
    if (remaining > 0) {
      await new Promise(resolve => setTimeout(resolve, remaining * 1000)); // Convert seconds to milliseconds
    }
  }
}

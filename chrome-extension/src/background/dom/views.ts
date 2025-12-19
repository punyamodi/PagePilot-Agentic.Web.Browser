import type { ViewportInfo, CoordinateSet } from './history/view';
import type { HashedDomElement } from './history/view';
import { HistoryTreeProcessor } from './history/service';

export abstract class DOMBaseNode {
  isVisible: boolean;
  parent?: DOMElementNode | null;

  constructor(isVisible: boolean, parent?: DOMElementNode | null) {
    this.isVisible = isVisible;
    // Use None as default and set parent later to avoid circular reference issues
    this.parent = parent;
  }
}

export class DOMTextNode extends DOMBaseNode {
  type = 'TEXT_NODE' as const;
  text: string;

  constructor(text: string, isVisible: boolean, parent?: DOMElementNode | null) {
    super(isVisible, parent);
    this.text = text;
  }

  hasParentWithHighlightIndex(): boolean {
    let current = this.parent;
    while (current != null) {
      if (current.highlightIndex !== undefined) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }
}

export class DOMElementNode extends DOMBaseNode {
  tagName: string | null;
  /**
   * xpath: the xpath of the element from the last root node (shadow root or iframe OR document if no shadow root or iframe).
   * To properly reference the element we need to recursively switch the root node until we find the element (work you way up the tree with `.parent`)
   */
  xpath: string | null;
  attributes: Record<string, string>;
  children: DOMBaseNode[];
  isInteractive: boolean;
  isTopElement: boolean;
  shadowRoot: boolean;
  highlightIndex?: number;
  viewportCoordinates?: CoordinateSet;
  pageCoordinates?: CoordinateSet;
  viewportInfo?: ViewportInfo;

  constructor(params: {
    tagName: string | null;
    xpath: string | null;
    attributes: Record<string, string>;
    children: DOMBaseNode[];
    isVisible: boolean;
    isInteractive?: boolean;
    isTopElement?: boolean;
    shadowRoot?: boolean;
    highlightIndex?: number;
    viewportCoordinates?: CoordinateSet;
    pageCoordinates?: CoordinateSet;
    viewportInfo?: ViewportInfo;
    parent?: DOMElementNode | null;
  }) {
    super(params.isVisible, params.parent);
    this.tagName = params.tagName;
    this.xpath = params.xpath;
    this.attributes = params.attributes;
    this.children = params.children;
    this.isInteractive = params.isInteractive ?? false;
    this.isTopElement = params.isTopElement ?? false;
    this.shadowRoot = params.shadowRoot ?? false;
    this.highlightIndex = params.highlightIndex;
    this.viewportCoordinates = params.viewportCoordinates;
    this.pageCoordinates = params.pageCoordinates;
    this.viewportInfo = params.viewportInfo;
  }

  // Cache for the hash value
  private _hashedValue?: HashedDomElement;
  private _hashPromise?: Promise<HashedDomElement>;

  /**
   * Returns a hashed representation of this DOM element
   * Async equivalent of the Python @cached_property hash method
   *
   * @returns {Promise<HashedDomElement>} A promise that resolves to the hashed DOM element
   * @throws {Error} If the hashing operation fails
   */
  async hash(): Promise<HashedDomElement> {
    // If we already have the value, return it immediately
    if (this._hashedValue) {
      return this._hashedValue;
    }

    // If a calculation is in progress, reuse that promise
    if (!this._hashPromise) {
      this._hashPromise = HistoryTreeProcessor.hashDomElement(this)
        .then(result => {
          this._hashedValue = result;
          this._hashPromise = undefined; // Clean up
          return result;
        })
        .catch(error => {
          // Clear the promise reference to allow retry on next call
          this._hashPromise = undefined;

          // Log the error for debugging
          console.error('Error computing DOM element hash:', error);

          // Create a more descriptive error
          const enhancedError = new Error(
            `Failed to hash DOM element (${this.tagName || 'unknown'}): ${error.message}`,
          );

          // Preserve the original stack trace if possible
          if (error.stack) {
            enhancedError.stack = error.stack;
          }

          // Rethrow to propagate to caller
          throw enhancedError;
        });
    }

    return this._hashPromise;
  }

  /**
   * Clears the cached hash value, forcing recalculation on next hash() call
   */
  clearHashCache(): void {
    this._hashedValue = undefined;
    this._hashPromise = undefined;
  }

  getAllTextTillNextClickableElement(maxDepth = -1): string {
    const textParts: string[] = [];

    const collectText = (node: DOMBaseNode, currentDepth: number): void => {
      if (maxDepth !== -1 && currentDepth > maxDepth) {
        return;
      }

      // Skip this branch if we hit a highlighted element (except for the current node)
      if (node instanceof DOMElementNode && node !== this && node.highlightIndex !== undefined) {
        return;
      }

      if (node instanceof DOMTextNode) {
        textParts.push(node.text);
      } else if (node instanceof DOMElementNode) {
        for (const child of node.children) {
          collectText(child, currentDepth + 1);
        }
      }
    };

    collectText(this, 0);
    return textParts.join('\n').trim();
  }

  clickableElementsToString(includeAttributes: string[] = []): string {
    const formattedText: string[] = [];

    const processNode = (node: DOMBaseNode, depth: number): void => {
      if (node instanceof DOMElementNode) {
        // Add element with highlight_index
        if (node.highlightIndex !== undefined) {
          let attributesStr = '';
          if (includeAttributes.length) {
            attributesStr = ` ${includeAttributes
              .map(key => (node.attributes[key] ? `${key}="${node.attributes[key]}"` : ''))
              .filter(Boolean)
              .join(' ')}`;
          }

          formattedText.push(
            `[${node.highlightIndex}]<${node.tagName}${attributesStr}>${node.getAllTextTillNextClickableElement()}</${node.tagName}>`,
          );
        }
        // Process children regardless
        for (const child of node.children) {
          processNode(child, depth + 1);
        }
      } else if (node instanceof DOMTextNode) {
        // Add text node only if it doesn't have a highlighted parent
        if (!node.hasParentWithHighlightIndex()) {
          formattedText.push(`[]${node.text}`);
        }
      }
    };

    processNode(this, 0);
    return formattedText.join('\n');
  }

  getFileUploadElement(checkSiblings = true): DOMElementNode | null {
    // biome-ignore lint/complexity/useLiteralKeys: <explanation>
    if (this.tagName === 'input' && this.attributes['type'] === 'file') {
      return this;
    }

    for (const child of this.children) {
      if (child instanceof DOMElementNode) {
        const result = child.getFileUploadElement(false);
        if (result) return result;
      }
    }

    if (checkSiblings && this.parent) {
      for (const sibling of this.parent.children) {
        if (sibling !== this && sibling instanceof DOMElementNode) {
          const result = sibling.getFileUploadElement(false);
          if (result) return result;
        }
      }
    }

    return null;
  }

  getAdvancedCssSelector(): string {
    return this.enhancedCssSelectorForElement();
  }

  convertSimpleXPathToCssSelector(xpath: string): string {
    if (!xpath) {
      return '';
    }

    // Remove leading slash if present
    const cleanXpath = xpath.replace(/^\//, '');

    // Split into parts
    const parts = cleanXpath.split('/');
    const cssParts: string[] = [];

    for (const part of parts) {
      if (!part) {
        continue;
      }

      // Handle index notation [n]
      if (part.includes('[')) {
        const bracketIndex = part.indexOf('[');
        let basePart = part.substring(0, bracketIndex);
        const indexPart = part.substring(bracketIndex);

        // Handle multiple indices
        const indices = indexPart
          .split(']')
          .slice(0, -1)
          .map(i => i.replace('[', ''));

        for (const idx of indices) {
          // Handle numeric indices
          if (/^\d+$/.test(idx)) {
            try {
              const index = Number.parseInt(idx, 10) - 1;
              basePart += `:nth-of-type(${index + 1})`;
            } catch (error) {
              // continue
            }
          }
          // Handle last() function
          else if (idx === 'last()') {
            basePart += ':last-of-type';
          }
          // Handle position() functions
          else if (idx.includes('position()')) {
            if (idx.includes('>1')) {
              basePart += ':nth-of-type(n+2)';
            }
          }
        }

        cssParts.push(basePart);
      } else {
        cssParts.push(part);
      }
    }

    const baseSelector = cssParts.join(' > ');
    return baseSelector;
  }

  enhancedCssSelectorForElement(includeDynamicAttributes = true): string {
    try {
      if (!this.xpath) {
        return '';
      }

      const tagName = this.tagName || '*';

      // First, try to build a simple selector using unique identifiers
      // If element has an ID, prefer using it (IDs are unique in the document)
      // biome-ignore lint/complexity/useLiteralKeys: <explanation>
      const id = this.attributes['id'];
      if (id && /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(id)) {
        // Simple ID selector is very reliable
        return `${tagName}#${id}`;
      }

      // If element has data-testid or data-qa (test attributes), use those
      // biome-ignore lint/complexity/useLiteralKeys: <explanation>
      const testId = this.attributes['data-testid'] || this.attributes['data-qa'] || this.attributes['data-cy'];
      if (testId && includeDynamicAttributes) {
        const attr = this.attributes['data-testid']
          ? 'data-testid'
          : this.attributes['data-qa']
            ? 'data-qa'
            : 'data-cy';
        return `${tagName}[${attr}="${testId}"]`;
      }

      // If element has a unique name attribute (common for form elements)
      // biome-ignore lint/complexity/useLiteralKeys: <explanation>
      const name = this.attributes['name'];
      if (name && ['input', 'textarea', 'select', 'button'].includes(tagName)) {
        return `${tagName}[name="${name}"]`;
      }

      // If no unique identifier, build a more specific selector
      // Start with tag name and add distinguishing attributes
      let cssSelector = tagName;

      // Add class attributes (limited to avoid overly specific selectors)
      // biome-ignore lint/complexity/useLiteralKeys: <explanation>
      if (this.attributes['class'] && includeDynamicAttributes) {
        const validClassNamePattern = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;
        // biome-ignore lint/complexity/useLiteralKeys: <explanation>
        const classes = this.attributes['class'].split(/\s+/);
        let classCount = 0;
        for (const className of classes) {
          if (!className.trim()) continue;
          // Skip dynamic-looking classes (contain numbers or long random strings)
          if (/\d{3,}/.test(className) || className.length > 20) continue;
          if (validClassNamePattern.test(className) && classCount < 2) {
            cssSelector += `.${className}`;
            classCount++;
          }
        }
      }

      // Add key identifying attributes (not value, as it can change)
      const KEY_ATTRIBUTES = new Set(['aria-label', 'role', 'type', 'placeholder', 'title', 'alt']);

      for (const [attribute, value] of Object.entries(this.attributes)) {
        if (attribute === 'class' || attribute === 'id') continue;
        if (!attribute.trim() || !KEY_ATTRIBUTES.has(attribute)) continue;

        // Skip empty values
        if (!value || value === '') continue;

        const safeAttribute = attribute.replace(':', '\\:');

        if (/["'<>`\n\r\t]/.test(value)) {
          const collapsedValue = value.replace(/\s+/g, ' ').trim();
          const safeValue = collapsedValue.replace(/"/g, '\\"');
          cssSelector += `[${safeAttribute}*="${safeValue}"]`;
        } else {
          cssSelector += `[${safeAttribute}="${value}"]`;
        }
      }

      // If selector is still just tag name, add XPath-based path as fallback
      if (cssSelector === tagName) {
        cssSelector = this.convertSimpleXPathToCssSelector(this.xpath);
      }

      return cssSelector;
    } catch (error) {
      // Fallback to a more basic selector if something goes wrong
      const tagName = this.tagName || '*';
      return `${tagName}[highlight-index='${this.highlightIndex}']`;
    }
  }
}

export interface DOMState {
  elementTree: DOMElementNode;
  selectorMap: Map<number, DOMElementNode>;
}

// biome-ignore lint/suspicious/noExplicitAny: <explanation>
export function domElementNodeToDict(elementTree: DOMBaseNode): any {
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  function nodeToDict(node: DOMBaseNode): any {
    if (node instanceof DOMTextNode) {
      return {
        type: 'text',
        text: node.text,
      };
    }
    if (node instanceof DOMElementNode) {
      return {
        type: 'element',
        tagName: node.tagName, // Note: using camelCase to match TypeScript conventions
        attributes: node.attributes,
        highlightIndex: node.highlightIndex,
        children: node.children.map(child => nodeToDict(child)),
      };
    }

    return {};
  }

  return nodeToDict(elementTree);
}

export async function calcBranchPathHashSet(state: DOMState): Promise<Set<string>> {
  const pathHashes = new Set(
    await Promise.all(Array.from(state.selectorMap.values()).map(async value => (await value.hash()).branchPathHash)),
  );
  return pathHashes;
}

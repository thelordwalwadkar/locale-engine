/**
 * Thin typed helpers over cheerio's DOM nodes. The node types come from `domhandler`, the DOM library cheerio itself is built on
 * (type-only imports: nothing of it is loaded at run time).
 */
import type { load } from 'cheerio';
import type { AnyNode, Element, Text } from 'domhandler';

export type CheerioRoot = ReturnType<typeof load>;
export type DomNode = AnyNode;
export type DomElement = Element;
export type DomText = Text;

export function isElement(node: DomNode): node is DomElement {
  return 'attribs' in node;
}

export function isText(node: DomNode): node is DomText {
  return node.type === 'text';
}

export function childNodes(el: DomElement): DomNode[] {
  return el.children;
}

export function childElements(el: DomElement): DomElement[] {
  return el.children.filter(isElement);
}

export function attr(el: DomElement, name: string): string | undefined {
  return el.attribs[name];
}

/** First descendant (depth first, document order) for which `pred` holds. */
export function findDescendant(el: DomElement, pred: (e: DomElement) => boolean): DomElement | undefined {
  for (const child of el.children) {
    if (!isElement(child)) continue;
    if (pred(child)) return child;
    const deeper = findDescendant(child, pred);
    if (deeper) return deeper;
  }
  return undefined;
}

export function hasDescendant(el: DomElement, pred: (e: DomElement) => boolean): boolean {
  return findDescendant(el, pred) !== undefined;
}

/** Number of non-whitespace characters below `node`; the unit of the text-density heuristics. */
export function textMass(node: DomNode): number {
  if (isText(node)) return node.data.replace(/\s+/g, '').length;
  if (!isElement(node)) return 0;
  let n = 0;
  for (const child of node.children) n += textMass(child);
  return n;
}

export function ancestors(el: DomElement): DomElement[] {
  const out: DomElement[] = [];
  for (let p = el.parent; p; p = p.parent) {
    if (isElement(p)) out.push(p);
  }
  return out;
}

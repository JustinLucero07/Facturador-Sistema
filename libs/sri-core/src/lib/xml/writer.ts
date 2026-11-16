/**
 * Serializador XML mínimo que produce directamente la FORMA CANÓNICA (C14N 1.0 inclusiva,
 * https://www.w3.org/TR/2001/REC-xml-c14n-20010315) para documentos sin espacios en blanco:
 *  - sin declaración XML ni espacios entre elementos,
 *  - elementos vacíos como <a></a>,
 *  - atributos: primero declaraciones xmlns (ordenadas por prefijo), luego atributos ordenados,
 *  - escape de texto (& < > \r) y de atributos (& < " \t \n \r).
 * Así, el digest del comprobante (transformación enveloped) se calcula sobre el mismo texto que se envía.
 */

export interface XmlElement {
  name: string;
  /** Declaraciones de espacio de nombres: prefijo → URI ('' = por defecto). */
  ns?: Record<string, string>;
  attrs?: Record<string, string | undefined | null>;
  children?: XmlChild[];
}

export type XmlChild = XmlElement | string | null | undefined | false;

export function el(name: string, attrs?: XmlElement['attrs'] | null, ...children: XmlChild[]): XmlElement {
  return { name, attrs: attrs ?? undefined, children };
}

/** Elemento con texto; si el valor es nulo/vacío se omite (útil para campos opcionales). */
export function opt(name: string, value: string | number | null | undefined): XmlElement | null {
  if (value === null || value === undefined || value === '') return null;
  return { name, children: [String(value)] };
}

export function txt(name: string, value: string | number): XmlElement {
  return { name, children: [String(value)] };
}

export function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
}

export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#x9;')
    .replace(/\n/g, '&#xA;')
    .replace(/\r/g, '&#xD;');
}

/** Caracteres de control no permitidos en XML 1.0 → se eliminan para no romper el documento. */
export function cleanText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
}

export function serialize(node: XmlChild): string {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string') return escapeText(cleanText(node));
  const nsDecls = Object.entries(node.ns ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([prefix, uri]) => (prefix ? ` xmlns:${prefix}="${escapeAttr(uri)}"` : ` xmlns="${escapeAttr(uri)}"`))
    .join('');
  const attrs = Object.entries(node.attrs ?? {})
    .filter((e): e is [string, string] => e[1] !== undefined && e[1] !== null)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => ` ${k}="${escapeAttr(cleanText(v))}"`)
    .join('');
  const inner = (node.children ?? []).map(serialize).join('');
  return `<${node.name}${nsDecls}${attrs}>${inner}</${node.name}>`;
}

export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';

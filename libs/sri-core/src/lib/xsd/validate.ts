import { validateXML } from 'xmllint-wasm';
import { XSD_FILES } from './bundle.generated';

export interface XsdValidationResult {
  valid: boolean;
  errors: string[];
}

const SCHEMAS: Record<string, string> = {
  'factura:1.1.0': 'factura_V1.1.0.xsd',
  'factura:2.1.0': 'factura_V2.1.0.xsd',
};

export function supportedSchemas(): string[] {
  return Object.keys(SCHEMAS);
}

/**
 * Valida un comprobante contra el XSD oficial (libs/sri-core/xsd) antes de firmarlo.
 * Usa libxml2 compilado a WebAssembly: igual en servidor y en la caja de escritorio.
 */
export async function validateAgainstXsd(xml: string, docName: string, version: string): Promise<XsdValidationResult> {
  const file = SCHEMAS[`${docName}:${version}`];
  if (!file) return { valid: false, errors: [`No hay XSD para ${docName} versión ${version}`] };
  const result = await validateXML({
    xml: [{ fileName: 'comprobante.xml', contents: xml }],
    schema: [{ fileName: file, contents: XSD_FILES[file] }],
    preload: [{ fileName: 'xmldsig-core-schema.xsd', contents: XSD_FILES['xmldsig-core-schema.xsd'] }],
  });
  return {
    valid: result.valid,
    errors: result.errors.map((e) => e.message.replace(/^comprobante\.xml:\d+: /, '').trim()),
  };
}

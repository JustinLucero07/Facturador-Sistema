import { decryptSecret, PrismaClient, withContext } from '@vektra/db';
import { parseCreditNoteXml, parseInvoiceXml, parseWithholdingXml, renderCreditNoteRide, renderInvoiceRide, renderWithholdingRide } from '@vektra/sri-core';
import { createTransport, Transporter } from 'nodemailer';
import { EInvoiceError } from './errors';

/** RIDE en PDF generado desde el XML firmado/autorizado (coincide con lo que recibió el SRI). */
export async function renderRide(prisma: PrismaClient, tenantId: string, documentId: string): Promise<{ pdf: Buffer; fileName: string }> {
  const data = await withContext(prisma, { tenantId }, async (tx) => {
    const edoc = await tx.electronicDocument.findUnique({ where: { documentId } });
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
    return { edoc, tenant };
  });
  if (!data.edoc) throw new EInvoiceError('Comprobante no encontrado');
  const xml = data.edoc.authorizedXml ?? data.edoc.signedXml;
  if (!xml) throw new EInvoiceError('El comprobante aún no tiene XML');
  const [rates, payments] = await Promise.all([
    prisma.taxRate.findMany({ where: { taxCode: '2' } }),
    prisma.sriCatalog.findMany({ where: { catalog: 'payment_method' } }),
  ]);
  const branding = (data.tenant?.branding ?? {}) as { logoBase64?: string; color?: string };
  const opts = {
    authorizationDate: data.edoc.authorizedAt?.toISOString() ?? null,
    rateLabels: Object.fromEntries(rates.map((r) => [r.percentageCode, r.label])),
    paymentLabels: Object.fromEntries(payments.map((p) => [p.code, p.description])),
    logo: branding.logoBase64 ? Buffer.from(branding.logoBase64, 'base64') : null,
    brandColor: branding.color,
  };
  if (data.edoc.docType === '07') {
    const w = parseWithholdingXml(xml);
    return { pdf: await renderWithholdingRide(w, opts), fileName: `RIDE-RET-${w.establishment}-${w.emissionPoint}-${w.sequential}.pdf` };
  }
  if (data.edoc.docType === '04') {
    const nc = parseCreditNoteXml(xml);
    return { pdf: await renderCreditNoteRide(nc, opts), fileName: `RIDE-NC-${nc.establishment}-${nc.emissionPoint}-${nc.sequential}.pdf` };
  }
  const doc = parseInvoiceXml(xml);
  return { pdf: await renderInvoiceRide(doc, opts), fileName: `RIDE-${doc.establishment}-${doc.emissionPoint}-${doc.sequential}.pdf` };
}

export interface MailConfigPlain {
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  passwordEnc: string | null;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
}

export function buildTransport(cfg: MailConfigPlain, masterKey: string): Transporter {
  return createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.username ? { user: cfg.username, pass: cfg.passwordEnc ? decryptSecret(cfg.passwordEnc, masterKey) : '' } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
  });
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

/**
 * Envía al cliente el XML autorizado + RIDE usando el SMTP propio de la empresa.
 * Devuelve 'SKIPPED' si no corresponde (sin correo, consumidor final o sin SMTP configurado).
 */
export async function emailDocument(
  prisma: PrismaClient,
  tenantId: string,
  documentId: string,
  opts: { masterKey: string; overrideEmail?: string; transportFactory?: (cfg: MailConfigPlain) => Transporter },
): Promise<'SENT' | 'SKIPPED'> {
  const data = await withContext(prisma, { tenantId }, async (tx) => ({
    edoc: await tx.electronicDocument.findUnique({ where: { documentId }, include: { document: true } }),
    mail: await tx.mailConfig.findUnique({ where: { tenantId } }),
    tenant: await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
  }));
  const { edoc, mail, tenant } = data;
  if (!edoc) throw new EInvoiceError('Comprobante no encontrado');
  if (edoc.status !== 'AUTHORIZED' || !edoc.authorizedXml) throw new EInvoiceError('Solo se envían por correo comprobantes autorizados');

  // Consumidor final: solo si se pidió explícitamente (correo guardado desde la caja).
  const to = opts.overrideEmail ?? edoc.document.buyerEmail;
  const setStatus = (emailStatus: 'SENT' | 'FAILED' | 'SKIPPED', emailError: string | null) =>
    withContext(prisma, { tenantId }, (tx) =>
      tx.electronicDocument.update({ where: { documentId }, data: { emailStatus, emailError, ...(emailStatus === 'SENT' ? { emailSentAt: new Date() } : {}) } }),
    );

  if (!to) {
    await setStatus('SKIPPED', edoc.docType === '07' ? 'El proveedor no tiene correo electrónico' : 'El cliente no tiene correo electrónico');
    return 'SKIPPED';
  }
  if (!mail || !mail.enabled) {
    await setStatus('SKIPPED', 'La empresa no tiene configurado el correo de salida (SMTP)');
    return 'SKIPPED';
  }

  const { pdf, fileName } = await renderRide(prisma, tenantId, documentId);
  const number = fileName.replace(/^RIDE-(NC-|RET-)?|\.pdf$/g, '');
  const kind = edoc.docType === '04' ? 'nota de crédito electrónica' : edoc.docType === '07' ? 'comprobante de retención electrónico' : 'factura electrónica';
  const Kind = kind.charAt(0).toUpperCase() + kind.slice(1);
  const company = tenant.tradeName ?? tenant.legalName;
  const transport = opts.transportFactory ? opts.transportFactory(mail) : buildTransport(mail, opts.masterKey);
  try {
    await transport.sendMail({
      from: { name: mail.fromName, address: mail.fromEmail },
      replyTo: mail.replyTo ?? undefined,
      to,
      subject: `${Kind} ${number} — ${company}`,
      text: `Estimado(a) ${edoc.document.buyerName}:\n\nAdjuntamos su ${kind} ${number} por $${edoc.document.total.toFixed(2)}.\nClave de acceso: ${edoc.accessKey}\n\nPuede verificar su validez en www.sri.gob.ec.\n\n${company}`,
      html: `<p>Estimado(a) ${escapeHtml(edoc.document.buyerName)}:</p><p>Adjuntamos su <strong>${kind} ${number}</strong> por <strong>$${edoc.document.total.toFixed(2)}</strong>.</p><p>Clave de acceso:<br><code>${edoc.accessKey}</code></p><p>Puede verificar su validez en <a href="https://www.sri.gob.ec">www.sri.gob.ec</a>.</p><p>${escapeHtml(company)}</p>`,
      attachments: [
        { filename: `${edoc.accessKey}.xml`, content: edoc.authorizedXml, contentType: 'application/xml' },
        { filename: fileName, content: pdf, contentType: 'application/pdf' },
      ],
    });
  } catch (e) {
    await setStatus('FAILED', (e as Error).message.slice(0, 500));
    throw e;
  }
  await setStatus('SENT', null);
  return 'SENT';
}

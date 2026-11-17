// GENERADO por tools/ats-catalog.mjs — no editar a mano.
// Fuente: Catálogo ATS del SRI (docs/sri/Catalogo_ATS.xls), Tabla 3.10 "Conceptos de retención en la fuente
// de impuesto a la renta", DESDE 06/AGOSTO/2026. Los conceptos con porcentaje variable ("12 o 14", "varios porcentajes")
// quedan sin porcentaje: se ingresa al retener según la normativa (percentageNote = texto oficial).
export const RENTA_VALID_FROM = '2026-08-06';
export const RENTA_CONCEPTS: { code: string; description: string; percentage: string | null; percentageNote: string | null; residence: 'RESIDENT' | 'NON_RESIDENT' }[] = [
  {
    "code": "303",
    "description": "Honorarios profesionales y demás pagos por servicios relacionados con el título profesional",
    "percentage": "10",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "303A",
    "description": "Servicios profesionales prestados por sociedades residentes",
    "percentage": "5",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "304",
    "description": "Servicios predomina el intelecto no relacionados con el título profesional",
    "percentage": "10",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "304A",
    "description": "Comisiones y demás pagos por servicios predomina intelecto no relacionados con el título profesional",
    "percentage": "10",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "304B",
    "description": "Pagos a notarios y registradores de la propiedad y mercantil por sus actividades ejercidas como tales",
    "percentage": "10",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "304C",
    "description": "Pagos a deportistas, entrenadores, árbitros, miembros del cuerpo técnico por sus actividades ejercidas como tales",
    "percentage": "10",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "304D",
    "description": "Pagos a artistas por sus actividades ejercidas como tales",
    "percentage": "10",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "304E",
    "description": "Honorarios y demás pagos por servicios de docencia",
    "percentage": "10",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "307",
    "description": "Servicios predomina la mano de obra",
    "percentage": "3",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "308",
    "description": "Utilización o aprovechamiento de la imagen o renombre (personas naturales, sociedades,\" influencers\")",
    "percentage": "10",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "309",
    "description": "Servicios prestados por medios de comunicación y agencias de publicidad",
    "percentage": "3",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "310",
    "description": "Servicio de transporte privado de pasajeros o transporte público o privado de carga",
    "percentage": null,
    "percentageNote": "1 /0 según resolución NAC-DGERCGC26-00000028",
    "residence": "RESIDENT"
  },
  {
    "code": "311",
    "description": "Pagos a través de liquidación de compra (nivel cultural o rusticidad)",
    "percentage": "3",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "312",
    "description": "Transferencia de bienes muebles de naturaleza corporal",
    "percentage": "2",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "312A",
    "description": "COMPRAS AL PRODUCTOR: de bienes de origen bioacuático, forestal y los descritos el art.27.1 de LRTI",
    "percentage": "1",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "312C",
    "description": "COMPRAS AL COMERCIALIZADOR: de bienes de origen bioacuático, forestal y los descritos el art.27.1 de LRTI",
    "percentage": "1.75",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "314A",
    "description": "Regalías por concepto de franquicias de acuerdo al Código INGENIOS (COESCCI) - pago a personas naturales",
    "percentage": "10",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "314B",
    "description": "Cánones, derechos de autor, marcas, patentes y similares de acuerdo al Código INGENIOS (COESCCI) – pago a personas naturales",
    "percentage": "10",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "314C",
    "description": "Regalías por concepto de franquicias de acuerdo al Código INGENIOS (COESCCI) - pago a sociades",
    "percentage": "10",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "314D",
    "description": "Cánones, derechos de autor, marcas, patentes y similares de acuerdo al Código INGENIOS (COESCCI)",
    "percentage": "10",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "319",
    "description": "Cuotas de arrendamiento mercantil (prestado por sociedades), inclusive la de opción de compra",
    "percentage": "2",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "320",
    "description": "Arrendamiento bienes inmuebles",
    "percentage": "10",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "322",
    "description": "Seguros y reaseguros (primas y cesiones)",
    "percentage": "2",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "323",
    "description": "Rendimientos financieros pagados a naturales y sociedades (No a IFIs)",
    "percentage": "3",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "323A",
    "description": "Rendimientos financieros depósitos Cta. Corriente",
    "percentage": "3",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "323B1",
    "description": "Rendimientos financieros depósitos Cta. Ahorros Sociedades",
    "percentage": "3",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "323E",
    "description": "Rendimientos financieros depósito a plazo fijo gravados",
    "percentage": "3",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "323E2",
    "description": "Rendimientos financieros depósito a plazo fijo exentos",
    "percentage": "0",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "323F",
    "description": "Rendimientos financieros operaciones de reporto - repos",
    "percentage": "3",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "323G",
    "description": "Inversiones (captaciones) rendimientos distintos de aquellos pagados a IFIs",
    "percentage": "3",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "323H",
    "description": "Rendimientos financieros obligaciones",
    "percentage": "3",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "323I",
    "description": "Rendimientos financieros bonos convertible en acciones",
    "percentage": "3",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "323M",
    "description": "Rendimientos financieros : Inversiones en títulos valores en renta fija gravados",
    "percentage": "3",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "323N",
    "description": "Rendimientos financieros Inversiones en títulos valores en renta fija exentos",
    "percentage": "0",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "323O",
    "description": "Intereses y demás rendimientos financieros pagados a bancos y otras entidades sometidas al control de la Superintendencia de Bancos y de la Economía Popular y Solidaria",
    "percentage": "0",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "323P",
    "description": "Intereses pagados por entidades del sector público a favor de sujetos pasivos",
    "percentage": "3",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "323Q",
    "description": "Otros intereses y rendimientos financieros gravados",
    "percentage": "3",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "323R",
    "description": "Otros intereses y rendimientos financieros exentos",
    "percentage": "0",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "323S",
    "description": "Pagos y créditos en cuenta efectuados por el BCE y los depósitos centralizados de valores, en calidad de intermediarios, a instituciones del sistema financiero por cuenta de otras personas naturales y sociedades",
    "percentage": "3",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "323T",
    "description": "Rendimientos financieros originados en la deuda pública ecuatoriana",
    "percentage": "0",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "323U",
    "description": "Rendimientos financieros originados en títulos valores de obligaciones de 360 días o más para el financiamiento de proyectos públicos en asociación público-privada",
    "percentage": "0",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "324A",
    "description": "Intereses en operaciones de crédito entre instituciones del sistema financiero y entidades economía popular y solidaria.",
    "percentage": "2",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "324B",
    "description": "Inversiones entre instituciones del sistema financiero y entidades economía popular y solidaria",
    "percentage": "2",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "324C",
    "description": "Pagos y créditos en cuenta efectuados por el BCE y los depósitos centralizados de valores, en calidad de intermediarios, a instituciones del sistema financiero por cuenta de otras instituciones del sistema financiero",
    "percentage": "2",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "325",
    "description": "Anticipo dividendos",
    "percentage": "25",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "325A",
    "description": "Préstamos accionistas, beneficiarios o partícipes residentes o establecidos en el Ecuador",
    "percentage": "25",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "3250",
    "description": "Dividendos exentos (por no llegar a franja exenta o beneficio de otras leyes)",
    "percentage": "0",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "326",
    "description": "Dividendos distribuidos que correspondan al impuesto a la renta único establecido en el art. 27 de la LRTI",
    "percentage": null,
    "percentageNote": "12 o 14",
    "residence": "RESIDENT"
  },
  {
    "code": "327",
    "description": "Dividendos distribuidos a personas naturales residentes",
    "percentage": null,
    "percentageNote": "12 o 14",
    "residence": "RESIDENT"
  },
  {
    "code": "328",
    "description": "Dividendos distribuidos a sociedades residentes",
    "percentage": "0",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "329",
    "description": "Dividendos distribuidos a fideicomisos residentes",
    "percentage": "0",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "331",
    "description": "Dividendos en acciones (capitalización de utilidades)",
    "percentage": "0",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "332",
    "description": "Otras compras de bienes y servicios no sujetas a retención (incluye régimen RIMPE - Negocios Populares, para este caso aplica con cualquier forma de pago inclusive los pagos que deban realizar las tarjetas de crédito/débito)",
    "percentage": "0",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "332B",
    "description": "Compra de bienes inmuebles",
    "percentage": "0",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "332C",
    "description": "Transporte público de pasajeros",
    "percentage": "0",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "332D",
    "description": "Pagos en el país por transporte de pasajeros o transporte internacional de carga, a compañías nacionales o extranjeras de aviación o marítimas",
    "percentage": "0",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "332E",
    "description": "Valores entregados por las cooperativas de transporte a sus socios",
    "percentage": null,
    "percentageNote": "0 /1 según resolución NAC-DGERCGC26-00000028",
    "residence": "RESIDENT"
  },
  {
    "code": "332F",
    "description": "Compraventa de divisas distintas al dólar de los Estados Unidos de América",
    "percentage": "0",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "332G",
    "description": "Pagos con tarjeta de crédito",
    "percentage": "0",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "332H",
    "description": "Pago al exterior tarjeta de crédito reportada por la Emisora de tarjeta de crédito, solo recap",
    "percentage": "0",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "332I",
    "description": "Pago a través de convenio de debito (Clientes IFI`s)",
    "percentage": "0",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "333",
    "description": "Ganancia en la enajenación de derechos representativos de capital u otros derechos que permitan la exploración, explotación, concesión o similares de sociedades, que se coticen en bolsa de valores del Ecuador",
    "percentage": "10",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "334",
    "description": "Contraprestación producida por la enajenación de derechos representativos de capital u otros derechos que permitan la exploración, explotación, concesión o similares de sociedades, no cotizados en bolsa de valores del Ecuador",
    "percentage": "2",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "335",
    "description": "Loterías, rifas, pronósticos deportivos, apuestas y similares",
    "percentage": "15",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "336",
    "description": "Venta de combustibles a comercializadoras",
    "percentage": null,
    "percentageNote": "2/mil",
    "residence": "RESIDENT"
  },
  {
    "code": "337",
    "description": "Venta de combustibles a distribuidores",
    "percentage": null,
    "percentageNote": "3/mil",
    "residence": "RESIDENT"
  },
  {
    "code": "338",
    "description": "Producción y venta local de banano producido o no por el mismo sujeto pasivo",
    "percentage": null,
    "percentageNote": "1 a 2",
    "residence": "RESIDENT"
  },
  {
    "code": "340",
    "description": "Impuesto único a la exportación de banano",
    "percentage": "3",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "343",
    "description": "Otras retenciones aplicables el 1% (incluye régimen RIMPE - Emprendedores, para este caso aplica con cualquier forma de pago inclusive los pagos que deban realizar las tarjetas de crédito/débito)",
    "percentage": "1",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "343A",
    "description": "Energía eléctrica",
    "percentage": "2",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "343B",
    "description": "Actividades de construcción de obra material inmueble, urbanización, lotización o actividades similares",
    "percentage": "2",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "343C",
    "description": "Recepción de botellas plásticas no retornables de PET",
    "percentage": "2",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "3440",
    "description": "Otras retenciones aplicables el 3% (incluye pago utilidades a extrabajadores)",
    "percentage": "3",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "344A",
    "description": "Pago local tarjeta de crédito /débito reportada por la Emisora de tarjeta de crédito / entidades del sistema financiero/sistemas auxiliares de pago",
    "percentage": "2",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "344B",
    "description": "Adquisición de sustancias minerales dentro del territorio nacional",
    "percentage": "2",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "346",
    "description": "Otras retenciones aplicables a otros porcentajes",
    "percentage": null,
    "percentageNote": "varios porcentajes",
    "residence": "RESIDENT"
  },
  {
    "code": "346A",
    "description": "Otras ganancias de capital distintas de enajenación de derechos representativos de capital",
    "percentage": null,
    "percentageNote": "varios porcentajes",
    "residence": "RESIDENT"
  },
  {
    "code": "346B",
    "description": "Donaciones en dinero -Impuesto a las donaciones",
    "percentage": null,
    "percentageNote": "Conforme Art 36 LRTI literal d)",
    "residence": "RESIDENT"
  },
  {
    "code": "346C",
    "description": "Retención a cargo del propio sujeto pasivo por la producción y/o comercialización de minerales y otros bienes",
    "percentage": null,
    "percentageNote": "0 a 10 (NAC-DGERCGC16-00000217 y sus reformas)",
    "residence": "RESIDENT"
  },
  {
    "code": "346D",
    "description": "Retención a cargo del propio sujeto pasivo por la comercialización de productos forestales",
    "percentage": null,
    "percentageNote": "0 o 10",
    "residence": "RESIDENT"
  },
  {
    "code": "350",
    "description": "Otras autorretenciones (inciso 1 y 2 Art.92.1 RLRTI)",
    "percentage": null,
    "percentageNote": "1,50 o 1,75",
    "residence": "RESIDENT"
  },
  {
    "code": "3480",
    "description": "Impuesto a la renta único sobre los ingresos percibidos por los operadores de pronósticos deportivos",
    "percentage": "15",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "3481",
    "description": "Autorretenciones Sociedades Grandes Contribuyentes",
    "percentage": null,
    "percentageNote": "varios porcentajes (Conforme RESOLUCIÓN No. NAC-DGERCGC24-00000024 y sus reformas)",
    "residence": "RESIDENT"
  },
  {
    "code": "3482",
    "description": "Comisiones a sociedades, nacionales o extranjeras residentes y establecimientos permanentes domiciliados en el país",
    "percentage": "5",
    "percentageNote": null,
    "residence": "RESIDENT"
  },
  {
    "code": "500",
    "description": "Pago a no residentes - Rentas Inmobiliarias",
    "percentage": null,
    "percentageNote": "25 o 37",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "501",
    "description": "Pago a no residentes - Beneficios/Servicios Empresariales",
    "percentage": null,
    "percentageNote": "25 o 37",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "501A",
    "description": "Pago a no residentes - Servicios técnicos, administrativos o de consultoría y regalías",
    "percentage": null,
    "percentageNote": "3, 5, 8, 10, 15, 25, 37 (Las tarifas 3 y 8 solo en pagos de Regalías bajo el CDI con China)",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "503",
    "description": "Pago a no residentes- Navegación Marítima y/o aérea",
    "percentage": null,
    "percentageNote": "0 o 25 o 37",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "504",
    "description": "Pago a no residentes- Dividendos distribuidos a personas naturales (domiciliados o no en paraíso fiscal) o a sociedades sin beneficiario efectivo persona natural residente en Ecuador",
    "percentage": null,
    "percentageNote": "3, 5, 8, 10 (5 es por la tarifa de CDI Las tarifas 3 y 8 aplica únicamente bajo el CDI con China)",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "504A",
    "description": "Dividendos a sociedades con beneficiario efectivo persona natural residente en el Ecuador",
    "percentage": null,
    "percentageNote": "3, 5, 8, 10, 12 (5 y 10 es por la tarifa de CDI. Las tarifas 3 y 8 aplica únicamente bajo el CDI con China",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "504B",
    "description": "Dividendos a no residentes incumpliendo el deber de informar la composición societaria",
    "percentage": null,
    "percentageNote": "3, 5, 8, 10, 14 (5 y 10 es por la tarifa de CDI. Las tarifas 3 y 8 aplica únicamente bajo el CDI con China",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "504C",
    "description": "Dividendos a residentes o establecidos en paraísos fiscales o regímenes de menor imposición (con beneficiario Persona Natural residente en Ecuador)",
    "percentage": null,
    "percentageNote": "3, 5, 8, 10, 14 (5 y 10 es por la tarifa de CDI. Las tarifas 3 y 8 aplica únicamente bajo el CDI con China",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "504D",
    "description": "Dividendos a fideicomisos o establecidos en paraísos fiscales o regímenes de menor imposición (con beneficiario Persona Natural residente en Ecuador)",
    "percentage": null,
    "percentageNote": "3, 5, 8, 10, 14 (5 y 10 es por la tarifa de CDI. Las tarifas 3 y 8 aplica únicamente bajo el CDI con China",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "504E",
    "description": "Pago a no residentes - Anticipo dividendos (no domiciliada en paraísos fiscales o regímenes de menor imposición)",
    "percentage": "25",
    "percentageNote": null,
    "residence": "NON_RESIDENT"
  },
  {
    "code": "504F",
    "description": "Pago a no residentes - Anticipo dividendos (domiciliadas en paraísos fiscales o regímenes de menor imposición)",
    "percentage": "25",
    "percentageNote": null,
    "residence": "NON_RESIDENT"
  },
  {
    "code": "504G",
    "description": "Pago a no residentes - Préstamos accionistas, beneficiarios o partícipes (no domiciliadas en paraísos fiscales o regímenes de menor imposición)",
    "percentage": "25",
    "percentageNote": null,
    "residence": "NON_RESIDENT"
  },
  {
    "code": "504H",
    "description": "Pago a no residentes - Préstamos accionistas, beneficiarios o partícipes (domiciliadas en paraísos fiscales o regímenes de menor imposición)",
    "percentage": "25",
    "percentageNote": null,
    "residence": "NON_RESIDENT"
  },
  {
    "code": "504I",
    "description": "Pago a no residentes - Préstamos no comerciales a partes relacionadas (no domiciliadas en paraísos fiscales o regímenes de menor imposición)",
    "percentage": "25",
    "percentageNote": null,
    "residence": "NON_RESIDENT"
  },
  {
    "code": "504J",
    "description": "Pago a no residentes - Préstamos no comerciales a partes relacionadas (domiciliadas en paraísos fiscales o regímenes de menor imposición)",
    "percentage": "25",
    "percentageNote": null,
    "residence": "NON_RESIDENT"
  },
  {
    "code": "505",
    "description": "Pago a no residentes - Rendimientos financieros",
    "percentage": null,
    "percentageNote": "3,5,8,10,15,25 (5, 10 y 15 es por la tarifa de CDI Las tarifas 3 y 8 aplica únicamente bajo el CDI con China)",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "505A",
    "description": "Pago a no residentes – Intereses de créditos de Instituciones Financieras del exterior",
    "percentage": null,
    "percentageNote": "0, 3,5,8,10,15,25 (5, 10 y 15 es por la tarifa de CDI Las tarifas 3 y 8 aplica únicamente bajo el CDI con China; 0 o 25 art.13 LRTI)",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "505B",
    "description": "Pago a no residentes – Intereses de créditos de gobierno a gobierno",
    "percentage": null,
    "percentageNote": "0, 3,5,8,10,15,25 (5, 10 y 15 es por la tarifa de CDI Las tarifas 3 y 8 aplica únicamente bajo el CDI con China; 0 o 25 art.13 LRTI)",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "505C",
    "description": "Pago a no residentes – Intereses de créditos de organismos multilaterales",
    "percentage": null,
    "percentageNote": "0, 3,5,8,10,15,25 (5, 10 y 15 es por la tarifa de CDI Las tarifas 3 y 8 aplica únicamente bajo el CDI con China; 0 o 25 art.13 LRTI)",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "505D",
    "description": "Pago a no residentes - Intereses por financiamiento de proveedores externos",
    "percentage": null,
    "percentageNote": "3,5,8,10,15,25 (5, 10 y 15 es por la tarifa de CDI Las tarifas 3 y 8 aplica únicamente bajo el CDI con China)",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "505E",
    "description": "Pago a no residentes - Intereses de otros créditos externos",
    "percentage": null,
    "percentageNote": "3,5,8,10,15,25 (5, 10 y 15 es por la tarifa de CDI Las tarifas 3 y 8 aplica únicamente bajo el CDI con China)",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "505F",
    "description": "Pago a no residentes - Otros Intereses y Rendimientos Financieros",
    "percentage": null,
    "percentageNote": "3,5,8,10,15,25 (5, 10 y 15 es por la tarifa de CDI Las tarifas 3 y 8 aplica únicamente bajo el CDI con China)",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "509",
    "description": "Pago a no residentes- Cánones, derechos de autor, marcas, patentes y similares",
    "percentage": null,
    "percentageNote": "3,5,8,10,15,25,37 (5, 10 y 15 es por la tarifa de CDI Las tarifas 3 y 8 aplica únicamente bajo el CDI con China)",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "509A",
    "description": "Pago a no residentes - Regalías por concepto de franquicias",
    "percentage": null,
    "percentageNote": "3,5,8,10,15,25,37 (5, 10 y 15 es por la tarifa de CDI Las tarifas 3 y 8 aplica únicamente bajo el CDI con China)",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "510",
    "description": "Pago a no residentes - Otras ganancias de capital distintas de enajenación de derechos representativos de capital",
    "percentage": null,
    "percentageNote": "0, 25, 37",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "511",
    "description": "Pago a no residentes - Servicios profesionales independientes",
    "percentage": null,
    "percentageNote": "0, 25, 37",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "512",
    "description": "Pago a no residentes - Servicios profesionales dependientes",
    "percentage": null,
    "percentageNote": "0, 25, 37",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "513A",
    "description": "Pago a no residentes - Deportistas",
    "percentage": null,
    "percentageNote": "0, 25, 37",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "514",
    "description": "Pago a no residentes - Participación de consejeros",
    "percentage": null,
    "percentageNote": "25 o 37",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "515",
    "description": "Pago a no residentes- Artistas y relacionados a organización, producción y espectáculos artísticos y culturales en Ecuador",
    "percentage": null,
    "percentageNote": "15, 25, 37; según Art. 39.3 LRTI y la Resolución NAC-DGERCGC24-00000008",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "516",
    "description": "Pago a no residentes - Pensiones",
    "percentage": null,
    "percentageNote": "0, 25, 37 (0 por casuística de CDI)",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "517",
    "description": "Pago a no residentes- Reembolso de Gastos",
    "percentage": null,
    "percentageNote": "0 al 37",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "518",
    "description": "Pago a no residentes- Funciones Públicas",
    "percentage": null,
    "percentageNote": "0, 25, 37 (0 por casuística de CDI)",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "519",
    "description": "Pago a no residentes - Estudiantes",
    "percentage": null,
    "percentageNote": "25 o 37",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "520A",
    "description": "Pago a no residentes - Pago a proveedores de servicios hoteleros y turísticos en el exterior",
    "percentage": null,
    "percentageNote": "25 o 37",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "520B",
    "description": "Pago a no residentes - Arrendamientos mercantil internacional",
    "percentage": null,
    "percentageNote": "0, 25, 37",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "520D",
    "description": "Pago a no residentes - Comisiones por exportaciones y por promoción de turismo receptivo",
    "percentage": null,
    "percentageNote": "0, 25, 37",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "520E",
    "description": "Pago a no residentes - Por las empresas de transporte marítimo o aéreo y por empresas pesqueras de alta mar, por su actividad.",
    "percentage": "0",
    "percentageNote": null,
    "residence": "NON_RESIDENT"
  },
  {
    "code": "520F",
    "description": "Pago a no residentes - Por las agencias internacionales de prensa",
    "percentage": null,
    "percentageNote": "0, 25, 37",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "520G",
    "description": "Pago a no residentes - Contratos de fletamento de naves para empresas de transporte aéreo o marítimo internacional",
    "percentage": null,
    "percentageNote": "0, 25, 37",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "521",
    "description": "Pago a no residentes - Enajenación de derechos representativos de capital u otros derechos que permitan la exploración, explotación, concesión o similares de sociedades",
    "percentage": null,
    "percentageNote": "0, 10 (0 por casuística de CDI)",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "523A",
    "description": "Pago a no residentes - Seguros y reaseguros (primas y cesiones)",
    "percentage": null,
    "percentageNote": "0 ,25 ,37",
    "residence": "NON_RESIDENT"
  },
  {
    "code": "525",
    "description": "Pago a no residentes- Donaciones en dinero -Impuesto a las donaciones",
    "percentage": null,
    "percentageNote": "Según art 36 LRTI literal d)",
    "residence": "NON_RESIDENT"
  }
];

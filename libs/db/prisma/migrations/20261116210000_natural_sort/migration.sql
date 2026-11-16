-- Orden natural en español para listados ("Tornillo 2 mm" antes que "Tornillo 10 mm"; ñ y tildes bien ordenadas).
CREATE COLLATION IF NOT EXISTS es_natural (provider = icu, locale = 'es-u-kn-true');

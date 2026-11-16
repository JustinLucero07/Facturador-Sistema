// SRI simulado para pruebas manuales en desarrollo (NO usar en producción).
// Uso: tsx tools/fake-sri-dev.ts  → imprime las URLs para el parámetro ws.test
import { FakeSri } from '../apps/api/test/fake-sri';

const sri = new FakeSri();
sri.start().then(() => {
  console.log(JSON.stringify({ reception: sri.receptionUrl, authorization: sri.authorizationUrl }));
});

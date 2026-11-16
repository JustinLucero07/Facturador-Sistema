// bwip-js publica sus tipos solo vía "exports" con condiciones (node/electron/browser) que la
// resolución de TypeScript de este proyecto no selecciona; se reexportan los tipos de Node.
declare module 'bwip-js' {
  import BwipJs = require('bwip-js/dist/bwip-js-node');
  export = BwipJs;
}

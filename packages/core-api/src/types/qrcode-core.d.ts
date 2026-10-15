// The pure QR encoder inside `qrcode`, without the Node PNG/terminal renderers.
declare module 'qrcode/lib/core/qrcode.js' {
  export { create } from 'qrcode';
}

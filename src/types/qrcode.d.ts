declare module 'qrcode' {
  export interface QRCodeToDataURLOptions {
    color?: {
      dark?: string
      light?: string
    }
    errorCorrectionLevel?: 'H' | 'L' | 'M' | 'Q'
    margin?: number
    width?: number
  }

  export function toDataURL(text: string, options?: QRCodeToDataURLOptions): Promise<string>
  export function toString(text: string, options?: QRCodeToDataURLOptions): Promise<string>

  const QRCode: {
    toDataURL: typeof toDataURL
    toString: typeof toString
  }

  export default QRCode
}

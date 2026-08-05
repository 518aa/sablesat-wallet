declare module "qrcode-generator" {
  type ErrorCorrectionLevel = "L" | "M" | "Q" | "H";

  export default function qrcode(typeNumber: number, errorCorrectionLevel: ErrorCorrectionLevel): {
    addData(data: string): void;
    make(): void;
    getModuleCount(): number;
    isDark(row: number, col: number): boolean;
  };
}

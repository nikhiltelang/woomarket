// Minimal types for the part of fontkit we use (glyph coverage checks for PDF reports).
declare module "fontkit" {
  export interface Font {
    hasGlyphForCodePoint(codePoint: number): boolean;
  }
  export function openSync(path: string): Font;
}

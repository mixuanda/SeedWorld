declare module 'extract-zip' {
  interface ExtractZipOptions {
    dir: string;
  }

  function extractZip(zipPath: string, options: ExtractZipOptions): Promise<void>;

  export default extractZip;
}

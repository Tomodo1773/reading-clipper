/** Viteの`?raw`インポート。スキーマ定義をテストへ1箇所から取り込むために使う。 */
declare module '*.sql?raw' {
  const content: string;
  export default content;
}

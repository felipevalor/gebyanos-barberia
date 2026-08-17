/** Import de un .ts como texto, para tests que inspeccionan el fuente. */
declare module '*.ts?raw' {
  const contenido: string;
  export default contenido;
}

/** Import de SQL como texto via el transform `?raw` de Vite. */
declare module '*.sql?raw' {
  const contenido: string;
  export default contenido;
}

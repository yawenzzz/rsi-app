/** Build-owned stylesheet module declarations. */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

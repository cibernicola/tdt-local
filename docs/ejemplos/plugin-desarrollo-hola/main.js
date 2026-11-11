// Corre en el proceso principal de la aplicación (Node y Electron completos, sin límites).
// Exporta una función (por defecto, o `activate`) y, si quieres, `deactivate`. Recibe un objeto con:
//   id, log/warn/error, electron (el módulo entero), app, getWindow(), serverUrl, showWindow(), reload(), dataDir
// `dataDir` es una carpeta para tus propios archivos: la del plugin se vigila y, si escribes en ella, se recarga en bucle.
export default function activate(tdt) {
  tdt.log('hola desde el proceso principal; la ventana está en', tdt.serverUrl);
}

export function deactivate() {
  // aquí, deshacer lo que hiciera activate (cerrar ventanas, atajos, procesos...)
}

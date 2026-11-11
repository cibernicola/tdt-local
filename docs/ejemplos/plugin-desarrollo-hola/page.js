// Corre dentro de la página de TDT local, sin aislamiento: ve todo lo que ve la página.
// `tdt` lo pone la aplicación: tdt.id, tdt.log(...) y tdt.error(...) escriben en el Registro con el nombre del plugin, y trae los ganchos
// de la aplicación (tdt.on, tdt.filter, tdt.register; ver docs/HACKEABLE.md).
// El archivo se ejecuta dentro de una función `async`: puede llevar `await` al principio, pero no `import` estáticos
// (para eso, `await import('/js/state.js')`). Si termina con `return () => {...}`, esa función se llama al apagar el plugin.
const etiqueta = document.createElement('div');
etiqueta.textContent = 'Hola desde un plugin de desarrollo';
etiqueta.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:50;padding:2px 8px;border-radius:4px;background:#1f6f43;color:#fff;font:12px system-ui';
document.body.append(etiqueta);
tdt.log('etiqueta puesta en la página');

// Un ejemplo de gancho: avisar en el Registro cuando empiece una pausa de anuncios
tdt.on('ad.started', (anuncio) => tdt.log('pausa de anuncios en', anuncio.name, '(' + anuncio.seconds + ' s)'));

return () => etiqueta.remove();

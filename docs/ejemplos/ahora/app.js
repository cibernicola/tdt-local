// Ejemplo de plugin con permisos. `tdt` lo crea /@tdt/sdk.js; todo lo que hace es pedirle cosas a la aplicación,
// y la aplicación solo contesta a lo que el manifest declara y tú aprobaste al activarlo.
const $ = (id) => document.getElementById(id);
let estado = null;

function hora(ts) {
  return new Date(ts * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

async function pintar(nuevo) {
  estado = nuevo;
  const activa = estado.tiles.find((t) => t.slot === estado.focus) || estado.tiles[0];
  $('canal').textContent = activa ? activa.name : 'Nada en pantalla';
  $('silencio').setAttribute('aria-pressed', String(estado.vol.m));
  $('silencio').textContent = estado.vol.m ? 'Con sonido' : 'Silenciar';
  $('ahora').textContent = '';
  $('despues').textContent = '';
  if (!activa) return;
  try {
    const guia = await tdt.epg.now(activa.name);
    if (guia.now) $('ahora').textContent = `Ahora (${hora(guia.now.start)}–${hora(guia.now.end)}): ${guia.now.title}`;
    if (guia.next) $('despues').textContent = `Después (${hora(guia.next.start)}): ${guia.next.title}`;
    if (!guia.now && !guia.next) $('ahora').textContent = 'Sin guía para este canal';
  } catch (error) {
    $('ahora').textContent = error.message; // por ejemplo «no hay ningún canal…»
  }
}

async function volumen(delta) {
  const v = Math.max(0, Math.min(1, Math.round((estado.vol.v + delta) * 100) / 100));
  await tdt.player.volume(v);
}

(async () => {
  const yo = await tdt.ready;
  console.log('plugin', yo.id, 'listo con permisos:', yo.permissions.join(', '));
  await pintar(await tdt.player.state());
  tdt.on('player', pintar); // la aplicación avisa cuando cambia algo
  $('menos').addEventListener('click', () => volumen(-0.1).catch(console.error));
  $('mas').addEventListener('click', () => volumen(0.1).catch(console.error));
  $('silencio').addEventListener('click', () => tdt.player.mute(!estado.vol.m).catch(console.error));
  setInterval(() => estado && pintar(estado), 30_000); // el programa cambia aunque nada más lo haga

  // lo guardado es solo de este plugin y sigue ahí al cerrar la aplicación
  const veces = ((await tdt.storage.get('veces')) || 0) + 1;
  await tdt.storage.set('veces', veces);
  $('veces').textContent = `Abierto ${veces} ${veces === 1 ? 'vez' : 'veces'}`;
})().catch((error) => {
  $('canal').textContent = 'Error';
  $('ahora').textContent = error.message;
});
